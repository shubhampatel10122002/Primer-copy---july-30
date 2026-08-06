/**
 * What is the child's next turn FOR, and what did they just do with it?
 *
 * This file exists because of one sentence in CLAUDE.md that the code did not
 * actually enforce:
 *
 *   > Deterministic code decides what happens; the LLM only decides what words
 *   > to say.
 *
 * A question is not words. A question is a decision about what happens next —
 * it obliges the child to answer and it obliges us to listen for one. The
 * responder was free to end any reply with one (its own prompt asks it to), and
 * nothing in the session knew a question had been asked. So the answer came back
 * as a fresh, context-free turn, was compared against the passage on screen,
 * shared no words with it, and was routed to the responder as new conversation —
 * which replied with another question.
 *
 * That is a livelock, and it was observed: nine turns of a child saying "sure",
 * "yeah", "yes let's go" to the same question, phrased seven different ways. The
 * model could SEE it was repeating itself — it has the dialogue — and said so
 * ("I notice you're saying sure lots"). It could not break out, because breaking
 * out was never its decision. Code decides what happens, and code's answer every
 * single turn was "hand the floor back for a reading turn".
 *
 * Two things fix that class of bug, and both are here:
 *
 *   1. A turn has a PURPOSE, declared by whoever hands the floor over. An answer
 *      to our own question is read with `parseYesNo` before any model sees it,
 *      and is never compared against the passage. "Sure" ends the exchange on
 *      the first turn instead of the ninth.
 *
 *   2. Progress is COUNTED. Every guard in this codebase — MAX_LOST_TURNS,
 *      ADAPT_COACH_THRESHOLD, MAX_SOCRATIC_QUESTIONS, the idle ladder — guards a
 *      specific named failure, so a stall nobody named ran forever. `stalled`
 *      is the general one: after two turns that go nowhere the session stops
 *      asking and does something, whatever the model would like to say.
 */

import { branchUtterance, PASSAGE_COVERED } from './conversation';
import { parseYesNo } from './sessionflow';

/**
 * What the child's turn is for. Decided when the floor is handed over, never
 * inferred afterwards — the same discipline as `autoCloseArmed`, and for the
 * same reason: by the time the words arrive, the evidence that would tell you
 * has gone.
 */
export type TurnPurpose =
  /** Read the line on screen. Score it. */
  | 'READ'
  /** Answer the question we just asked. Never scored, never matched to a line. */
  | 'ANSWER'
  /** No expectation — onboarding, or an open floor. */
  | 'FREE';

/**
 * Turns without forward progress before the session stops asking and acts.
 *
 * Two, for the same reason MAX_LOST_TURNS is three: the first is a
 * misunderstanding and the second is a pattern. A third question would be the
 * app talking to itself.
 */
export const STALL_TURNS = 2;

/**
 * ...and before it stops trying to fix it in conversation altogether.
 *
 * At this point the session moves the story on by itself and flags for the
 * grown-up. A child who has taken five turns without reading a word is not
 * having a conversation, they are stuck in one.
 */
export const STALL_ESCALATE = 5;

export interface TurnInput {
  text: string;
  purpose: TurnPurpose;
  /** The line on screen, if any. */
  passage: string | null;
  /** Turns since the child last moved forward through a passage. */
  turnsWithoutProgress: number;
}

export interface TurnDecision {
  kind:
    /** They read the line. Scoring owns it; say nothing. */
    | 'reading'
    /** They read it AND said something. Score one, answer the other. */
    | 'mixed'
    /** An answer to a question we asked. */
    | 'answer'
    /** They said something to us, unprompted. */
    | 'conversation'
    /** They took a turn and said nothing in it. */
    | 'empty';
  /** For `answer`: what it plainly means, if it plainly means anything. */
  yesNo: 'yes' | 'no' | null;
  /** What needs a reply, if anything. */
  said: string;
  /**
   * Stop asking and act.
   *
   * The session must not produce another question while this is true. It is the
   * one thing standing between a bad turn and an infinite one, so it is decided
   * here rather than left to whoever is writing the next line.
   */
  stalled: boolean;
  /** ...and this one means stop trying to talk it out. */
  escalate: boolean;
  reason: string;
}

/**
 * Read one completed turn, given what it was for.
 *
 * Pure, total, and the only place that decides what a turn WAS. Every branch
 * ends in something the session must do; there is no "ignore".
 */
