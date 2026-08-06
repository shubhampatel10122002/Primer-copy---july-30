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
  /** Fraction of the UTTERANCE that was in the passage. */
  overlap: number;
  /** Fraction of the PASSAGE the utterance got through. See below. */
  coverage: number;
  reason: string;
}

/** At or above this overlap, an utterance is an attempt at the passage. */
export const READING_OVERLAP = 0.6;

/** At or below this, it is not about the passage at all. */
export const CONVERSATION_OVERLAP = 0.34;

/**
 * At or above this coverage, they got through the line.
 *
 * `overlap` and `coverage` answer different questions, and only ever having
 * asked the first one is a bug this file shipped with:
 *
 *   overlap  — how much of what they SAID was the line?
 *   coverage — how much of the LINE did they say?
 *
 * A child who reads the line and keeps going onto the next one scores LOW on
 * overlap (half of what they said is not in this line) and HIGH on coverage
 * (they said all of it). Judged on overlap alone that is indistinguishable from
 * a child talking to you, so reading ahead — which five-year-olds do constantly
 * — came back as an aside and got answered as conversation. It is the opposite
 * of an aside: it is reading, only more of it.
 */
export const PASSAGE_COVERED = 0.7;

/**
 * In a turn handed over FOR reading, this much of the line means they read it.
 *
 * A separate, lower bar than PASSAGE_COVERED, and it exists because `overlap`
 * is a terrible judge of a child reading badly: sounding a word out, repeating
 * themselves, or a transcript that half heard them all push it down without the
 * child having said one word to us. What does not move is how much of the LINE
 * turned up. Half of it means they were reading it.
 *
 * Not zero, which is what "any shared word at all" would mean — "the blue one I
 * think maybe" shares "the" with half the lines in the English language.
 */
export const READING_TURN_COVERAGE = 0.5;

/** A run of unmatched words shorter than this inside a read line is a misread. */
export const MIN_ASIDE_TOKENS = 3;

/**
 * How many passage words an aside may swallow once it is already an aside.
 *
 * A child who breaks off to talk to you does not dip back into the line for two
 * words and then carry on talking. When a word of the passage turns up in the
 * middle of what they are saying it is a collision, not a return to reading —
 * and the words that collide are exactly the ones this matters for: "to", "a",
 * "the", "something", "and".
 *
 * This is the whole of a real bug. "Change topic to something religious", said
 * over a line containing "to" and "something", split into three unmatched runs;
 * the longest was two words, so the responder was handed "change topic" and had
 * to ask what topic — while the child, who had already said, heard the same
 * question twice and got no story about it either time.
 *
 * It widens an aside; it never creates one. Whether an utterance contains an
 * aside at all is still decided by the longest UNBROKEN run, because that
 * decision is the expensive one: two misread words, two right ones, two more
 * misread is a child stumbling through a line, and joining those up into a
 * four-word "aside" would interrupt them to answer their own reading.
 */
export const MAX_ASIDE_GAP = 2;

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
 * What counts as "that is not English".
 *
 * Deliberately low, and belt-and-braces, because the two errors are not
 * symmetric: English contains no non-Latin letters at all (even "café" is
 * Latin script), so a false positive is close to impossible, while a false
 * negative derails the story. Two foreign letters in a row is already a
 * fragment, not a stray.
 */
const FOREIGN_SCRIPT_SHARE = 0.05;
const FOREIGN_LETTERS_MAX = 1;

/**
 * Did the transcription model hear a different language than the one being
 * spoken?
 *
 * This app is English-only end to end, so a transcript in another script is
 * always wrong. It was seen live: a child reading "Max sits on the red bench"
 * came back as "मैंक्स सेज on the red bench".
 *
 * Scoring never cared — that is Azure's job on the raw audio, always en-US.
 * What is at risk is the STORY. A PARTLY foreign transcript is already safe,
 * because `tokenize` keeps only Latin words and the English half still matches
 * the line. A WHOLLY foreign one is not: nothing matches, so `branchUtterance`
 * sees zero overlap, concludes the child was talking to us rather than reading,
 * and hands it to the responder — which then answers a hallucination and takes
 * the plot with it.
 *
 * The first defence is telling the model to use English (`server/realtime.ts`).
 * This is the second, because a language hint is a hint.
 */
