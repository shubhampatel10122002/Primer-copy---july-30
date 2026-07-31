/**
 * Was that utterance reading, or talking?
 *
 * PLAN.md §15 ruled out automatic off-script detection because the talk button
 * replaced it. That is no longer enough: a child who says "I'm bored" mid-passage
 * and gets no answer has learned the thing is not listening. So we look at every
 * utterance Azure returns during CHILD_READS and decide, in code, whether it was
 * an attempt at the passage or something the child wanted to say.
 *
 * This is deliberately conservative. The two failure modes are not symmetric:
 *
 *   - False positive (a messy read treated as conversation) interrupts a child
 *     mid-sentence and derails the reading. Expensive.
 *   - False negative (a comment treated as a misread) is what happens today, and
 *     the child can still tap the owl. Cheap.
 *
 * So the bar is: an utterance long enough to be a sentence that barely overlaps
 * the passage at all, or a short one carrying an unmistakable conversational cue.
 * Everything else is reading, and the tracker's noise gating (§9.6) handles it.
 */

import { normalizeWord } from './skills';
import { tokenize } from '../server/tracker';
import type { TrackedWord } from './types';

export interface OffScriptVerdict {
  offScript: boolean;
  /** Fraction of spoken words that appear anywhere in the passage. */
  matchRatio: number;
  reason: string;
}

/** Below this many words, an utterance needs an explicit cue to count as talking. */
export const MIN_SENTENCE_TOKENS = 3;

/** At or below this overlap with the passage, a full sentence is not a read. */
export const MAX_MATCH_RATIO = 0.34;

/**
 * Words a child does not say while reading a passage that does not contain them.
 * Kept short and high-signal on purpose — same discipline as lib/leniency.ts,
 * where a wrong forgive is worse than no forgive.
 */
const CONVERSATION_CUES = new Set([
  // wanting out
  'bored', 'boring', 'stop', 'done', 'finished', 'tired', 'sleepy', 'enough',
  // wanting something else
  'instead', 'different', 'another', 'change',
  // calling for a person
  'mom', 'mommy', 'mum', 'mummy', 'dad', 'daddy', 'ollie',
  // states and needs
  'hungry', 'thirsty', 'sick', 'scared', 'hurt', 'potty', 'bathroom',
  // openers that are almost never passage text
  'wait', 'guess', 'hey', 'listen', 'actually', 'know',
]);

/**
 * Decide whether one recognized utterance was the child talking rather than
 * reading. `words` is the whole passage — a child re-reading a line they already
 * passed is still reading, so matching is against every word, not just the ones
 * ahead of the cursor.
 */
export function detectOffScript(args: {
  recognized: string;
  words: TrackedWord[];
}): OffScriptVerdict {
  const spoken = tokenize(args.recognized).map(normalizeWord).filter(Boolean);

  if (spoken.length === 0) {
    return { offScript: false, matchRatio: 1, reason: 'nothing recognized' };
  }

  const passage = new Set(args.words.map((w) => normalizeWord(w.expected)).filter(Boolean));
  const matched = spoken.filter((t) => passage.has(t)).length;
  const matchRatio = matched / spoken.length;

  if (spoken.length >= MIN_SENTENCE_TOKENS) {
    // Noise and half-words fragment into strings of one- and two-letter tokens
    // that match nothing. Requiring one substantial word keeps a passing truck
    // from being mistaken for a question.
    const substantial = spoken.some((t) => t.replace(/'/g, '').length >= 3);
    if (!substantial) {
      return { offScript: false, matchRatio, reason: 'no substantial word — probably noise' };
    }
    if (matchRatio <= MAX_MATCH_RATIO) {
      return {
        offScript: true,
        matchRatio,
        reason: `${spoken.length} words, only ${matched} in the passage`,
      };
    }
    return { offScript: false, matchRatio, reason: 'overlaps the passage' };
  }

  // One or two words. Only an unmistakable cue that is NOT part of the passage
  // counts — otherwise every "stop" in a story about traffic lights derails the
  // session.
  const cue = spoken.find((t) => CONVERSATION_CUES.has(t) && !passage.has(t));
  if (cue && matched === 0) {
    return { offScript: true, matchRatio, reason: `conversational cue "${cue}"` };
  }

  return { offScript: false, matchRatio, reason: 'too short to be sure' };
}

/**
 * Is what we just heard our own voice coming back through the speaker?
 *
 * The half-duplex gate (PLAN.md §8.2) exists because the app could hear itself.
 * But keeping the mic shut for the whole of every narration means a child who
 * speaks up while the story is being told is heard by nothing at all — and a
 * five-year-old will not wait politely for a turn, nor reach for a button.
 *
 * So during playback the mic stays open and this decides what to do with what
 * arrives. Browser echo cancellation removes most of it; this catches the rest,
 * and it has the one piece of information that makes the judgment easy: the
 * exact words currently being spoken. Anything that substantially IS those words
 * is echo.
 */
export function looksLikeEcho(recognized: string, spokenText: string): boolean {
  const heard = tokenize(recognized).map(normalizeWord).filter(Boolean);
  if (heard.length === 0) return true;

  const said = new Set(tokenize(spokenText).map(normalizeWord).filter(Boolean));
  if (said.size === 0) return false;

  const matched = heard.filter((t) => said.has(t)).length;
  // Half is a low bar on purpose. Treating a real interruption as echo costs the
  // child one repetition; treating our own voice as an interruption derails the
  // story and, worse, teaches the app to interrupt itself.
  return matched / heard.length >= 0.5;
}

/**
 * Did the child really interrupt, or did the microphone just pick something up?
 *
 * Stricter than `detectOffScript`, because this fires while the narrator is
 * mid-sentence: cutting the story off is a bigger disruption than answering a
 * comment between passages, so it takes clearer evidence.
 */
export function isInterruption(recognized: string, spokenText: string): boolean {
  if (looksLikeEcho(recognized, spokenText)) return false;

  const heard = tokenize(recognized).map(normalizeWord).filter(Boolean);
  if (heard.length === 0) return false;

  // An unmistakable cue is enough on its own — "stop", "bored", "mommy" are not
  // words a passing television says into a laptop microphone.
  if (heard.some((t) => CONVERSATION_CUES.has(t))) return true;

  // Otherwise it has to look like a sentence someone meant to say.
  return heard.length >= MIN_SENTENCE_TOKENS && heard.some((t) => t.replace(/'/g, '').length >= 3);
}
