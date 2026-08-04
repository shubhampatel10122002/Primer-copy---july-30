'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '@/lib/client/audio';
import MicCheck from './MicCheck';
import MicButton, { micVisual } from './MicButton';
import PassageView, { type WordState } from './PassageView';
import DebugPanel from './DebugPanel';
import {
  VoiceMachine,
  initialSnapshot,
  type VoiceEffect,
  type VoiceSnapshot,
} from '@/lib/voice/machine';
import type { Intent, Mode, ServerMessage, SessionPlan } from '@/lib/types';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  (typeof window !== 'undefined'
    ? `ws://${window.location.hostname}:3001/session`
    : 'ws://localhost:3001/session');

/**
 * The session screen.
 *
 * The important thing about this component is what it does NOT decide. It does
 * not choose when the mic opens, whether a tap is a barge-in, or whether the
 * child has finished — it runs the same state machine the server runs
 * (`lib/voice/machine.ts`) and carries out the effects that come back.
 *
 * Running a second copy of the machine here is not duplication, it is the whole
 * latency story. A tap has to silence the voice in the same frame; a round trip
 * to a Node process and back is 30-80ms of Ollie still talking over a child who
 * has asked him to stop. So the browser applies the child's own events locally
 * — tap, playback drained, silence detected — and sends them up, while the
 * server applies its own and sends those down. Same reducer, same event
 * sequence, same state. `voice_sync` is the safety net, not the mechanism.
 */
