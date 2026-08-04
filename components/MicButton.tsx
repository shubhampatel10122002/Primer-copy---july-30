'use client';

import type { VoiceSnapshot } from '@/lib/voice/machine';

/**
 * The owl, which is now the button.
 *
 * There used to be two things here: an owl in the narrator bubble that showed
 * who was talking, and a separate "ear" dock underneath that said "I'm
 * listening" without being pressable. Neither was a control, because there was
 * nothing to control.
 *
 * Now there is, and the mic state is the primary affordance — so they collapse
 * into one object. The thing a child looks at to know whose turn it is, and the
 * thing they touch to take their turn, are the same thing. Two indicators for
 * one fact was already confusing; one indicator plus one nearby control would
 * have been worse, because a five-year-old would have to learn which is which.
 *
 * The label is written for someone who cannot reliably read it. It is there for
 * the grown-up; the colour, the ring and the owl's expression are for the child.
 */

export type MicVisual = 'idle' | 'live' | 'speaking' | 'thinking' | 'error' | 'ended';

export function micVisual(snapshot: VoiceSnapshot): MicVisual {
  switch (snapshot.state) {
    case 'MIC_OPEN':
      return 'live';
    case 'AI_SPEAKING':
      return 'speaking';
    case 'PROCESSING':
      return 'thinking';
    case 'ERROR':
      return 'error';
    case 'ENDED':
      return 'ended';
    default:
      return 'idle';
  }
}

const LABELS: Record<MicVisual, string> = {
  idle: 'Tap to talk',
  live: 'Listening — tap when you’re done',
  speaking: 'Tap to interrupt',
  thinking: 'Thinking…',
  error: 'Tap to try again',
  ended: 'All done',
};

export default function MicButton({
  snapshot,
  hearing,
  disabled,
  onTap,
}: {
  snapshot: VoiceSnapshot;
  /** Sound is reaching the mic right now. Cosmetic — it never decides anything. */
  hearing: boolean;
  disabled: boolean;
  onTap: () => void;
}) {
  const visual = micVisual(snapshot);
  const open = visual === 'live';
  const armed = snapshot.mic?.autoCloseArmed ?? false;

  return (
    <div className="mic-dock">
      <button
        type="button"
        className={`mic${hearing && open ? ' hearing' : ''}`}
        data-visual={visual}
        // Not "microphone". The owl IS the companion, so the button says what
        // pressing it does to him, which is the only model a child has.
        aria-label={open ? 'Stop talking to Ollie' : 'Talk to Ollie'}
        aria-pressed={open}
        disabled={disabled}
        onClick={onTap}
      >
        <span className="mic-ring" />
        <span className="mic-owl">🦉</span>
      </button>

      <div className="mic-label">
        {LABELS[visual]}
        {/*
          Only shown when the system opened this turn and silence will close it.
          A child who tapped their own way in never sees it, because for them it
          would be a lie — nothing is going to end their turn but another tap.
        */}
        {open && armed && <span className="mic-hint">I’ll know when you’re finished</span>}
      </div>
    </div>
  );
}