export function looksMistranscribed(text: string): boolean {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return false;
  const foreign = letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length;
  return foreign > FOREIGN_LETTERS_MAX || foreign / letters.length > FOREIGN_SCRIPT_SHARE;
}

/**
 * Was that reading, talking, or both?
 *
 * `passage` is the whole line, not just the words ahead of the cursor — a child
 * re-reading something they already got right is still reading.
 */
export function branchUtterance(args: {
  text: string;
  passage: string | null;
  /**
   * Were they handed this turn to READ in?
   *
   * Not a hint about the words — a fact about the turn, decided by whoever gave
   * them the floor (`lib/session/turns.ts`). It raises the bar for concluding
   * "that was aimed at me", because in a turn that exists for reading, the prior
   * is overwhelmingly that a noisy transcript is a child reading noisily.
   */
  readingExpected?: boolean;
}): UtteranceBranch {
  const spoken = words(args.text);

  if (spoken.length === 0) {
    return {
      kind: 'conversation',
      readingText: '',
      conversationText: '',
      overlap: 0,
      coverage: 0,
      reason: 'nothing heard',
    };
  }

  // Nothing to read means there is nothing to compare against: it is all talking.
  if (!args.passage || !args.passage.trim()) {
    return {
      kind: 'conversation',
      readingText: '',
      conversationText: args.text.trim(),
      overlap: 0,
      coverage: 0,
      reason: 'no passage on screen',
    };
  }

  const expected = new Set(words(args.passage));
  const raw = tokenize(args.text);
  const matched = spoken.map((w) => expected.has(w));
  const overlap = matched.filter(Boolean).length / spoken.length;

  // How much of the LINE they got through, which is a different question from
  // how much of what they said was the line. See PASSAGE_COVERED.
  const said = new Set(spoken);
  const covered = [...expected].filter((w) => said.has(w)).length;
  const coverage = expected.size === 0 ? 0 : covered / expected.size;

  // The longest unbroken run of words that are not in the passage. A real aside
  // is contiguous ("...over the hill CAN WE DO CARS INSTEAD"); a misread is one
  // wrong word here and there. This, and only this, decides whether there is an
  // aside at all — see MAX_ASIDE_GAP for why the widening below must not.
  const runs: { start: number; end: number; length: number }[] = [];
  for (let i = 0; i < matched.length; i++) {
    if (matched[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === i - 1) {
      last.end = i;
      last.length += 1;
    } else {
      runs.push({ start: i, end: i, length: 1 });
    }
  }

  // Ties go to the earliest run: an aside starts where the child stopped
  // reading, and a later run of the same size is more likely to be a stumble.
  let run: { start: number; end: number; length: number } | null = null;
  for (const r of runs) if (!run || r.length > run.length) run = r;

  const bestLength = run?.length ?? 0;
  const asideWords = run ? spoken.slice(run.start, run.end + 1) : [];
  const saidCue = asideWords.some((w) => CONVERSATION_CUES.has(w) && !expected.has(w));

  // One cue word, with more of the line still to come after it, is a MISREADING
  // of the word it stands in for — not a child calling out.
  //
  // This is not a hypothetical. A child read "Red is at the net" as "Dad is at
  // the net"; `dad` is in the cue list under "calling for a person", so a single
  // substituted word turned a perfectly ordinary misread line into an
  // interruption, and the session spent the next nine turns discussing it
  // instead of teaching the word. A cue sitting exactly where a passage word
  // belongs, with the rest of the line read correctly around it, is the shape of
  // a substitution and nothing else.
  //
  // A cue at the END keeps its meaning: nothing follows it to read, so
  // "...over the hill mom" really is a child calling their mum.
  const cueIsSubstitution =
    saidCue && bestLength === 1 && run !== null && run.end < matched.length - 1;
  const hasCue = saidCue && !cueIsSubstitution;

  // They got through the line and kept going. That is reading ahead — the most
  // ordinary thing a fluent-ish five-year-old does — and it is the exact
  // opposite of an aside, however it scores on overlap.
  //
  // Requires the extra words to come AFTER the line, and requires them not to
  // be addressed to us: "the cat sat on the mat can we do cars instead" covers
  // the line too, and that one really is a request.
  if (coverage >= PASSAGE_COVERED && !hasCue && run && run.end === matched.length - 1) {
    return {
      kind: 'reading',
      readingText: args.text.trim(),
      conversationText: '',
      overlap,
      coverage,
      reason: `read ${Math.round(coverage * 100)}% of the line and carried on into the next`,
    };
  }

  if (overlap <= CONVERSATION_OVERLAP) {
    // In a turn handed over FOR reading, a low score is far more likely to be a
    // child reading badly than a child talking. Only an unmistakable cue gets
    // out of the line — otherwise a misread ("Dad" for "Red") on a short
    // passage tips below the threshold and gets answered as conversation, which
    // is how a session ends up discussing a word instead of teaching it.
    const staysReading = args.readingExpected && !hasCue && coverage >= READING_TURN_COVERAGE;
    if (!staysReading) {
      return {
        kind: 'conversation',
        readingText: '',
        conversationText: args.text.trim(),
        overlap,
        coverage,
        reason: `${Math.round(overlap * 100)}% of it was in the passage`,
      };
    }
  }

  // Mostly the passage, with something else buried in it. Only counts as an
  // aside if it is long enough to be a sentence or carries an unmistakable cue —
  // otherwise it is a child stumbling, and interrupting them would be worse than
  // missing a comment.
  //
  // In a reading turn the bar is a CUE, full stop. A long run of words that are
  // not in the line is what reading badly looks like from here — sounding out,
  // repeating, a transcript that half heard them — and none of it is addressed
  // to us. Breaking out on length alone is how a child gets answered instead of
  // taught.
  const asideEnough = args.readingExpected
    ? hasCue && bestLength >= 1
    : bestLength >= MIN_ASIDE_TOKENS || (hasCue && bestLength >= 1);

  if (run && asideEnough) {
    // NOW widen it. They stopped reading somewhere in this run, so a passage
    // word landing a syllable or two later is a collision and not a return to
    // the line — and cutting the aside there hands the responder half a
    // request, which is a request it has to ask about.
    let start = run.start;
    let end = run.end;
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of runs) {
        if (r.start > end && r.start - end - 1 <= MAX_ASIDE_GAP) {
          end = r.end;
          grew = true;
        } else if (r.end < start && start - r.end - 1 <= MAX_ASIDE_GAP) {
          start = r.start;
          grew = true;
        }
      }
    }

    const asideText = raw.slice(start, end + 1).join(' ');
    const readingText = raw.filter((_, i) => i < start || i > end).join(' ');
    const reason = hasCue
      ? `said "${asideText}" mid-line`
      : `${bestLength} words that are not in the line`;

    // The aside was the whole turn — every word of it, passage collisions
    // included. There is no reading half to score or come back to, so calling
    // it mixed would send the session looking for one.
    if (!readingText.trim()) {
      return { kind: 'conversation', readingText: '', conversationText: args.text.trim(), overlap, coverage, reason };
    }

    return { kind: 'mixed', readingText, conversationText: asideText, overlap, coverage, reason };
  }

  if (overlap >= READING_OVERLAP) {
    return {
      kind: 'reading',
      readingText: args.text.trim(),
      conversationText: '',
      overlap,
      coverage,
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
    coverage,
    reason: 'messy, but still an attempt at the line',
  };
}
