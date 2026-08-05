'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Intent, Mode, SessionPlan } from '@/lib/types';
import type { VoiceSnapshot } from '@/lib/voice/machine';

/**
 * The visible loop IS the YC demo (PLAN.md §2.7). Live mode, last Azure result,
 * current plan, memory model, and the memory diff after consolidation.
 */

interface MemoryResponse {
  child: { name: string; age: number | null; onboarding_notes: string | null };
  memory: {
    interests: { topic: string; weight: number }[];
    personality_notes: string;
    canon: { characters?: string[]; open_threads?: string[]; past_summaries?: string[] };
    version: number;
  };
  mastery: { skill_id: string; p_mastery: number; label: string }[];
  flags: { type: string; detail: string; ts: string }[];
  stats: { sessions: number; events: number };
}

export default function DebugPanel({
  mode,
  voice,
  plan,
  debug,
  lastIntent,
  transcript,
  liveFlags,
  audioBytes,
  facts,
  onTtsTest,
  connected,
}: {
  mode: Mode;
  voice: VoiceSnapshot;
  plan: SessionPlan | null;
  debug: Record<string, unknown>;
  lastIntent: { transcript: string; intent: Intent | null } | null;
  transcript: { kind: string; text: string }[];
  liveFlags: { type: string; detail: string }[];
  audioBytes: number;
  facts: { text: string; topic: string; kind: string }[];
  onTtsTest: () => void;
  connected: boolean;
}) {
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const loadMemory = useCallback(async () => {
    try {
      const res = await fetch('/api/memory');
      const data = await res.json();
      if (!data.error) setMemory(data);
    } catch {
      /* panel is best-effort */
    }
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory]);

  async function consolidate() {
    setConsolidating(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/consolidate', { method: 'POST' });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setResult(data);
      await loadMemory();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setConsolidating(false);
    }
  }

  /**
   * Blank the profile and reload, so the next session opens with onboarding.
   * Reloading is deliberate: the live session is holding the old profile, and
   * the point of the button is to watch Ollie meet someone new.
   */
  async function startOver() {
    if (!confirm('Forget this child and start over? The next session will begin with onboarding.'))
      return;
    setResetting(true);
    setError('');
    try {
      const res = await fetch('/api/child/reset', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setResetting(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(String((err as Error).message ?? err));
      setResetting(false);
    }
  }

  const words = (debug.lastWords as any[]) ?? [];
  const wovenFact = debug.wovenFact as { text: string; beat: number } | undefined;
  const tts = debug.lastTts as
    | { bytes: number; seconds: number; totalSent?: number }
    | undefined;
  const sentBytes = tts?.bytes ?? null;
  // Compare like with like: both totals are for the whole session.
  const totalSent = tts?.totalSent ?? null;
  const sentSeconds = tts?.seconds ?? 0;

  return (
    <aside className="panel">
      <h2>Session</h2>
      <div className="kv">
        <span>Mode</span>
        <span>{mode}</span>
      </div>
      <div className="kv">
        <span>Child</span>
        <span>
          {memory?.child.name?.trim() || 'not met yet'}
          {memory?.child.age ? `, ${memory.child.age}` : ''}
        </span>
      </div>
      <div className="kv">
        <span>Sessions / events</span>
        <span>
          {memory?.stats.sessions ?? 0} / {memory?.stats.events ?? 0}
        </span>
      </div>
      <div className="kv">
        <span>Memory version</span>
        <span>v{memory?.memory.version ?? 0}</span>
      </div>

      {/*
        The state machine, on screen. Every question the old design answered by
        inference — is the mic live, may silence end this turn, who opened it —
        is now a field you can just read.
      */}
      <h2>Floor</h2>
      <div className="panel-section">
        <div className="kv">
          <span>State</span>
          <span>{voice.state}</span>
        </div>
        <div className="kv">
          <span>Turn-taking</span>
          <span>{voice.mode}</span>
        </div>
        <div className="kv">
          <span>Mic</span>
          <span>{voice.mic ? `open · turn ${voice.mic.turnId}` : 'closed'}</span>
        </div>
        <div className="kv">
          <span>Opened by</span>
          <span>{voice.mic?.reason ?? '—'}</span>
        </div>
        <div className="kv">
          <span>Auto-close</span>
          <span>{voice.mic ? (voice.mic.autoCloseArmed ? 'armed' : 'manual') : '—'}</span>
        </div>
        <div className="kv">
          <span>Speaking</span>
          <span>{voice.speaking ? `#${voice.speaking.utteranceId}` : '—'}</span>
        </div>
        {/*
          A turn that was interrupted before it could be answered, waiting to
          find out whether the interruption meant anything. Shown because a
          held turn used to be a dropped one, silently.
        */}
        <div className="kv">
          <span>Held turn</span>
          <span>
            {voice.superseded
              ? `turn ${voice.superseded.turnId} · ${voice.superseded.text === null ? 'awaiting words' : 'words in hand'}`
              : '—'}
          </span>
        </div>
        {(debug.voiceRejected as any) && (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            last refused: {(debug.voiceRejected as any).event} — {(debug.voiceRejected as any).why}
          </div>
        )}
        {(debug.voiceInvariant as any) && (
          <div className="flag sensitive_topic" style={{ marginTop: 8 }}>
            <b>invariant broken</b>
            <div>{((debug.voiceInvariant as any).violations ?? []).join('; ')}</div>
          </div>
        )}
      </div>

      <h2>Audio</h2>
      <div className="panel-section">
        <button
          className="panel-btn"
          onClick={onTtsTest}
          disabled={!connected}
          style={{ marginBottom: 8 }}
        >
          🔊 Test sound
        </button>
        <div className="kv">
          <span>Sent by server</span>
          <span>
            {sentBytes === null
              ? '—' : `${sentBytes} B · ${sentSeconds}s`}
          </span>
        </div>
        <div className="kv">
          <span>Received by browser</span>
          <span>{audioBytes} B</span>
        </div>
        {totalSent !== null && totalSent > 0 && audioBytes === 0 && (
          <div className="flag sensitive_topic" style={{ marginTop: 8 }}>
            <b>audio not arriving</b>
            <div>The server produced audio but this browser received none.</div>
          </div>
        )}
        {sentBytes === 0 && (
          <div className="flag sensitive_topic" style={{ marginTop: 8 }}>
            <b>no audio produced</b>
            <div>
              Text-to-speech returned nothing. Run <code>npm run realtime:check</code> —
              it tests the voice on its own.
            </div>
          </div>
        )}
        {audioBytes > 0 && (
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Audio is reaching the browser. If you still hear nothing, check the system
            output device and tab mute.
          </div>
        )}
      </div>

      <h2>Last Azure result</h2>
      <div className="panel-section">
        {debug.azureRecognized ? (
          <div className="kv">
            <span>Heard</span>
            <span>&ldquo;{String(debug.azureRecognized)}&rdquo;</span>
          </div>
        ) : (
          <div className="muted" style={{ padding: '6px 0' }}>
            Nothing scored yet.
          </div>
        )}
        {words.map((w: any, i: number) => (
          <div className="bar-row" key={i}>
            <span>{w.word}</span>
            <div className="bar">
              <div
                className={`bar-fill${(w.score ?? 0) < 60 ? ' low' : ''}`}
                style={{ width: `${Math.max(0, Math.min(100, w.score ?? 0))}%` }}
              />
            </div>
            <span>{w.score === null ? '—' : Math.round(w.score)}</span>
          </div>
        ))}
        {debug.azurePartial ? (
          <div className="muted" style={{ marginTop: 6, fontSize: 11 }}>
            partial: {String(debug.azurePartial)}
          </div>
        ) : null}
      </div>

      <h2>Talk router</h2>
      <div className="panel-section">
        {lastIntent ? (
          <>
            <div className="kv">
              <span>Said</span>
              <span>&ldquo;{lastIntent.transcript}&rdquo;</span>
            </div>
            <div className="kv">
              <span>Intent</span>
              <span>{lastIntent.intent ?? '—'}</span>
            </div>
          </>
        ) : (
          <div className="muted" style={{ padding: '6px 0' }}>
            Nothing said yet.
          </div>
        )}
      </div>

      {/* The personalization loop, made visible: heard → held → woven in. */}
      <h2>Learned today</h2>
      <div className="panel-section">
        {facts.length === 0 ? (
          <div className="muted" style={{ padding: '6px 0' }}>
            Nothing shared yet.
          </div>
        ) : (
          facts.map((f, i) => (
            <div className="transcript-line" key={i}>
              <span className="kind">{f.kind}</span>
              {f.text}
            </div>
          ))
        )}
        {wovenFact && (
          <div className="chip added" style={{ marginTop: 8 }}>
            woven into beat {wovenFact.beat}: {wovenFact.text}
          </div>
        )}
      </div>

      <h2>Current plan</h2>
      <pre>{plan ? JSON.stringify(plan, null, 2) : 'not generated yet'}</pre>

      <h2>Skill mastery</h2>
      <div className="panel-section">
        {(memory?.mastery ?? []).slice(0, 12).map((m) => (
          <div className="bar-row" key={m.skill_id}>
            <span title={m.label}>{m.skill_id}</span>
            <div className="bar">
              <div
                className={`bar-fill${m.p_mastery < 0.5 ? ' low' : ''}`}
                style={{ width: `${m.p_mastery * 100}%` }}
              />
            </div>
            <span>{m.p_mastery.toFixed(2)}</span>
          </div>
        ))}
      </div>

      <h2>Memory model</h2>
      <div className="panel-section">
        <div style={{ margin: '6px 0' }}>
          {(memory?.memory.interests ?? []).map((i) => (
            <span className="chip" key={i.topic}>
              {i.topic} · {i.weight}
            </span>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
          {memory?.memory.personality_notes || 'no personality notes yet'}
        </div>
        <div style={{ marginTop: 8 }}>
          {(memory?.memory.canon.open_threads ?? []).map((t, i) => (
            <div key={i} className="transcript-line">
              <span className="kind">thread</span>
              {t}
            </div>
          ))}
        </div>
      </div>

      <h2>Parent flags</h2>
      <div className="panel-section">
        {[...liveFlags, ...(memory?.flags ?? [])].length === 0 ? (
          <div className="muted" style={{ padding: '6px 0' }}>
            None.
          </div>
        ) : (
          [...liveFlags, ...(memory?.flags ?? [])].slice(0, 8).map((f, i) => (
            <div className={`flag ${f.type}`} key={i}>
              <b>{f.type}</b>
              <div>{f.detail}</div>
            </div>
          ))
        )}
      </div>

      <h2>Transcript</h2>
      <div className="panel-section" style={{ maxHeight: 240, overflowY: 'auto' }}>
        {transcript.length === 0 ? (
          <div className="muted" style={{ padding: '6px 0' }}>
            Session hasn&rsquo;t started.
          </div>
        ) : (
          transcript
            .slice(-30)
            .map((t, i) => (
              <div className="transcript-line" key={i}>
                <span className="kind">{t.kind}</span>
                {t.text}
              </div>
            ))
        )}
      </div>

      <h2>Consolidate</h2>
      <button className="panel-btn" onClick={consolidate} disabled={consolidating}>
        {consolidating ? 'Thinking about today…' : 'Consolidate memory'}
      </button>
      <button
        className="panel-btn"
        onClick={startOver}
        disabled={resetting}
        style={{ marginTop: 8 }}
      >
        {resetting ? 'Forgetting…' : '↺ Start over (new child)'}
      </button>
      {error && (
        <div className="flag sensitive_topic" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {result && (
        <>
          <h2>Memory diff</h2>
          <div className="panel-section">
            <div className="kv">
              <span>Events folded in</span>
              <span>{result.eventsProcessed}</span>
            </div>
            <div style={{ margin: '8px 0' }}>
              {result.diff.interests.length === 0 ? (
                <span className="muted">no interest changes</span>
              ) : (
                result.diff.interests.map((c: any) => (
                  <span
                    className={`chip ${c.to === null ? 'removed' : c.from === null ? 'added' : ''}`}
                    key={c.topic}
                  >
                    {c.topic} {c.from ?? '—'} → {c.to ?? '—'}
                  </span>
                ))
              )}
            </div>

            {result.diff.personality_notes.changed && (
              <>
                <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                  personality notes
                </div>
                <div className="transcript-line" style={{ opacity: 0.6 }}>
                  {result.diff.personality_notes.from || '(empty)'}
                </div>
                <div className="transcript-line" style={{ color: '#8fd8a8' }}>
                  {result.diff.personality_notes.to}
                </div>
              </>
            )}

            <div style={{ marginTop: 8 }}>
              {result.diff.canon.open_threads.added.map((t: string) => (
                <span className="chip added" key={t}>
                  + {t}
                </span>
              ))}
              {result.diff.canon.open_threads.removed.map((t: string) => (
                <span className="chip removed" key={t}>
                  {t}
                </span>
              ))}
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                next targets
              </div>
              {result.targets.map((t: string) => (
                <span className="chip added" key={t}>
                  {t}
                </span>
              ))}
            </div>
          </div>

          <h2>Next session plan</h2>
          <pre>{JSON.stringify(result.nextPlan, null, 2)}</pre>
        </>
      )}
    </aside>
  );
}
