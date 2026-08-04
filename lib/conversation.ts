/**
 * The conversation layer: was that reading, or was it talking?
 *
 * Reading assessment and conversation are two different jobs and this file is
 * the seam between them. Azure's pronunciation assessment answers "how well did
 * they say the words we asked for". It cannot answer "did they even mean to say
 * those words", so a completed turn arrives here as plain text with the passage
 * it is being compared against, and gets branched:
 *
 *   reading      — they read what we asked. Scoring handles it; say nothing.
 *   conversation — they said something else. It must be answered.
 *   mixed        — both, in one breath. Score the reading, answer the aside.
 *
 * No branch is "ignore". A child utterance that reaches this file always ends in
 * either a score or a reply.
 *
 * This file used to be much larger, and most of what left it was answering a
 * question the mic button now answers outright:
 *
 *   `settleDelay` / `soundsUnfinished` decided HOW LONG to wait before treating
 *   a turn as over — 350ms to 3.8s, chosen by inspecting whether the last word
 *   was "and". Tapping to close is the end of the turn, so there is nothing left
 *   to time.
 *
 *   `looksLikeEcho` decided whether a recognised phrase was our own voice
 *   arriving back through the speaker. The mic is shut while Ollie talks and the
 *   browser sends no audio at all in that state, so there is no echo path to
 *   defend against.
 *
 *   `isInterruption` / `startsAnInterruption` decided whether the child had
 *   meant to cut in. A thumb on a button means it.
 */

import { normalizeWord } from './skills';
import { tokenize } from '../server/tracker';

export type UtteranceKind = 'reading' | 'conversation' | 'mixed';

export interface UtteranceBranch {
  kind: UtteranceKind;
  /** The words that matched the passage. */
  readingText: string;
  /** The words that did not — what the conversation layer has to answer. */
  conversationText: string;
  /** Fraction of the utterance that matched the passage. */
  overlap: number;
  reason: string;
}

/** At or above this overlap, an utterance is an attempt at the passage. */
export const READING_OVERLAP = 0.6;

/** At or below this, it is not about the passage at all. */
export const CONVERSATION_OVERLAP = 0.34;

/** A run of unmatched words shorter than this inside a read line is a misread. */
export const MIN_ASIDE_TOKENS = 3;

/**
 * Words a child says to a person, not to a page.
 *
 * Kept short and high-signal, same discipline as lib/leniency.ts: a wrong entry
 * here interrupts a child who was reading, which is expensive.
 */
export const CONVERSATION_CUES = new Set([
  // wanting out
  'bored', 'boring', 'stop', 'done', 'finished', 'tired', 'sleepy', 'enough',
  // wanting something else
  'instead', 'different', 'another', 'change', 'rather',
  // calling for a person
  'mom', 'mommy', 'mum', 'mummy', 'dad', 'daddy', 'ollie',
  // states and needs
  'hungry', 'thirsty', 'sick', 'scared', 'hurt', 'potty', 'bathroom',
  // openers that are almost never passage text
  'wait', 'guess', 'hey', 'listen', 'actually', 'know',
]);

function words(text: string): string[] {
  return tokenize(text).map(normalizeWord).filter(Boolean);
}

/**
 * Was that reading, talking, or both?
 *
 * `passage` is the whole line, not just the words ahead of the cursor — a child
 * re-reading something they already got right is still reading.
 */
export function branchUtterance(args: { text: string; passage: string | null }): UtteranceBranch {
  const spoken = words(args.text);

  if (spoken.length === 0) {
    return { kind: 'conversation', readingText: '', conversationText: '', overlap: 0, reason: 'nothing heard' };
  }

  // Nothing to read means there is nothing to compare against: it is all talking.
  if (!args.passage || !args.passage.trim()) {
    return {
      kind: 'conversation',
      readingText: '',
      conversationText: args.text.trim(),
      overlap: 0,
      reason: 'no passage on screen',
    };
  }

  const expected = new Set(words(args.passage));
  const raw = tokenize(args.text);
  const matched = spoken.map((w) => expected.has(w));
  const overlap = matched.filter(Boolean).length / spoken.length;

  // The longest unbroken run of words that are not in the passage. A real aside
  // is contiguous ("...over the hill CAN WE DO CARS INSTEAD"); a misread is one
  // wrong word here and there.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= matched.length; i++) {
    if (i < matched.length && !matched[i]) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart > bestLength) {
        bestLength = i - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }

  const asideWords = bestStart >= 0 ? spoken.slice(bestStart, bestStart + bestLength) : [];
  const asideText = bestStart >= 0 ? raw.slice(bestStart, bestStart + bestLength).join(' ') : '';
  const hasCue = asideWords.some((w) => CONVERSATION_CUES.has(w) && !expected.has(w));

  if (overlap <= CONVERSATION_OVERLAP) {
    return {
      kind: 'conversation',
      readingText: '',
      conversationText: args.text.trim(),
      overlap,
      reason: `${Math.round(overlap * 100)}% of it was in the passage`,
    };
  }

  // Mostly the passage, with something else buried in it. Only counts as an
  // aside if it is long enough to be a sentence or carries an unmistakable cue —
  // otherwise it is a child stumbling, and interrupting them would be worse than
  // missing a comment.
  if (bestLength >= MIN_ASIDE_TOKENS || (hasCue && bestLength >= 1)) {
    const readingText = raw.filter((_, i) => i < bestStart || i >= bestStart + bestLength).join(' ');
    return {
      kind: 'mixed',
      readingText,
      conversationText: asideText,
      overlap,
      reason: hasCue ? `said "${asideWords.join(' ')}" mid-line` : `${bestLength} words that are not in the line`,
    };
  }

  if (overlap >= READING_OVERLAP) {
    return {
      kind: 'reading',
      readingText: args.text.trim(),
      conversationText: '',
      overlap,
      reason: 'matches the line',
    };
  }

  // Between the two thresholds with nothing that looks like an aside. Treat it as
  // reading: the assessment layer is better placed to judge a messy attempt than
  // a word-overlap ratio is.
  return {
    kind: 'reading',
    readingText: args.text.trim(),
    conversationText: '',
    overlap,
    reason: 'messy, but still an attempt at the line',
  };
}
