/**
 * The voice state machine. One owner of who holds the floor.
 *
 * Everything about turn-taking used to be inferred. Had the child started
 * talking? Server VAD said maybe, guarded by "has any audio played yet" and "has
 * it been audible for 400ms" because otherwise the greeting killed itself. Had
 * they FINISHED talking? A timer of 350 to 3800ms, picked by looking at whether
 * their last word was "and". Was that reading or conversation? A word-overlap
 * ratio against the line on screen.
 *
 * Every one of those was a guess about a five-year-old, and each had a failure
 * mode that felt, to the child, like not being listened to.
 *
 * The mic button replaces all of it with a fact. The child taps to take the
 * floor and taps to give it back. There is nothing left to infer, so there is
 * nothing left to get wrong — which is why this file deletes far more behaviour
 * than it adds.
 *
 * ## The rules this file exists to enforce
 *
 * 1. The mic being open and the AI speaking are mutually exclusive. Not "rarely
 *    overlapping" — impossible. `AI_SPEECH_START` is REJECTED while the mic is
 *    open, and it is not queued to fire on close, because a line written before
 *    the child spoke is about a moment that has passed.
 * 2. A tap while the AI is speaking stops it immediately — the same transition,
 *    no separate barge-in path, no guard window.
 * 3. A tap to close ends the turn. That is the transcript boundary.
 * 4. `autoCloseArmed` is decided AT OPEN TIME from who opened the mic and which
 *    mode is active, and never re-derived. A child who interrupts mid-story is
 *    bored or has something to say; silence-closing that turn would cut them off
 *    at the first breath.
 *
 * ## Design
 *
 * `transition()` is pure: snapshot + event -> new snapshot + effects. It touches
 * no sockets, no timers and no DOM, which is what lets the server and the
 * browser run the SAME reducer over the same event sequence and converge. The
 * browser can therefore act on a tap in the same frame — cancelling playback
 * without waiting for a round trip — and still be certain the server will reach
 * the identical state.
 *
 * `VoiceMachine` is the thin stateful wrapper: it holds the snapshot, hands
 * effects to a sink, and checks the invariants after every transition.
 *
 * ## Transition table
 *
 * Rows are states, columns are events. Every cell is defined; `-` is a
 * deliberate no-op, not an omission.
 *
 * ```
 *              | MIC_TAP        | AI_SPEECH_START | AI_SPEECH_END   | SPEECH_END_DET
 * -------------+----------------+-----------------+-----------------+---------------
 * IDLE         | ->MIC_OPEN     | ->AI_SPEAKING   | -               | -
 *              |   manual       |   start_tts     |   (not speaking)|   (mic closed)
 * AI_SPEAKING  | ->MIC_OPEN     | -               | ->MIC_OPEN if   | -
 *              |   BARGE-IN     |   (already      |   handoff, else |
 *              |   manual       |    speaking)    |   ->IDLE        |
 * MIC_OPEN     | ->PROCESSING   | REJECTED        | -               | ->PROCESSING
 *              |   commit turn  |   mic is open   |                 |   only if armed
 * PROCESSING   | ->MIC_OPEN     | ->AI_SPEAKING   | -               | -
 *              |   drop pending |   speak reply   |                 |
 * ERROR        | ->MIC_OPEN     | ->AI_SPEAKING   | -               | -
 *              |   recover      |   recover       |                 |
 * ENDED        | -              | -               | -               | -
 *
 *              | TRANSCRIPT_FIN | RESPONSE_READY  | ERROR   | RECOVER | MODE_CHANGE
 * -------------+----------------+-----------------+---------+---------+------------
 * IDLE         | - (stale)      | - (stale)       | ->ERROR | -       | set mode
 * AI_SPEAKING  | - (stale)      | - (stale)       | ->ERROR | -       | set mode
 * MIC_OPEN     | - (segment)    | - (stale)       | ->ERROR | -       | set mode *
 * PROCESSING   | process_turn   | ->IDLE if no    | ->ERROR | -       | set mode
 *              |   + disarm dog |   reply coming  |         |         |
 * ERROR        | -              | -               | update  | ->IDLE  | set mode
 * ENDED        | -              | -               | -       | -       | -
 * ```
 *
 * FLOOR_TO_CHILD opens a system mic session — same reason, same arming rules as
 * the `handoff` path — from IDLE and PROCESSING, and only in STORY. It is a
 * no-op everywhere else: in ONBOARDING because every turn there is the child's
 * to open, and in AI_SPEAKING / MIC_OPEN because the floor is already spoken for.
 *
 * `*` MODE_CHANGE away from STORY while an armed mic session is open disarms it,
 * so invariant 4 cannot be broken by a mode change underneath a live turn.
 *
 * SESSION_END is not in the table because it is uniform: from any state it
 * cancels speech, discards any open mic session, and lands in ENDED, which is
 * terminal and ignores everything.
 */

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * How long the child must be quiet before an auto-armed reading turn closes.
 *
 * Only ever applied to a mic session the SYSTEM opened at the end of an AI
 * passage. Generous, because it is the end of a passage being read aloud, and a
 * child who is sounding out "br... br... bridge" is still very much reading.
 */