export default function SessionView() {
  const [micReady, setMicReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<Mode>('IDLE');
  const [narratorText, setNarratorText] = useState('');
  const [voice, setVoice] = useState<VoiceSnapshot>(() => initialSnapshot('ONBOARDING'));
  const [words, setWords] = useState<WordState[]>([]);
  const [cursor, setCursor] = useState(0);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const [debug, setDebug] = useState<Record<string, unknown>>({});
  const [lastIntent, setLastIntent] = useState<{ transcript: string; intent: Intent | null } | null>(
    null,
  );
  const [transcript, setTranscript] = useState<{ kind: string; text: string }[]>([]);
  const [flags, setFlags] = useState<{ type: string; detail: string }[]>([]);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  /** Onboarding profile filling in live, and everything learned since. */
  const [profile, setProfile] = useState<{
    name: string | null;
    age: number | null;
    interests: string[];
  } | null>(null);
  const [facts, setFacts] = useState<{ text: string; topic: string; kind: string }[]>([]);
  const [awaiting, setAwaiting] = useState<'continue' | null>(null);
  /** Sound is reaching the mic right now. Cosmetic; it decides nothing. */
  const [hearing, setHearing] = useState(false);
  /**
   * Total TTS audio this browser has received, for the whole session.
   *
   * Cumulative, not per-utterance: resetting it on each new utterance meant the
   * panel compared the PREVIOUS one's sent-bytes against the NEXT one's
   * received-bytes-so-far, which is zero for a moment every single time, and
   * cried "audio not arriving" at a browser that was receiving audio perfectly.
   */
  const [audioBytes, setAudioBytes] = useState(0);

  const engineRef = useRef<AudioEngine | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const machineRef = useRef<VoiceMachine | null>(null);
  /** Caption updates waiting for the previous utterance to finish playing. */
  const captionTimers = useRef<{ timer: ReturnType<typeof setTimeout>; fn: () => void }[]>([]);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /**
   * Apply a caption change only once the audio already queued has played out.
   *
   * A new utterance's text arrives just *before* its own audio streams, so
   * whatever is still queued at that moment is precisely the tail of the
   * previous one. Delaying by that much keeps text and voice roughly together
   * without needing word-level timing.
   */
  const afterCurrentAudio = useCallback((fn: () => void) => {
    // Capped. If the queue is somehow long — a burst of audio, a stalled clock —
    // holding the passage back any further just leaves the child staring at an
    // empty screen, and text on screen early is far better than text that never
    // arrives.
    const delay = Math.min(engineRef.current?.playbackRemainingMs() ?? 0, 4_000);
    if (delay < 120) {
      fn();
      return;
    }
    const entry = {
      timer: setTimeout(() => {
        captionTimers.current = captionTimers.current.filter((e) => e !== entry);
        fn();
      }, delay),
      fn,
    };
    captionTimers.current.push(entry);
  }, []);

  /**
   * Clear the caption queue.
   *
   * `apply` is the difference between a barge-in and a teardown, and getting it
   * wrong loses the passage. Queued updates are waiting on audio that a barge-in
   * has just cancelled, so they will never fire on their own — but what they
   * carry is still true. The words the child is about to read are the words they
   * are about to read, whether or not Ollie finished announcing them. Dropping
   * them left a child looking at an empty screen with nothing to do about it.
   *
   * On unmount there is nothing left to show, so they are dropped.
   */
  const flushCaptions = useCallback((apply: boolean) => {
    const pending = captionTimers.current;
    captionTimers.current = [];
    for (const { timer, fn } of pending) {
      clearTimeout(timer);
      if (apply) fn();
    }
  }, []);

  // -------------------------------------------------------------------------
  // The local mirror of the state machine
  // -------------------------------------------------------------------------

  /**
   * Carry out one decision the machine has made, here in the browser.
   *
   * `cancel_tts` and `flush_playback` are the reason this exists. They run
   * synchronously inside the click handler, before a single byte goes to the
   * server, which is what puts barge-in-to-silence at one frame plus whatever
   * the audio device is already holding.
   */
  const applyEffect = useCallback(
    (effect: VoiceEffect) => {
      const engine = engineRef.current;
      switch (effect.t) {
        case 'open_mic':
          engine?.setCapturing(true);
          break;
        case 'close_mic':
          engine?.setCapturing(false);
          break;
        case 'arm_auto_close':
          engine?.armAutoClose(effect.turnId, effect.silenceMs);
          break;
        case 'disarm_auto_close':
          engine?.disarmAutoClose();
          break;
        case 'cancel_tts':
        case 'flush_playback':
          // Apply, do not drop: the audio is cancelled, the words are not.
          flushCaptions(true);
          engine?.stopPlayback();
          break;
        case 'start_tts':
          engine?.beginUtterance(effect.utteranceId);
          // The caption waits for the tail of the previous utterance; the audio
          // for this one is already on its way.
          afterCurrentAudio(() => setNarratorText(effect.text));
          setTranscript((t) => [...t, { kind: 'narrator', text: effect.text }]);
          break;
        // Server-side bookkeeping. Nothing for the browser to do.
        case 'arm_watchdog':
        case 'disarm_watchdog':
        case 'process_turn':
        case 'drop_turn':
          break;
      }
    },
    [afterCurrentAudio, flushCaptions],
  );

  if (machineRef.current === null && typeof window !== 'undefined') {
    machineRef.current = new VoiceMachine({
      mode: 'ONBOARDING',
      onEffect: (effect) => applyEffect(effect),
      onChange: (snapshot) => setVoice(snapshot),
      onViolation: (violations) =>
        console.error(`[voice] invariant broken in the browser: ${violations.join('; ')}`),
    });
  }

  /**
   * The tap. Everything the child can do, in one handler.
   *
   * Applied locally FIRST and unconditionally — the machine decides what a tap
   * means from the state it is in, so there is nothing to check here — and only
   * then reported. If the two ever disagree, `voice_sync` settles it in the
   * server's favour a few milliseconds later.
   */
  const onMicTap = useCallback(() => {
    machineRef.current?.send({ t: 'MIC_TAP' });
    send({ t: 'mic_tap' });
  }, [send]);

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.t) {
        case 'ready':
          setPlan(msg.plan);
          break;

        case 'mode':
          setMode(msg.mode);
          // The question is only on the table while the wrap-up is.
          if (msg.mode !== 'WRAP_UP') setAwaiting(null);
          break;

        // One event the browser could not have known about. Replayed through
        // the local machine so both sides stay on the same sequence.
        case 'voice_event':
          machineRef.current?.send(msg.event);
          break;

        // The authoritative snapshot. Normally identical to what we already
        // have; adopting it only matters when a message was lost.
        case 'voice_sync':
          if (machineRef.current?.adopt(msg.snapshot)) setVoice(msg.snapshot);
          break;

        case 'tts_complete':
          engineRef.current?.endUtteranceStream(msg.utteranceId);
          break;

        case 'passage':
          // Sent before the beat has finished playing. Same treatment as a
          // caption: hold it until the child has heard the sentence about it.
          afterCurrentAudio(() => {
            setWords(msg.words.map((w) => ({ word: w, status: 'pending', score: null })));
            setCursor(0);
          });
          setTranscript((t) => [...t, { kind: 'passage', text: msg.text }]);
          break;

        case 'word':
          setWords((ws) =>
            ws.map((w, i) => (i === msg.index ? { ...w, status: msg.status, score: msg.score } : w)),
          );
          break;

        case 'cursor':
          setCursor(msg.index);
          break;

        case 'talk_closed':
          if (msg.transcript) {
            setLastIntent({ transcript: msg.transcript, intent: msg.intent });
            setTranscript((t) => [
              ...t,
              { kind: `child · ${msg.intent ?? 'unknown'}`, text: msg.transcript! },
            ]);
          }
          break;

        case 'profile':
          setProfile({ name: msg.name, age: msg.age, interests: msg.interests });
          break;

        case 'fact':
          setFacts((f) => [...f, { text: msg.text, topic: msg.topic, kind: msg.kind }]);
          setTranscript((t) => [...t, { kind: 'remembered', text: msg.text }]);
          break;

        case 'awaiting_answer':
          setAwaiting(msg.question);
          break;

        case 'flag':
          setFlags((f) => [{ type: msg.type, detail: msg.detail }, ...f]);
          break;

        case 'debug':
          setDebug((d) => ({ ...d, [msg.key]: msg.value }));
          if (msg.key === 'plan') setPlan(msg.value as SessionPlan);
          break;

        case 'nudge':
          setTranscript((t) => [...t, { kind: 'nudge', text: msg.text }]);
          break;

        case 'error':
          setError(msg.message);
          break;

        case 'ended':
          setEnded(true);
          setMode('END');
          break;
      }
    },
    [afterCurrentAudio],
  );

  const connect = useCallback(
    (engine: AudioEngine) => {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        engine.onAudioFrame = (pcm) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcm);
        };
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          setAudioBytes((n) => n + (e.data as ArrayBuffer).byteLength);
          engine.playChunk(e.data);
          return;
        }
        try {
          handleServerMessage(JSON.parse(e.data) as ServerMessage);
        } catch {
          /* ignore malformed frame */
        }
      };

      ws.onclose = () => setConnected(false);
      ws.onerror = () =>
        setError('Could not reach the session server. Is `npm run ws` running on port 3001?');
    },
    [handleServerMessage],
  );

  function onMicReady(engine: AudioEngine) {
    engineRef.current = engine;

    // The two things only the browser can observe. Both go through the local
    // machine first and are reported afterwards.
    engine.onSpeaking = (on) => setHearing(on);
    engine.onSpeechEnd = (turnId) => {
      machineRef.current?.send({ t: 'SPEECH_END_DETECTED', turnId });
      send({ t: 'speech_end', turnId });
    };
    engine.onPlaybackDrained = (utteranceId) => {
      machineRef.current?.send({ t: 'AI_SPEECH_END', utteranceId });
      send({ t: 'playback_drained', utteranceId });
    };

    setMicReady(true);
    connect(engine);
  }

  /** Answering the check-in by tapping. Saying it out loud works too. */
  function answer(value: 'yes' | 'no') {
    setAwaiting(null);
    send({ t: 'answer', value });
  }

  useEffect(() => {
    return () => {
      flushCaptions(false);
      wsRef.current?.close();
      void engineRef.current?.destroy();
    };
  }, [flushCaptions]);

  if (!micReady) return <MicCheck onReady={onMicReady} />;

  const visual = micVisual(voice);

  return (
    <div className="shell">
      <main className="stage">
        <header className="header">
          <div className="logo">Primer</div>
          <div className="mode-pill" data-mode={mode}>
            {mode.replace('_', ' ')}
          </div>
          <div className="status-line">
            {!connected
              ? 'connecting…'
              : ended
                ? 'all done'
                : visual === 'speaking'
                  ? 'Ollie is speaking…'
                  : visual === 'live'
                    ? 'your turn'
                    : visual === 'thinking'
                      ? 'Ollie is thinking…'
                      : mode === 'PAUSED'
                        ? 'paused'
                        : mode === 'ONBOARDING'
                          ? 'getting to know you'
                          : 'waiting for you'}
          </div>
        </header>

        {error && (
          <div className="miccheck-error" style={{ marginBottom: 20 }}>
            <h3>Something went wrong</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error}</p>
          </div>
        )}

        <div className={`narrator${visual === 'speaking' ? ' speaking' : ''}`}>
          <span>{narratorText || 'Getting your story ready…'}</span>
        </div>

        {mode === 'ONBOARDING' ? (
          <div>
            <div className="passage-label">Getting to know you</div>
            <p className="empty-passage">
              {visual === 'live'
                ? 'Go on — I’m listening!'
                : visual === 'speaking'
                  ? 'Listen to Ollie…'
                  : 'Tap the owl and tell me!'}
            </p>
            {profile && (profile.name || profile.interests.length > 0) && (
              <div style={{ marginTop: 14 }}>
                {profile.name && <span className="chip added">{profile.name}</span>}
                {profile.age !== null && <span className="chip">{profile.age} years old</span>}
                {profile.interests.map((i) => (
                  <span className="chip" key={i}>
                    {i}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : awaiting === 'continue' ? (
          <div>
            <div className="passage-label">Keep reading?</div>
            <div className="choice-row">
              <button className="btn btn-primary" onClick={() => answer('yes')}>
                Yes, more story!
              </button>
              <button className="btn" onClick={() => answer('no')}>
                I&rsquo;m all done
              </button>
            </div>
            <p className="muted" style={{ marginTop: 12, fontSize: 14 }}>
              You can just say it out loud, too.
            </p>
          </div>
        ) : mode === 'PAUSED' ? (
          <div>
            <div className="passage-label">Paused</div>
            <p className="empty-passage">Ollie is waiting for you.</p>
            <button className="btn btn-primary" onClick={() => send({ t: 'resume' })}>
              I&rsquo;m back!
            </button>
          </div>
        ) : ended ? (
          <div>
            <div className="passage-label">All done</div>
            <p className="empty-passage">
              Great reading today! Hit <b>Consolidate memory</b> to see what Ollie learned.
            </p>
          </div>
        ) : (
          <>
            <div className="passage-label">Your turn to read</div>
            <PassageView words={words} cursor={cursor} />
          </>
        )}

        {/*
          One object: the thing that shows whose turn it is and the thing you
          press to take yours. See components/MicButton.tsx.
        */}
        <MicButton
          snapshot={voice}
          hearing={hearing}
          disabled={!connected || ended}
          onTap={onMicTap}
        />
      </main>

      <DebugPanel
        mode={mode}
        voice={voice}
        plan={plan}
        debug={debug}
        lastIntent={lastIntent}
        transcript={transcript}
        liveFlags={flags}
        audioBytes={audioBytes}
        facts={facts}
        onTtsTest={() => send({ t: 'tts_test' })}
        connected={connected}
      />
    </div>
  );
}
