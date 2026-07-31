/**
 * The conversation layer.
 *
 * Reading assessment and conversation are two different jobs and this file is
 * the seam between them. Azure's pronunciation assessment answers "how well did
 * they say the words we asked for". It cannot answer "did they even mean to say
 * those words", and the old design tried to make it: it watched the assessment
 * stream and *guessed* whether an utterance was reading, then tore the recognizer
 * down and built a different one if it decided otherwise.
 *
 * That guessing is gone. Every utterance now arrives here as plain text with the
 * passage it is being compared against, and gets branched:
 *
 *   reading      — they read what we asked. Scoring handles it; say nothing.
 *   conversation — they said something else. It must be answered.
 *   mixed        — both, in one breath. Score the reading, answer the aside.
 *
 * No branch is "ignore". A child utterance that reaches this file always ends in
 * either a score or a reply.
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

/**
 * Trailing words that mean the child has not finished talking.
 *
 * Azure ends an utterance at every pause. "I like cars, like Lamborghini... and"
 * is a pause in the middle of a thought, and treating it as the end of a turn is
 * how a child gets talked over mid-list.
 */
const UNFINISHED_ENDINGS = new Set([
  'and', 'or', 'but', 'like', 'um', 'uh', 'erm', 'so', 'because', 'cause', 'cos',
  'with', 'the', 'a', 'an', 'my', 'your', 'to', 'for', 'of', 'is', 'was', 'its',
]);

function words(text: string): string[] {
  return tokenize(text).map(normalizeWord).filter(Boolean);
}

/**
 * Did that sound like the end of a thought, or a breath in the middle of one?
 *
 * Used to decide how long to wait before replying. Being wrong in the patient
 * direction costs a second; being wrong in the other direction cuts a child off.
 */
export function soundsUnfinished(text: string): boolean {
  const spoken = words(text);
  if (spoken.length === 0) return false;

  const last = spoken[spoken.length - 1].replace(/'/g, '');
  if (UNFINISHED_ENDINGS.has(last)) return true;

  // A single word on its own is usually the start of something, not a whole turn.
  return spoken.length === 1 && !CONVERSATION_CUES.has(last);
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

/**
 * Is what we just heard our own voice coming back through the speaker?
 *
 * The microphone is now open while the narrator speaks, because a child who
 * talks during the story has to be heard. This is what keeps that from meaning
 * the app hears itself: it has the exact words currently being spoken, so
 * anything that substantially *is* those words is echo.
 */
export function looksLikeEcho(recognized: string, spokenText: string): boolean {
  const heard = words(recognized);
  if (heard.length === 0) return true;

  const said = new Set(words(spokenText));
  if (said.size === 0) return false;

  const matched = heard.filter((t) => said.has(t)).length;
  // Half is a low bar on purpose. Missing a real interruption costs one repeat;
  // acting on our own echo means the app interrupts itself.
  return matched / heard.length >= 0.5;
}

/**
 * Should we stop talking, right now, on a PARTIAL result?
 *
 * This is the difference between an interruption that works and one that does
 * not. A final result arrives a second or more after the child stops speaking a
 * segment — by which time the narrator has usually finished the sentence anyway,
 * so stopping "on interruption" was indistinguishable from not stopping at all.
 * Partials arrive within a few hundred milliseconds of the first syllable.
 *
 * The bar is two words, or one unmistakable cue, that are not our own echo.
 * Deliberately lower than `isInterruption`: stopping is cheap and recoverable,
 * being talked over is not.
 */
export function startsAnInterruption(partial: string, spokenText: string): boolean {
  if (looksLikeEcho(partial, spokenText)) return false;

  const heard = words(partial);
  if (heard.length === 0) return false;
  if (heard.some((t) => CONVERSATION_CUES.has(t))) return true;

  return heard.length >= 2 && heard.some((t) => t.replace(/'/g, '').length >= 3);
}

/**
 * Did the child really interrupt, or did the microphone just pick something up?
 *
 * Applied to complete utterances, where there is enough text to be sure.
 */
export function isInterruption(recognized: string, spokenText: string): boolean {
  if (looksLikeEcho(recognized, spokenText)) return false;

  const heard = words(recognized);
  if (heard.length === 0) return false;

  // An unmistakable cue stands on its own — "stop" and "bored" are not what a
  // television in the next room says into a laptop microphone.
  if (heard.some((t) => CONVERSATION_CUES.has(t))) return true;

  return heard.length >= MIN_ASIDE_TOKENS && heard.some((t) => t.replace(/'/g, '').length >= 3);
}