export const AUTO_CLOSE_SILENCE_MS = 1_600;

/**
 * A close that lands within this of the open is a double tap, not a turn.
 *
 * Two taps in a row is one of the easiest things in the world for a five-year-old
 * to do to a big round button. Committing that produces an empty transcript, a
 * pointless LLM call and a confused "Hmm, I didn't catch that!". So the audio is
 * discarded and the machine goes back to where it started.
 */
export const MIC_DOUBLE_TAP_MS = 200;

/**
 * A backstop, and deliberately NOT turn detection.
 *
 * Onboarding must never close the mic on silence (a child pausing to think keeps
 * their turn), but "never" and "forever" are different promises: a child who
 * opens the mic and walks away would otherwise leave the session mute for good,
 * since nothing is allowed to speak while the mic is open. This closes it after
 * a minute and a half so the session can say something. Long enough that no
 * child thinking about an answer will ever meet it.
 */
export const MIC_MAX_OPEN_MS = 90_000;

/**
 * How long to wait for a transcript before giving up on a turn.
 *
 * The child has stopped talking and is waiting for an answer. If transcription
 * has stalled, saying so and reopening beats a screen that never responds again.
 */
export const PROCESSING_WATCHDOG_MS = 12_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceState = 'IDLE' | 'AI_SPEAKING' | 'MIC_OPEN' | 'PROCESSING' | 'ERROR' | 'ENDED';

/**
 * The orthogonal dimension. The same tap resolves differently in each: in
 * ONBOARDING every mic session is manual at both ends, in STORY the system opens
 * and closes the child's reading turns for them.
 */
export type VoiceMode = 'ONBOARDING' | 'STORY';

/** Who opened the mic. This, plus the mode, is the whole of `autoCloseArmed`. */
export type MicOpenReason = 'user_tap' | 'system_after_passage';

export type ErrorSource = 'stt' | 'tts' | 'session';

export interface MicSession {
  /** Identifies this turn end to end: audio, commit, transcript, response. */
  turnId: number;
  reason: MicOpenReason;
  /**
   * May silence close this turn?
   *
   * Set once, here, at open time. Never recomputed from ambient state — that is
   * the whole point of the manual-interruption override. True requires BOTH
   * `mode === 'STORY'` and `reason === 'system_after_passage'`.
   */
  autoCloseArmed: boolean;
  openedAt: number;
}

export interface Utterance {
  utteranceId: number;
  text: string;
  /**
   * Does the floor pass to the child when this finishes?
   *
   * Decided by the caller when it asks to speak, because only the caller knows
   * whether another line follows. In STORY a handoff auto-opens the mic; in
   * ONBOARDING it never does.
   */
  handoff: boolean;
  startedAt: number;
}

