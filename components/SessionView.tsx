'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '@/lib/client/audio';
import MicCheck from './MicCheck';
import PassageView, { type WordState } from './PassageView';
import TalkButton from './TalkButton';
import DebugPanel from './DebugPanel';
import type { Intent, Mode, ServerMessage, SessionPlan } from '@/lib/types';

const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ??
  (typeof window !== 'undefined'
    ? `ws://${window.location.hostname}:3001/session`
    : 'ws://localhost:3001/session');

export default function SessionView() {
  const [micReady, setMicReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState<Mode>('IDLE');
  const [narratorText, setNarratorText] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
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
  /** Bytes of TTS audio this browser actually received for the current utterance. */
  const [audioBytes, setAudioBytes] = useState(0);

  const engineRef = useRef<AudioEngine | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const gateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Caption updates waiting for the previous utterance to finish playing. */
  const captionTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * Apply a caption change only once the audio already queued has played out.
   *
   * A `speak` message arrives just *before* its own audio streams, so whatever is
   * still queued at that moment is precisely the tail of the previous utterance.
   * Delaying by that much keeps text and voice roughly together without needing
   * word-level timing.
   */
  const afterCurrentAudio = useCallback((fn: () => void) => {
    const delay = engineRef.current?.playbackRemainingMs() ?? 0;
    if (delay < 120) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      captionTimers.current = captionTimers.current.filter((t) => t !== timer);
      fn();
    }, delay);
    captionTimers.current.push(timer);
  }, []);

  /** Barge-in and teardown must not leave stale captions queued. */
  const flushCaptions = useCallback(() => {
    for (const t of captionTimers.current) clearTimeout(t);
    captionTimers.current = [];
  }, []);

  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.t) {
      case 'ready':
        setPlan(msg.plan);
        break;

      case 'mode':
        setMode(msg.mode);
        // The question is only on the table while the wrap-up is.
        if (msg.mode !== 'WRAP_UP') setAwaiting(null);
        break;

      case 'speak':
        // Hold the caption until the previous utterance has finished out loud.
        afterCurrentAudio(() => setNarratorText(msg.text));
        setTranscript((t) => [...t, { kind: 'narrator', text: msg.text }]);
        break;

      case 'passage':
        // The server sends this once it has finished *sending* audio, which is
        // before the browser has finished playing it. Same treatment.
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

      case 'tts_start':
        setSpeaking(true);
        setAudioBytes(0);
        // Keep capturing so the child can talk over Ollie. The server sends these
        // frames to the barge-in recognizer ONLY, and checks everything it hears
        // against the words being spoken before acting on it — so the "never
        // listen to ourselves" half of §8.2 still holds, it just holds on the
        // server instead of by going deaf.
        //
        // getUserMedia already has echoCancellation on (lib/client/audio.ts),
        // which is what makes this viable on laptop speakers.
        engineRef.current?.setMuted(msg.bargeIn === false);
        if (gateTimer.current) clearTimeout(gateTimer.current);
        break;

      case 'stop_playback':
        // A barge-in was accepted. Drop the queued tail and any caption waiting
        // on audio that will now never play.
        flushCaptions();
        engineRef.current?.stopPlayback();
        setSpeaking(false);
        break;

      case 'tts_end':
        setSpeaking(false);
        // The server sends this when it finishes *sending* audio, which is before
        // the browser has finished *playing* it. The barge-in recognizer is closed
        // by now, so anything captured during that tail would land in
        // pronunciation assessment as the child's reading — mute until the
        // speaker is genuinely quiet, then 300ms more.
        if (gateTimer.current) clearTimeout(gateTimer.current);
        engineRef.current?.setMuted(true);
        gateTimer.current = setTimeout(
          () => engineRef.current?.setMuted(false),
          (engineRef.current?.playbackRemainingMs() ?? 0) + 300,
        );
        break;

      case 'talk_open':
        setListening(true);
        break;

      case 'talk_closed':
        setListening(false);
        if (msg.transcript) {
          setLastIntent({ transcript: msg.transcript, intent: msg.intent });
          setTranscript((t) => [
            ...t,
            { kind: `child · ${msg.intent ?? 'unknown'}`, text: msg.transcript! },
          ]);
        }
        break;

      // The mic is open for a spoken reply — onboarding, or a check-in. Same
      // indicator as the talk button, since to the child it is the same thing.
      case 'listening':
        setListening(msg.on);
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
    // afterCurrentAudio is stable, but declare it: an empty dep array here is
    // exactly the stale-closure shape that silently broke audio once already.
  }, [afterCurrentAudio]);

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
    setMicReady(true);
    connect(engine);
  }

  const send = (msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function pressTalk() {
    // Barge-in: kill local playback the instant the button goes down, and drop
    // any caption still waiting on audio that will now never play.
    flushCaptions();
    engineRef.current?.stopPlayback();
    engineRef.current?.setMuted(false);
    setSpeaking(false);
    setListening(true);
    send({ t: 'talk_start' });
  }

  function releaseTalk() {
    if (!listening) return;
    setListening(false);
    send({ t: 'talk_end' });
  }

  /** Answering the check-in by tapping. Saying it out loud works too. */
  function answer(value: 'yes' | 'no') {
    setAwaiting(null);
    send({ t: 'answer', value });
  }

  useEffect(() => {
    return () => {
      if (gateTimer.current) clearTimeout(gateTimer.current);
      flushCaptions();
      wsRef.current?.close();
      void engineRef.current?.destroy();
    };
  }, [flushCaptions]);

  if (!micReady) return <MicCheck onReady={onMicReady} />;

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
              : speaking
                ? 'Ollie is speaking…'
                : ended
                  ? 'all done'
                  : listening
                    ? 'listening…'
                    : mode === 'CHILD_READS'
                      ? 'listening to you'
                      : mode === 'TALK'
                        ? 'listening…'
                        : mode === 'PAUSED'
                          ? 'paused'
                          : mode === 'ONBOARDING'
                            ? 'getting to know you'
                            : // NARRATE / COACH / SOCRATIC / REMIX / ADAPT between
                              // utterances all mean one thing: waiting on the LLM.
                              'Ollie is thinking…'}
          </div>
        </header>

        {error && (
          <div className="miccheck-error" style={{ marginBottom: 20 }}>
            <h3>Something went wrong</h3>
            <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{error}</p>
          </div>
        )}

        <div className={`narrator${speaking ? ' speaking' : ''}`}>
          <span className="owl-mini">🦉</span>
          <span>{narratorText || 'Getting your story ready…'}</span>
        </div>

        {mode === 'ONBOARDING' ? (
          <div>
            <div className="passage-label">Getting to know you</div>
            <p className="empty-passage">
              {listening ? 'Ollie is listening — just talk!' : 'Ollie is thinking…'}
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

        <TalkButton
          listening={listening}
          // During onboarding and check-ins the mic is already open, so the
          // button would only be a way to interrupt a question being asked.
          disabled={!connected || ended || mode === 'ONBOARDING' || awaiting !== null}
          onPress={pressTalk}
          onRelease={releaseTalk}
        />
      </main>

      <DebugPanel
        mode={mode}
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
