import { streamObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import { trimSpokenTurn } from '../profile';
import type { FactKind } from '../facts';
import type { Intent } from '../types';

/**
 * One call: work out what the child meant AND what to say back.
 *
 * This used to be three sequential round-trips — Haiku to classify the intent,
 * Sonnet to write the reply, Haiku again to safety-check it — before the first
 * byte of audio could be generated. Four to six seconds of silence after a child
 * says "I'm bored". At that age a reply that late is not a reply; they have
 * already decided nobody is listening.
 *
 * Collapsing them costs some eloquence and buys about four seconds. For a
 * two-sentence acknowledgment that is the right trade, and the trade only
 * applies here: story beats and the passages the child has to read still go
 * through the narrator on Sonnet with the full safety pass, because that is
 * content, not conversation.
 *
 * What does NOT move into the model: the sensitive-topic response is still a
 * fixed template chosen by code (PLAN.md §5), so the highest-stakes path never
 * depended on this call in the first place.
 */

/**
 * Field order is load-bearing, because the object is streamed.
 *
 * `intent` first: it is one token, it arrives almost immediately, and it is the
 * thing that decides whether the generated reply is allowed to be spoken at all.
 * A sensitive topic gets a fixed template and NOTHING improvised (PLAN.md §5) —
 * speaking first and classifying afterwards would be exactly the wrong order for
 * the one path where it matters most.
 *
 * `speak_text` second: the only field the child is waiting on. Everything after
 * it is bookkeeping for the state machine, and the voice no longer waits for it.
 */
const schema = z.object({
  intent: z.enum([
    'help_with_word',
    'question_about_story_or_world',
    'change_request',
    'chitchat',
    'want_to_stop',
    'sensitive_topic',
    'unclear',
  ]),
  speak_text: z
    .string()
    .describe('What you say back, out loud, right now. ONE or TWO short sentences.'),
  requested_topic: z
    .string()
    .nullable()
    .describe('For change_request: the subject they actually named, or null if they did not name one.'),
  interest_topic: z.string().nullable().describe('The thing they care about, if they mentioned one.'),
  fact: z
    .string()
    .nullable()
    .describe(
      'Anything they revealed about their own life, as a short third-person note ("lost a tooth yesterday"). Null if nothing.',
    ),
  fact_kind: z.enum(['interest', 'event', 'feeling', 'person', 'other']).nullable(),
});

export interface ChildResponse {
  intent: Intent;
  speakText: string;
  requestedTopic: string | null;
  interestTopic: string | null;
  fact: string | null;
  factKind: FactKind | null;
  /** True when `onReplyReady` spoke it already, so the caller does not repeat it. */
  alreadySpoken: boolean;
}

/**
 * Handed the reply the moment it is complete, before the rest of the object has
 * finished generating. The intent comes with it so the caller can decline to
 * speak — a sensitive topic must never be improvised.
 *
 * Return your speaking promise and it will be awaited before the full result
 * resolves. Return false to say nothing.
 */
export type OnReplyReady = (
  speakText: string,
  intent: Intent,
) => boolean | void | Promise<boolean | void>;

export async function respondToChild(args: {
  childName: string;
  transcript: string;
  /** The line on screen, if any — they may be asking about a word in it. */
  currentPassage: string | null;
  currentWord: string | null;
  storyPremise: string;
  /** What they have told us today, so the reply can sound like it remembers. */
  learned: string[];
  /**
   * The last few things said, by either of you, in order.
   *
   * Without this every reply was written by something with no memory of the
   * sentence before it — which is exactly what "it feels like different people
   * talking" is. It could ask a question and then answer as though it had not.
   */
  dialogue: string[];
  /** How many guiding questions they have already had. Decided by code, not here. */
  socraticSoFar: number;
  socraticLimit: number;
  /** How they got our attention. */
  source: 'off_script' | 'barge_in' | 'aside';
  /** Called as soon as the spoken reply is ready — usually well before the rest. */
  onReplyReady?: OnReplyReady;
}): Promise<ChildResponse> {
  const fallback: ChildResponse = {
    intent: 'unclear',
    speakText: `Hmm, I didn't quite catch that! Tell me again?`,
    requestedTopic: null,
    interestTopic: null,
    fact: null,
    factKind: null,
    alreadySpoken: false,
  };

  if (!args.transcript || args.transcript.trim().length < 2) return fallback;

  try {
    const { partialObjectStream, object } = streamObject({
      model: model.intent(), // fast: this is on the critical path between them and an answer
      schema,
      system: [
        `You are Ollie, a warm, playful owl reading a story with ${args.childName}, who is about five.`,
        'They just said something to you while you were reading together. Work out what they',
        'meant, and say something back.',
        '',
        '# Intents',
        'help_with_word — they want to know what a word says. Tell them, directly and kindly.',
        'question_about_story_or_world — a thinking question. Reply with ONE guiding question',
        '  that helps them get there themselves, unless you have already asked several, in',
        '  which case just tell them warmly.',
        'change_request — they want a different story or topic, or they are bored of this one.',
        'chitchat — they shared something about their life or their day.',
        'want_to_stop — they want to be finished reading.',
        'sensitive_topic — death, divorce, someone hurting them, a real fear. Choose this',
        '  whenever you are torn between it and a story question.',
        'unclear — babble or genuinely unintelligible.',
        '',
        '# How to reply',
        '- HARD LIMIT: two short sentences. You are interrupting a story to answer them;',
        '  say the thing and hand the floor back.',
        '- Answer what they ACTUALLY said. React to their words before anything else.',
        '- Warm, delighted, never corrective. Never tell them off for interrupting — you want',
        '  them to keep talking to you.',
        '- Nothing scary, nothing violent, nothing sad about family.',
        '- No brands or copyrighted characters, even if they name one. If they ask for a',
        '  Lamborghini, give them a fast red racer with a number on the door.',
        '- Do NOT continue the story here and do NOT give them anything to read. Somebody',
        '  else handles that. You are only answering them.',
        '- If they said they are bored or want something else, sound pleased about it and ask',
        '  what they would rather have. Never talk them out of it.',
        '- You are ONE continuous person in this conversation. Read what was just said before',
        '  you reply. Never repeat a question you already asked, never ask something they have',
        '  already answered, and never answer a question of your own that they have not.',
      ].join('\n'),
      prompt: [
        args.dialogue.length ? `Just now:\n${args.dialogue.join('\n')}\n` : '',
        `Story so far: ${args.storyPremise}`,
        args.currentPassage ? `The line on screen: ${args.currentPassage}` : 'No line on screen right now.',
        args.currentWord ? `The word they were on: ${args.currentWord}` : '',
        args.learned.length ? `Things they have told you today: ${args.learned.join('; ')}` : '',
        `Guiding questions asked so far: ${args.socraticSoFar} of ${args.socraticLimit}.`,
        args.source === 'barge_in'
          ? 'They talked over you to say this, so it mattered enough to interrupt.'
          : args.source === 'aside'
            ? 'They said this in the middle of reading the line out loud.'
            : 'They said this instead of reading.',
        '',
        `${args.childName} said: "${args.transcript}"`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    // Fire the reply the instant the sentence is finished, which — because
    // speak_text is second and only `intent` precedes it — is a long way before
    // the object as a whole is done.
    //
    // The stream is always consumed, callback or not: leaving it unread stalls
    // the request.
    let spoken: string | null = null;
    let speaking: boolean | void | Promise<boolean | void> = undefined;

    for await (const partial of partialObjectStream) {
      if (spoken || !args.onReplyReady) continue;
      if (!partial.intent || !partial.speak_text) continue;

      // A field that comes AFTER speak_text has appeared, so speak_text will not
      // grow any further.
      const complete =
        partial.requested_topic !== undefined ||
        partial.interest_topic !== undefined ||
        partial.fact !== undefined;
      if (!complete) continue;

      spoken = trimSpokenTurn(partial.speak_text as string, 2);
      speaking = args.onReplyReady(spoken, partial.intent as Intent);
    }

    const final = await object;
    const speakText = spoken ?? trimSpokenTurn(final.speak_text, 2);
    // The caller may have declined to speak it (a sensitive topic).
    const wasSpoken = (await speaking) !== false && spoken !== null;

    return {
      intent: final.intent as Intent,
      // Length is arithmetic, not a thing to trust a prompt with.
      speakText,
      requestedTopic: final.requested_topic,
      interestTopic: final.interest_topic,
      fact: final.fact,
      factKind: (final.fact_kind ?? null) as FactKind | null,
      alreadySpoken: wasSpoken,
    };
  } catch (err) {
    console.error('[respond] failed, using fallback', err);
    return fallback;
  }
}