export type VoiceEvent =
  /** The child pressed the button. The only event the child can cause directly. */
  | { t: 'MIC_TAP'; at?: number }
  | { t: 'AI_SPEECH_START'; utteranceId: number; text: string; handoff: boolean }
  /** Playback has DRAINED — sent by the browser, not by whoever streamed it. */
  | { t: 'AI_SPEECH_END'; utteranceId: number }
  | { t: 'SPEECH_END_DETECTED'; turnId: number }
  /**
   * The session is handing the floor over without speaking first.
   *
   * The common hand-over rides on `handoff` at the end of an utterance, which is
   * the case the child sees most: Ollie reads the beat, Ollie stops, the mic is
   * live. This covers the rest — coming back to a passage after a conversational
   * detour, where the last thing said was an answer and not a passage. Same
   * `system_after_passage` reason, same arming rules, no inference.
   *
   * A no-op in ONBOARDING, where every mic session is the child's to open.
   */
  | { t: 'FLOOR_TO_CHILD' }
  | { t: 'TRANSCRIPT_FINAL'; turnId: number; text: string }
  | { t: 'RESPONSE_READY'; turnId: number; willSpeak: boolean }
  | { t: 'ERROR'; message: string; from: ErrorSource }
  | { t: 'RECOVER' }
  | { t: 'MODE_CHANGE'; mode: VoiceMode }
  | { t: 'SESSION_END' };

export type VoiceEventType = VoiceEvent['t'];

export type VoiceEffect =
  | { t: 'open_mic'; turnId: number; autoCloseArmed: boolean; reason: MicOpenReason }
  /** `commit: false` discards the audio instead of transcribing it. */
  | { t: 'close_mic'; turnId: number; commit: boolean }
  | { t: 'arm_auto_close'; turnId: number; silenceMs: number }
  | { t: 'disarm_auto_close' }
  | { t: 'start_tts'; utteranceId: number; text: string }
  /** Stop mid-word: abort the stream AND drop what the browser has buffered. */
  | { t: 'cancel_tts'; utteranceId: number }
  | { t: 'flush_playback' }
  | { t: 'process_turn'; turnId: number; text: string }
  | { t: 'drop_turn'; turnId: number; reason: string }
  | { t: 'arm_watchdog'; turnId: number; ms: number }
  | { t: 'disarm_watchdog' };

export interface VoiceSnapshot {
  state: VoiceState;
  mode: VoiceMode;
  mic: MicSession | null;
  speaking: Utterance | null;
  /** The turn we are waiting on a transcript or a reply for. */
  pendingTurnId: number | null;
  error: { message: string; from: ErrorSource } | null;
  /** Bumped on every accepted transition. Lets a mirror detect it is behind. */
  seq: number;
  /**
   * Bumped whenever the floor changes hands.
   *
   * Anything generated for an earlier generation — a coaching line written
   * before the child said "I don't want to read any more" — checks this and
   * drops itself rather than being spoken into a moment that no longer exists.
   */
  generation: number;
  nextTurnId: number;
  nextUtteranceId: number;
}

