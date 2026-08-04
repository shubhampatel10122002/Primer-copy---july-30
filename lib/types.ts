/** Shared domain + wire types. See PLAN.md §4, §6, §7, §13. */

import type { VoiceEvent, VoiceSnapshot } from './voice/machine';

export type Mode =
  | 'IDLE'
  /** Getting to know a child with no profile yet. */
  | 'ONBOARDING'
  | 'NARRATE'
  | 'CHILD_READS'
  | 'COACH'
  | 'ENCOURAGE'
  | 'TALK'
  | 'SOCRATIC'
  | 'REMIX'
  | 'ADAPT'
  /** Celebrating progress and asking whether to keep reading. */
  | 'WRAP_UP'
  | 'PAUSED'
  | 'END';

export type ErrorType =
  | 'None'
  | 'Mispronunciation'
  | 'Omission'
  | 'Insertion'
  | 'Timeout'
  | 'Developmental';

export type Intent =
  | 'help_with_word'
  | 'question_about_story_or_world'
  | 'change_request'
  | 'chitchat'
  | 'want_to_stop'
  | 'sensitive_topic'
  /** Something about the app is wrong: blank screen, no sound, nothing to read. */
  | 'needs_help'
  | 'unclear';

export interface SessionPlan {
  goal: string;
  target_skills: string[];
  premise: string;
  characters: string[];
  beats: string[];
  difficulty: number;
  vocab_constraints: {
    must_use_words: string[];
    max_sentence_words: number;
    allowed_patterns: string;
  };
}

export interface ChildMemory {
  interests: { topic: string; weight: number; last_seen: string }[];
  personality_notes: string;
  canon: {
    characters?: string[];
    past_summaries?: string[];
    open_threads?: string[];
    /** Things the child mentioned about their own life, newest last. */
    recent_events?: { text: string; ts: string }[];
  };
  version?: number;
}

export interface Child {
  id: string;
  name: string;
  age: number | null;
  onboarding_notes: string | null;
}

export interface Mastery {
  skill_id: string;
  p_mastery: number;
  last_practiced: string | null;
}

/** One word of the passage the child is currently reading. */
export interface TrackedWord {
  index: number;
  expected: string;
  /** Best accuracy seen across all attempts at this word (PLAN.md §9.4). */
  bestScore: number | null;
  errorType: ErrorType | null;
  attempts: number;
  status: 'pending' | 'current' | 'passed' | 'coaching' | 'given';
}

export interface TranscriptEntry {
  ts: string;
  kind: 'narrator' | 'child_passage' | 'child_talk' | 'mode' | 'coach' | 'fact' | 'system';
  text: string;
  meta?: Record<string, unknown>;
}

/** Per-word result handed from Azure to the state machine. */
export interface WordAssessment {
  word: string;
  accuracyScore: number;
  errorType: ErrorType;
  phonemes: {
    /** The phoneme the reference text expects. */
    phoneme: string;
    accuracyScore: number;
    /**
     * What Azure actually heard, best-first (from NBestPhonemes). Lets the
     * leniency table check the real substitution instead of assuming one.
     */
    actual?: string[];
  }[];
}

// ---------------------------------------------------------------------------
// WebSocket protocol.
//
// Client -> server binary frames are mic PCM16 @16k, and they are sent ONLY
// while the mic is open. When the mic is closed no audio leaves the browser at
// all — that is the strongest form the mutual-exclusion rule can take.
// Server -> client binary frames are TTS PCM16 @24k.
// Everything else is JSON text.
//
// Turn-taking rides on the shared state machine (lib/voice/machine.ts) rather
// than on bespoke messages. Both sides run the same reducer:
//
//   - Events the CHILD causes (mic_tap) and events only the browser can observe
//     (playback drained, silence detected) are applied locally first — so a tap
//     stops the voice in the same frame, with no round trip — and then sent up.
//   - Events only the server can cause (a reply is ready, a transcript landed)
//     are applied there and forwarded down as `voice_event`.
//   - `voice_sync` carries the authoritative snapshot, so a dropped message
//     cannot leave the two sides disagreeing about who holds the floor.
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { t: 'start' }
  /** The child pressed the button. The whole interaction model, in one message. */
  | { t: 'mic_tap' }
  /** Client-side silence detector fired. Honoured only if that turn was armed. */
  | { t: 'speech_end'; turnId: number }
  /**
   * Playback has DRAINED — every queued sample has been heard.
   *
   * The server knows when it stopped *sending* audio, which is seconds earlier.
   * Auto-opening the mic on that would put the microphone live while Ollie was
   * still audible, and hand his own voice to pronunciation assessment.
   */
  | { t: 'playback_drained'; utteranceId: number }
  | { t: 'resume' }
  | { t: 'stop' }
  /** Tapping the on-screen answer to a yes/no question, instead of saying it. */
  | { t: 'answer'; value: 'yes' | 'no' }
  /** Speak a fixed line — verifies the audio path without involving the LLM. */
  | { t: 'tts_test' }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'ready'; childName: string; plan: SessionPlan }
  | { t: 'mode'; mode: Mode; reason?: string }
  /** One server-originated state machine event, for the browser's mirror. */
  | { t: 'voice_event'; event: VoiceEvent }
  /** The authoritative snapshot. Reconciliation, not the normal path. */
  | { t: 'voice_sync'; snapshot: VoiceSnapshot }
  | { t: 'passage'; text: string; words: string[] }
  | { t: 'word'; index: number; status: TrackedWord['status']; score: number | null; errorType: ErrorType | null }
  | { t: 'cursor'; index: number }
  /**
   * Every sample of this utterance has been SENT.
   *
   * Not the same as heard. The browser watches its own queue from here and
   * reports `playback_drained` once the last one has actually played, which is
   * what ends the utterance and, in story mode, opens the mic.
   */
  | { t: 'tts_complete'; utteranceId: number }
  /** Something the child said, and what we made of it. */
  | { t: 'talk_closed'; transcript: string | null; intent: Intent | null }
  /** Onboarding progress, so the panel can show the profile filling in. */
  | { t: 'profile'; name: string | null; age: number | null; interests: string[] }
  /** Something the child told us, now in the session's memory. */
  | { t: 'fact'; text: string; topic: string; kind: string }
  /** A yes/no question is on the table and can be answered by tapping. */
  | { t: 'awaiting_answer'; question: 'continue' }
  | { t: 'nudge'; text: string }
  | { t: 'flag'; type: string; detail: string }
  | { t: 'debug'; key: string; value: unknown }
  | { t: 'error'; message: string }
  | { t: 'ended'; sessionId: string };
