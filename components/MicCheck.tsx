'use client';

import { useEffect, useRef, useState } from 'react';
import { AudioEngine } from '@/lib/client/audio';

/**
 * 15-second "say hi to Ollie!" screen. PLAN.md §8.4.
 * Verifies mic permission, the audio path, and volume, and gives the child one
 * successful voice interaction before any reading. A session never starts with
 * an unverified mic (edge case #13).
 */

const SPEECH_RMS = 0.02;
const REQUIRED_LOUD_TICKS = 8;

export default function MicCheck({ onReady }: { onReady: (engine: AudioEngine) => void }) {
  const [state, setState] = useState<'idle' | 'listening' | 'passed' | 'error'>('idle');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string>('');
  const engineRef = useRef<AudioEngine | null>(null);
  const loudTicks = useRef(0);
  /**
   * Set the moment the engine is handed to the session. This MUST be a ref, not
   * state: the unmount cleanup below closes over its scope once, so reading
   * `state` there would see the value from the first render ('idle') and tear
   * down the live AudioContext and mic stream the session had just taken
   * ownership of — silent playback and a dead microphone, with no error anywhere.
   */
  const handedOff = useRef(false);

  useEffect(() => {
    return () => {
      if (!handedOff.current) void engineRef.current?.destroy();
    };
  }, []);

  async function begin() {
    setError('');
    setState('listening');
    loudTicks.current = 0;

    const engine = new AudioEngine();
    engineRef.current = engine;

    engine.onLevel = (rms) => {
      setLevel(rms);
      if (rms > SPEECH_RMS) {
        loudTicks.current += 1;
        if (loudTicks.current >= REQUIRED_LOUD_TICKS) {
          setState((s) => (s === 'listening' ? 'passed' : s));
        }
      }
    };

    try {
      await engine.init();
    } catch (err) {
      const name = (err as DOMException)?.name ?? '';
      setState('error');
      setError(
        name === 'NotAllowedError'
          ? 'Microphone permission was blocked.'
          : name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : String((err as Error)?.message ?? err),
      );
    }
  }

  function start() {
    const engine = engineRef.current;
    if (!engine) return;
    handedOff.current = true; // the session owns the engine from here on
    // Drop our level handler before handing over: this component unmounts
    // immediately, and the session installs its own. Leaving ours attached
    // means every audio block calls setState on a component that is gone.
    engine.onLevel = null;
    onReady(engine);
  }

  return (
    <div className="miccheck">
      <div className="miccheck-card">
        <div className="owl">🦉</div>

        {state === 'idle' && (
          <>
            <h1>Say hi to Ollie!</h1>
            <p>
              Ollie listens with your microphone. Tap the button, then say <b>&ldquo;Hi Ollie!&rdquo;</b> so
              we can make sure he can hear you.
            </p>
            <button className="btn btn-primary" onClick={begin}>
              Turn on my microphone
            </button>
          </>
        )}

        {state === 'listening' && (
          <>
            <h1>Ollie is listening…</h1>
            <p>Say &ldquo;Hi Ollie!&rdquo; nice and loud.</p>
            <div className="meter">
              <div className="meter-fill" style={{ width: `${Math.min(100, level * 600)}%` }} />
            </div>
            <p className="muted" style={{ fontSize: 14 }}>
              Watch the bar move when you talk.
            </p>
          </>
        )}

        {state === 'passed' && (
          <>
            <h1>Ollie heard you! 🎉</h1>
            <p>Your microphone is working perfectly. Ready to read a story together?</p>
            <button className="btn btn-primary" onClick={start}>
              Start the story
            </button>
            <p className="muted" style={{ fontSize: 14, marginTop: 16 }}>
              When it&rsquo;s your turn, tap the owl to talk &mdash; and tap him again
              when you&rsquo;re done.
            </p>
          </>
        )}

        {state === 'error' && (
          <div className="miccheck-error">
            <h3>We couldn&rsquo;t reach the microphone</h3>
            <p style={{ margin: 0 }}>{error}</p>
            <ol>
              <li>Click the padlock or camera icon in the browser address bar.</li>
              <li>
                Set <b>Microphone</b> to <b>Allow</b> for this site.
              </li>
              <li>
                Check your system sound settings — make sure the right input device is selected and
                not muted.
              </li>
              <li>Reload this page and try again.</li>
            </ol>
            <button className="btn" style={{ marginTop: 14 }} onClick={begin}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
