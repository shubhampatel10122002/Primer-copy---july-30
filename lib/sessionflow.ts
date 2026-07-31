/**
 * How a session paces itself and how it ends.
 *
 * A session no longer runs until a beat list is exhausted and then stops. It
 * reads for a while, celebrates what actually improved, asks whether the child
 * wants to keep going, and either continues the same story or ends warmly.
 *
 * All three decisions — when to check in, what counts as progress worth naming,
 * and whether "mm okay I guess" was a yes — are made here, in code.
 */

import { normalizeWord } from './skills';
import type { TrackedWord } from './types';

/** First check-in: roughly six passages, or ten minutes, whichever lands first. */
export const FIRST_CHECKIN_PASSAGES = 6;
export const FIRST_CHECKIN_MS = 10 * 60 * 1000;

/** After the child chooses to keep going, check in more often. */
export const CONTINUE_CHECKIN_PASSAGES = 4;
export const CONTINUE_CHECKIN_MS = 6 * 60 * 1000;

/** A child who never answers still gets an ending. */
export const HARD_STOP_MS = 30 * 60 * 1000;

export function shouldCheckIn(args: {
  passagesSinceCheckIn: number;
  msSinceCheckIn: number;
  checkIns: number;
}): boolean {
  const passages = args.checkIns === 0 ? FIRST_CHECKIN_PASSAGES : CONTINUE_CHECKIN_PASSAGES;
  const ms = args.checkIns === 0 ? FIRST_CHECKIN_MS : CONTINUE_CHECKIN_MS;
  return args.passagesSinceCheckIn >= passages || args.msSinceCheckIn >= ms;
}

export interface ProgressSummary {
  passages: number;
  /** Words they stumbled on and then read correctly. The real win of a session. */
  conquered: string[];
  /** Strong words, for when there was nothing to conquer. */
  strong: string[];
}

/** Strip display punctuation so the narrator says the word, not "hops." */
function clean(word: string): string {
  return word.replace(/^[^a-zA-Z']+|[^a-zA-Z']+$/g, '');
}

/**
 * What to celebrate at a check-in, computed from the passages actually read.
 *
 * Same rule as lib/praise.ts: the narrator is never asked to *recall* what the
 * child read, because its context is full of plausible words they never said.
 */
export function summarizeProgress(passages: readonly TrackedWord[][], limit = 3): ProgressSummary {
  const conquered: string[] = [];
  const strong: string[] = [];
  const seen = new Set<string>();

  for (const words of passages) {
    for (const w of words) {
      const key = normalizeWord(w.expected);
      if (!key || key.length < 3 || seen.has(key)) continue;

      if (w.status === 'passed' && w.attempts > 1) {
        seen.add(key);
        conquered.push(clean(w.expected));
      } else if (w.status === 'passed' && w.attempts === 1 && (w.bestScore ?? 0) >= 90 && key.length >= 4) {
        seen.add(key);
        strong.push(clean(w.expected));
      }
    }
  }

  return {
    passages: passages.length,
    conquered: conquered.slice(0, limit),
    strong: strong.slice(0, limit),
  };
}

/**
 * Did the child say yes or no?
 *
 * Checked in code rather than by an LLM because a check-in is exactly where a
 * classifier round-trip is most annoying, and because "no" is not a word to get
 * wrong: a child who says they are done and gets more reading has been
 * overruled. Negatives are tested first so "no more" is a no.
 */
const NO_PHRASES = [
  'no more', 'no thanks', 'not now', 'not really', 'all done', "i'm done", 'im done',
  'i am done', 'stop', 'finished', 'bye', 'goodbye', 'later', 'tired', 'enough',
  'nope', 'nah', 'no',
];

const YES_PHRASES = [
  'yes', 'yeah', 'yep', 'yup', 'ya', 'sure', 'okay', 'ok', 'please', 'more',
  'keep going', 'keep reading', 'again', 'another', "let's go", 'lets go',
  'i want to', 'uh huh', 'mhm', 'mm hmm', 'course',
];

function contains(haystack: string, phrase: string): boolean {
  return new RegExp(`(^|\\W)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`).test(haystack);
}

export function parseYesNo(text: string | null | undefined): 'yes' | 'no' | null {
  if (!text) return null;
  const s = text.toLowerCase().trim();
  if (!s) return null;

  if (NO_PHRASES.some((p) => contains(s, p))) return 'no';
  if (YES_PHRASES.some((p) => contains(s, p))) return 'yes';
  return null;
}