export interface Outcome {
  snapshot: VoiceSnapshot;
  effects: VoiceEffect[];
  /** Why an event was deliberately ignored. Never silent, never undefined. */
  noop: string | null;
  /**
   * Why a REQUEST was refused. Distinct from a no-op: the caller asked for
   * something and must now handle not getting it (drop the line, do not queue).
   */
  rejected: string | null;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function initialSnapshot(mode: VoiceMode = 'ONBOARDING'): VoiceSnapshot {
  return {
    state: 'IDLE',
    mode,
    mic: null,
    speaking: null,
    pendingTurnId: null,
    error: null,
    seq: 0,
    generation: 0,
    nextTurnId: 1,
    nextUtteranceId: 1,
  };
}

/**
 * The one place `autoCloseArmed` is ever computed.
 *
 * Both conditions are required and both are known at open time. A user tap is
 * manual in EVERY mode — that is the interruption override, and it is the
 * difference between "the child is taking their reading turn" and "the child has
 * something to say", which silence cannot tell apart.
 */
export function armsAutoClose(mode: VoiceMode, reason: MicOpenReason): boolean {
  return mode === 'STORY' && reason === 'system_after_passage';
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function noop(s: VoiceSnapshot, why: string): Outcome {
  return { snapshot: s, effects: [], noop: why, rejected: null };
}

function reject(s: VoiceSnapshot, why: string): Outcome {
  return { snapshot: s, effects: [], noop: null, rejected: why };
}

function openMic(
  s: VoiceSnapshot,
  reason: MicOpenReason,
  now: number,
  extra: VoiceEffect[] = [],
): Outcome {
  const turnId = s.nextTurnId;
  const autoCloseArmed = armsAutoClose(s.mode, reason);

  const mic: MicSession = { turnId, reason, autoCloseArmed, openedAt: now };
  const effects: VoiceEffect[] = [
    ...extra,
    { t: 'disarm_watchdog' },
    { t: 'open_mic', turnId, autoCloseArmed, reason },
  ];

  // Silence detection is armed if and only if this session may auto-close. The
  // browser is told to run its detector here and nowhere else, so "armed" cannot
  // drift away from the flag it is supposed to follow.
  if (autoCloseArmed) {
    effects.push({ t: 'arm_auto_close', turnId, silenceMs: AUTO_CLOSE_SILENCE_MS });
  }

  return {
    snapshot: {
      ...s,
      state: 'MIC_OPEN',
      mic,
      speaking: null,
      pendingTurnId: null,
      error: null,
      seq: s.seq + 1,
      generation: s.generation + 1,
      nextTurnId: turnId + 1,
    },
    effects,
    noop: null,
    rejected: null,
  };
}

/** Close the open mic. `commit` decides whether the audio becomes a transcript. */
function closeMic(s: VoiceSnapshot, commit: boolean, why: string): Outcome {
  const mic = s.mic!;
  const effects: VoiceEffect[] = [
    { t: 'disarm_auto_close' },
    { t: 'close_mic', turnId: mic.turnId, commit },
  ];

  if (!commit) {
    effects.push({ t: 'drop_turn', turnId: mic.turnId, reason: why });
    return {
      snapshot: {
        ...s,
        state: 'IDLE',
        mic: null,
        pendingTurnId: null,
        seq: s.seq + 1,
        generation: s.generation + 1,
      },
      effects,
      noop: null,
      rejected: null,
    };
  }

  effects.push({ t: 'arm_watchdog', turnId: mic.turnId, ms: PROCESSING_WATCHDOG_MS });
  return {
    snapshot: {
      ...s,
      state: 'PROCESSING',
      mic: null,
      pendingTurnId: mic.turnId,
      seq: s.seq + 1,
    },
    effects,
    noop: null,
    rejected: null,
  };
}

function startSpeaking(s: VoiceSnapshot, e: Extract<VoiceEvent, { t: 'AI_SPEECH_START' }>, now: number): Outcome {
  const speaking: Utterance = {
    utteranceId: e.utteranceId,
    text: e.text,
    handoff: e.handoff,
    startedAt: now,
  };
  return {
    snapshot: {
      ...s,
      state: 'AI_SPEAKING',
      speaking,
      mic: null,
      pendingTurnId: null,
      error: null,
      seq: s.seq + 1,
      nextUtteranceId: Math.max(s.nextUtteranceId, e.utteranceId + 1),
    },
    effects: [
      { t: 'disarm_watchdog' },
      { t: 'start_tts', utteranceId: e.utteranceId, text: e.text },
    ],
    noop: null,
    rejected: null,
  };
}

/** Terminal, and reachable from anywhere. Nothing is left running. */
function endSession(s: VoiceSnapshot): Outcome {
  const effects: VoiceEffect[] = [{ t: 'disarm_auto_close' }, { t: 'disarm_watchdog' }];
  if (s.speaking) {
    effects.push({ t: 'cancel_tts', utteranceId: s.speaking.utteranceId }, { t: 'flush_playback' });
  }
  if (s.mic) {
    effects.push({ t: 'close_mic', turnId: s.mic.turnId, commit: false });
  }
  return {
    snapshot: {
      ...s,
      state: 'ENDED',
      mic: null,
      speaking: null,
      pendingTurnId: null,
      seq: s.seq + 1,
      generation: s.generation + 1,
    },
    effects,
    noop: null,
    rejected: null,
  };
}

function toError(s: VoiceSnapshot, message: string, from: ErrorSource): Outcome {
  const effects: VoiceEffect[] = [{ t: 'disarm_auto_close' }, { t: 'disarm_watchdog' }];
  if (s.speaking) {
    effects.push({ t: 'cancel_tts', utteranceId: s.speaking.utteranceId }, { t: 'flush_playback' });
  }
  if (s.mic) {
    effects.push({ t: 'close_mic', turnId: s.mic.turnId, commit: false });
    effects.push({ t: 'drop_turn', turnId: s.mic.turnId, reason: `error: ${message}` });
  }
  return {
    snapshot: {
      ...s,
      state: 'ERROR',
      mic: null,
      speaking: null,
      pendingTurnId: null,
      error: { message, from },
      seq: s.seq + 1,
      generation: s.generation + 1,
    },
    effects,
    noop: null,
    rejected: null,
  };
}

/**
 * The whole transition table, as one pure function.
 *
 * Every (state, event) pair returns an Outcome. There is no fallthrough and no
 * `default:` that silently does nothing — an ignored event carries a reason.
 */
export function transition(s: VoiceSnapshot, e: VoiceEvent, now: number = Date.now()): Outcome {
  // Terminal. A late transcript or a stray tap after goodbye changes nothing.
  if (s.state === 'ENDED') return noop(s, 'session has ended');

  // Uniform from every state, so it is handled before the table.
  if (e.t === 'SESSION_END') return endSession(s);

  // Mode is orthogonal: it never changes the state, only how later events
  // resolve. The one exception is an armed mic session, which must not survive
  // its mode disappearing out from under it (invariant 4).
  if (e.t === 'MODE_CHANGE') {
    if (s.mode === e.mode) return noop(s, `already in ${e.mode}`);
    const next = { ...s, mode: e.mode, seq: s.seq + 1 };
    if (s.mic?.autoCloseArmed && !armsAutoClose(e.mode, s.mic.reason)) {
      return {
        snapshot: { ...next, mic: { ...s.mic, autoCloseArmed: false } },
        effects: [{ t: 'disarm_auto_close' }],
        noop: null,
        rejected: null,
      };
    }
    return { snapshot: next, effects: [], noop: null, rejected: null };
  }

  if (e.t === 'ERROR') {
    if (s.state === 'ERROR') {
      return {
        snapshot: { ...s, error: { message: e.message, from: e.from }, seq: s.seq + 1 },
        effects: [],
        noop: null,
        rejected: null,
      };
    }
    return toError(s, e.message, e.from);
  }

  switch (s.state) {
    // -----------------------------------------------------------------------
    case 'IDLE':
      switch (e.t) {
        case 'MIC_TAP':
          return openMic(s, 'user_tap', now);
        case 'AI_SPEECH_START':
          return startSpeaking(s, e, now);
        case 'AI_SPEECH_END':
          return noop(s, 'nothing was speaking');
        case 'SPEECH_END_DETECTED':
          return noop(s, 'the mic is closed');
        case 'TRANSCRIPT_FINAL':
          return noop(s, `transcript for turn ${e.turnId} arrived after the turn was over`);
        case 'RESPONSE_READY':
          return noop(s, `no turn ${e.turnId} is waiting on a reply`);
        case 'FLOOR_TO_CHILD':
          return s.mode === 'STORY'
            ? openMic(s, 'system_after_passage', now)
            : noop(s, 'onboarding turns are the child to open');
        case 'RECOVER':
          return noop(s, 'nothing to recover from');
      }
      break;

    // -----------------------------------------------------------------------
    case 'AI_SPEAKING':
      switch (e.t) {
        // Barge-in. Not a special case — the same transition as any other tap,
        // which is exactly why it cannot be late: there is no guard window, no
        // "has enough played yet", and no transcript to wait for.
        case 'MIC_TAP':
          return openMic(s, 'user_tap', now, [
            { t: 'cancel_tts', utteranceId: s.speaking!.utteranceId },
            { t: 'flush_playback' },
          ]);

        case 'AI_SPEECH_START':
          // Speech is serialised by the caller. A second request here means two
          // lines raced; keep the one already audible rather than talking over
          // ourselves, which is the most confusing thing a child can be handed.
          return e.utteranceId === s.speaking!.utteranceId
            ? noop(s, 'already speaking this utterance')
            : reject(s, 'already speaking — this line would overlap');

        case 'AI_SPEECH_END': {
          if (e.utteranceId !== s.speaking!.utteranceId) {
            return noop(s, `utterance ${e.utteranceId} is not the one in the air`);
          }
          const finished = s.speaking!;
          const idle: VoiceSnapshot = {
            ...s,
            state: 'IDLE',
            speaking: null,
            seq: s.seq + 1,
          };

          // The floor passes to the child, and in STORY they should never have
          // to reach for it. This is the ONLY route to an auto-close-armed mic.
          if (finished.handoff && s.mode === 'STORY') {
            return openMic(idle, 'system_after_passage', now);
          }
          return { snapshot: idle, effects: [], noop: null, rejected: null };
        }

        case 'SPEECH_END_DETECTED':
          return noop(s, 'the mic is closed');
        case 'TRANSCRIPT_FINAL':
          return noop(s, `transcript for turn ${e.turnId} arrived after the turn was over`);
        case 'RESPONSE_READY':
          return noop(s, `no turn ${e.turnId} is waiting on a reply`);
        case 'FLOOR_TO_CHILD':
          return noop(s, 'still speaking — the handoff flag covers this');
        case 'RECOVER':
          return noop(s, 'nothing to recover from');
      }
      break;

    // -----------------------------------------------------------------------
    case 'MIC_OPEN':
      switch (e.t) {
        case 'MIC_TAP': {
          const openFor = now - s.mic!.openedAt;
          // Two taps in a row. There is no turn here to finalise.
          if (openFor < MIC_DOUBLE_TAP_MS) {
            return closeMic(s, false, `double tap (${openFor}ms)`);
          }
          return closeMic(s, true, 'child tapped to close');
        }

        // THE invariant. Not deferred, not queued — refused. A reply generated
        // while the child is still holding the floor is about a moment that has
        // already moved on, and speaking it on close is worse than dropping it.
        case 'AI_SPEECH_START':
          return reject(s, 'the mic is open — the AI does not speak, and does not queue');

        case 'AI_SPEECH_END':
          return noop(s, 'nothing was speaking');

        case 'SPEECH_END_DETECTED': {
          if (e.turnId !== s.mic!.turnId) {
            return noop(s, `silence reported for turn ${e.turnId}, not the open one`);
          }
          // The manual-interruption override, enforced rather than described.
          if (!s.mic!.autoCloseArmed) {
            return noop(s, 'this mic session is manual — silence does not end it');
          }
          return closeMic(s, true, 'child finished reading');
        }

        // A segment landed while they are still talking. The turn is not over
        // until they say it is; whoever is collecting segments keeps it.
        case 'TRANSCRIPT_FINAL':
          return noop(
            s,
            e.turnId === s.mic!.turnId
              ? 'a segment of a turn that is still open'
              : `transcript for turn ${e.turnId} is stale`,
          );

        case 'RESPONSE_READY':
          return noop(s, `reply for turn ${e.turnId} arrived after the child took the floor again`);
        case 'FLOOR_TO_CHILD':
          return noop(s, 'the child already has the floor');
        case 'RECOVER':
          return noop(s, 'nothing to recover from');
      }
      break;

    // -----------------------------------------------------------------------
    case 'PROCESSING':
      switch (e.t) {
        // They want to say something else before we have answered. Always
        // allowed: a child must never have to wait for the network to be heard.
        case 'MIC_TAP':
          return openMic(s, 'user_tap', now, [
            { t: 'drop_turn', turnId: s.pendingTurnId ?? -1, reason: 'child spoke again first' },
          ]);

        case 'AI_SPEECH_START':
          return startSpeaking(s, e, now);

        case 'AI_SPEECH_END':
          return noop(s, 'nothing was speaking');
        case 'SPEECH_END_DETECTED':
          return noop(s, 'the mic is closed');

        case 'TRANSCRIPT_FINAL': {
          if (e.turnId !== s.pendingTurnId) {
            return noop(s, `transcript for turn ${e.turnId}, but turn ${s.pendingTurnId} is pending`);
          }
          // Stay in PROCESSING: the transcript is the input, not the answer.
          // But the watchdog is disarmed here — it guards "the words never
          // arrived", and they have. Leaving it running would let a slow reply
          // trip a recovery in the middle of a working conversation.
          return {
            snapshot: { ...s, seq: s.seq + 1 },
            effects: [
              { t: 'disarm_watchdog' },
              { t: 'process_turn', turnId: e.turnId, text: e.text },
            ],
            noop: null,
            rejected: null,
          };
        }

        case 'RESPONSE_READY': {
          if (e.turnId !== s.pendingTurnId) {
            return noop(s, `reply for turn ${e.turnId}, but turn ${s.pendingTurnId} is pending`);
          }
          // Something IS coming: hold PROCESSING so the UI keeps saying so
          // right up to the first syllable, rather than flicking through idle.
          if (e.willSpeak) return { snapshot: { ...s, seq: s.seq + 1 }, effects: [], noop: null, rejected: null };
          return {
            snapshot: { ...s, state: 'IDLE', pendingTurnId: null, seq: s.seq + 1 },
            effects: [{ t: 'disarm_watchdog' }],
            noop: null,
            rejected: null,
          };
        }

        case 'FLOOR_TO_CHILD':
          return s.mode === 'STORY'
            ? openMic(s, 'system_after_passage', now, [
                { t: 'drop_turn', turnId: s.pendingTurnId ?? -1, reason: 'floor handed back' },
              ])
            : noop(s, 'onboarding turns are the child to open');
        case 'RECOVER':
          return noop(s, 'nothing to recover from');
      }
      break;

    // -----------------------------------------------------------------------
    case 'ERROR':
      switch (e.t) {
        // A child tapping is the most direct "I am still here" there is. It
        // always works, from every state, including this one.
        case 'MIC_TAP':
          return openMic({ ...s, error: null }, 'user_tap', now);
        case 'AI_SPEECH_START':
          return startSpeaking({ ...s, error: null }, e, now);
        case 'RECOVER':
          return {
            snapshot: { ...s, state: 'IDLE', error: null, seq: s.seq + 1 },
            effects: [],
            noop: null,
            rejected: null,
          };
        case 'AI_SPEECH_END':
          return noop(s, 'nothing was speaking');
        case 'SPEECH_END_DETECTED':
          return noop(s, 'the mic is closed');
        case 'TRANSCRIPT_FINAL':
          return noop(s, 'in error recovery');
        case 'RESPONSE_READY':
          return noop(s, 'in error recovery');
        case 'FLOOR_TO_CHILD':
          return noop(s, 'in error recovery');
      }
      break;
  }

  // Unreachable: every state handles every event above. Kept so that adding an
  // event without extending the table is a runtime shout, not silence.
  return noop(s, `unhandled ${(e as VoiceEvent).t} in ${s.state}`);
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * The four things that must never be true, checked after every transition.
 *
 * These are not documentation. A violation means the mic could be live while
 * Ollie talks — the exact bug the button exists to make impossible — so it is
 * reported rather than assumed away.
 */
export function checkInvariants(s: VoiceSnapshot): string[] {
  const broken: string[] = [];

  if (s.state === 'MIC_OPEN' && s.speaking !== null) {
    broken.push('MIC_OPEN while an utterance is in the air');
  }
  if (s.state === 'AI_SPEAKING' && s.mic !== null) {
    broken.push('AI_SPEAKING with the mic open');
  }
  if ((s.state === 'AI_SPEAKING') !== (s.speaking !== null)) {
    broken.push(`state ${s.state} disagrees with speaking=${s.speaking ? 'set' : 'null'}`);
  }
  if ((s.state === 'MIC_OPEN') !== (s.mic !== null)) {
    broken.push(`state ${s.state} disagrees with mic=${s.mic ? 'open' : 'closed'}`);
  }
  if (s.mic?.autoCloseArmed && !armsAutoClose(s.mode, s.mic.reason)) {
    broken.push(`autoCloseArmed in mode=${s.mode} opened by ${s.mic.reason}`);
  }

  return broken;
}

// ---------------------------------------------------------------------------
// The stateful wrapper
// ---------------------------------------------------------------------------

export interface VoiceMachineOptions {
  mode?: VoiceMode;
  /** Where effects go. Called in order, synchronously, after the snapshot moves. */
  onEffect: (effect: VoiceEffect, snapshot: VoiceSnapshot) => void;
  /** Called after every accepted transition, for the UI and the wire. */
  onChange?: (snapshot: VoiceSnapshot, event: VoiceEvent) => void;
  /** Deliberate no-ops and refusals, for the debug panel. */
  onIgnored?: (event: VoiceEvent, why: string, kind: 'noop' | 'rejected') => void;
  /** An invariant broke. In tests this fails the run; in a session it is logged. */
  onViolation?: (violations: string[], snapshot: VoiceSnapshot, event: VoiceEvent) => void;
  now?: () => number;
}

export class VoiceMachine {
  private snap: VoiceSnapshot;
  private readonly now: () => number;

  constructor(private opts: VoiceMachineOptions) {
    this.snap = initialSnapshot(opts.mode ?? 'ONBOARDING');
    this.now = opts.now ?? (() => Date.now());
  }

  get snapshot(): VoiceSnapshot {
    return this.snap;
  }
  get state(): VoiceState {
    return this.snap.state;
  }
  get mode(): VoiceMode {
    return this.snap.mode;
  }
  get micIsOpen(): boolean {
    return this.snap.state === 'MIC_OPEN';
  }
  get isSpeaking(): boolean {
    return this.snap.state === 'AI_SPEAKING';
  }
  get generation(): number {
    return this.snap.generation;
  }
  get openTurnId(): number | null {
    return this.snap.mic?.turnId ?? null;
  }

  /**
   * Feed one event. Returns the Outcome so a caller that made a REQUEST — asking
   * to speak, most importantly — can see whether it was accepted.
   */
  send(event: VoiceEvent): Outcome {
    const outcome = transition(this.snap, event, this.now());

    if (outcome.noop || outcome.rejected) {
      this.opts.onIgnored?.(
        event,
        (outcome.noop ?? outcome.rejected)!,
        outcome.noop ? 'noop' : 'rejected',
      );
      return outcome;
    }

    const violations = checkInvariants(outcome.snapshot);
    if (violations.length) {
      this.opts.onViolation?.(violations, outcome.snapshot, event);
    }

    this.snap = outcome.snapshot;
    for (const effect of outcome.effects) this.opts.onEffect(effect, this.snap);
    this.opts.onChange?.(this.snap, event);

    return outcome;
  }

  /**
   * Adopt an authoritative snapshot from elsewhere.
   *
   * Used only by the browser mirror. Both sides run the same reducer over the
   * same events, so this is normally a no-op; it exists so a dropped message
   * cannot leave the two permanently disagreeing about who has the floor.
   */
  adopt(snapshot: VoiceSnapshot): boolean {
    if (snapshot.seq <= this.snap.seq && snapshot.state === this.snap.state) return false;
    this.snap = snapshot;
    return true;
  }
}