export function decideTurn(input: TurnInput): TurnDecision {
  const text = input.text.trim();
  const stalled = input.turnsWithoutProgress >= STALL_TURNS;
  const escalate = input.turnsWithoutProgress >= STALL_ESCALATE;
  const base = { yesNo: null, said: '', stalled, escalate } as const;

  if (!text) {
    return { ...base, kind: 'empty', reason: 'the turn was silent' };
  }

  // A turn WE asked for.
  //
  // Read deterministically first and never compared against the passage. "Sure"
  // shares no words with any line ever written, so on the old path it came back
  // as conversation every time however many times it was said — and a one-word
  // answer is precisely the shape of answer a five-year-old gives.
  if (input.purpose === 'ANSWER') {
    const yesNo = parseYesNo(text);
    if (yesNo) {
      return { ...base, kind: 'answer', yesNo, said: text, reason: `a plain ${yesNo}` };
    }

    // They chose to read instead of answering, which is an answer of its own —
    // and the most encouraging one available. Only accepted on strong evidence,
    // because "yes please" must not be scored as a misread of the line.
    const branch = branchUtterance({ text, passage: input.passage });
    if (branch.kind === 'reading' && branch.coverage >= PASSAGE_COVERED) {
      return { ...base, kind: 'reading', reason: 'answered by reading the line instead' };
    }

    return { ...base, kind: 'answer', yesNo: null, said: text, reason: 'an answer we cannot read plainly' };
  }

  const branch = branchUtterance({
    text,
    passage: input.passage,
    readingExpected: input.purpose === 'READ',
  });

  if (branch.kind === 'reading') {
    return { ...base, kind: 'reading', reason: branch.reason };
  }
  if (branch.kind === 'mixed') {
    return { ...base, kind: 'mixed', said: branch.conversationText, reason: branch.reason };
  }
  return { ...base, kind: 'conversation', said: branch.conversationText || text, reason: branch.reason };
}

/**
 * What the session DOES about a decided turn.
 *
 * Separate from `decideTurn` and pure for one reason: this is where a loop
 * either terminates or does not, and a policy you cannot simulate is a policy
 * you find out about from a five-year-old. `scripts/selftest.ts` drives these
 * two functions over thousands of scripted conversations and asserts the thing
 * no unit test could see — that the session always, eventually, hands over a
 * turn to read in.
 *
 * `reply` is the only outcome that can produce a question, because it is the
 * only one that reaches the model. Everything else is templated. That is what
 * makes termination provable rather than hoped for.
 */
export type TurnOutcome =
  /** Nothing was said. Let the idle ladder handle it. */
  | { t: 'wait' }
  /** They read. Scoring owns it; say nothing. */
  | { t: 'score' }
  /** Let the responder answer. May ask a question; may not do so forever. */
  | { t: 'reply'; said: string; alsoScore: boolean }
  /** Say something plain with NO question in it and give them the line. */
  | { t: 'give_line' }
  /** They said no. Take it at face value. */
  | { t: 'check_in' }
  /** Stop talking about it and change what is in front of them. */
  | { t: 'break_stall'; why: string };

/**
 * Decide what to do about a turn.
 *
 * Total over every decision, and — the property that matters — it cannot return
 * `reply` more than STALL_TURNS times without the child having read something
 * in between. That is the guarantee the observed livelock needed and did not
 * have: nine turns, seven rephrasings of one question, no way out that did not
 * involve the model choosing to stop asking.
 */
export function actOn(decision: TurnDecision): TurnOutcome {
  // Reading is checked FIRST and is never pre-empted. Progress is cleared by
  // scoring, not here, so a genuine read can arrive with the stall counter
  // still high — and interrupting it to break a stall the child has just
  // broken themselves would be the rudest possible moment to do it.
  if (decision.kind === 'reading') return { t: 'score' };

  // Talking about it has failed for long enough that talking is the problem.
  //
  // Above the `empty` check, deliberately. A child taking turn after turn and
  // saying nothing in them is stalled too, and leaving that to the idle ladder
  // is the same fragmentation that let the original livelock run: every guard
  // covering one named failure, and nothing covering "this is going nowhere".
  if (decision.escalate) {
    return { t: 'break_stall', why: 'turns without reading a word' };
  }

  if (decision.kind === 'empty') return { t: 'wait' };

  if (decision.kind === 'answer') {
    // Read by code, in no time, and acted on rather than discussed. "Sure"
    // used to reach a model whose job is to produce sentences, so it produced
    // one, and the child agreed again.
    if (decision.yesNo === 'yes') return { t: 'give_line' };
    if (decision.yesNo === 'no') return { t: 'check_in' };
    if (decision.stalled) return { t: 'break_stall', why: 'an answer we could not read, twice' };
    return { t: 'reply', said: decision.said, alsoScore: false };
  }

  // Unprompted talking. Answered — once, twice — and then not a third time:
  // the third reply is where a conversation becomes a loop.
  if (decision.stalled) return { t: 'give_line' };
  return { t: 'reply', said: decision.said, alsoScore: decision.kind === 'mixed' };
}

/**
 * Does this line oblige the child to answer?
 *
 * The seam between "the model chose the words" and "the code decides what
 * happens". The responder is asked for one or two sentences and is free to make
 * one of them a question — its own prompt encourages it — so the only reliable
 * moment to notice is after the words exist and before they are spoken.
 *
 * A question mark, and nothing cleverer. It is what the model produces when it
 * asks, it is unambiguous, and a rule you can check by eye is a rule that stays
 * true. Being wrong is cheap in both directions: a false positive listens for an
 * answer to a statement, a false negative is the behaviour we already had.
 */
export function asksSomething(text: string): boolean {
  return text.includes('?');
}
