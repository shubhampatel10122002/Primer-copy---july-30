import { generateObject } from 'ai';
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
}

export async function respondToChild(args: {
  childName: string;
  transcript: string;
  /** The line on screen, if any — they may be asking about a word in it. */
  currentPassage: string | null;
  currentWord: string | null;
  storyPremise: string;
  /** What they have told us today, so the reply can sound like it remembers. */
  learned: string[];
  /** How many guiding questions they have already had. Decided by code, not here. */
  socraticSoFar: number;
  socraticLimit: number;
  /** How they got our attention. */
  source: 'off_script' | 'barge_in' | 'aside';
}): Promise<ChildResponse> {
  const fallback: ChildResponse = {
    intent: 'unclear',
    speakText: `Hmm, I didn't quite catch that! Tell me again?`,
    requestedTopic: null,
    interestTopic: null,
    fact: null,
    factKind: null,
  };

  if (!args.transcript || args.transcript.trim().length < 2) return fallback;

  try {
    const { object } = await generateObject({
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
      ].join('\n'),
      prompt: [
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

    return {
      intent: object.intent as Intent,
      // Length is arithmetic, not a thing to trust a prompt with.
      speakText: trimSpokenTurn(object.speak_text, 2),
      requestedTopic: object.requested_topic,
      interestTopic: object.interest_topic,
      fact: object.fact,
      factKind: (object.fact_kind ?? null) as FactKind | null,
    };
  } catch (err) {
    console.error('[respond] failed, using fallback', err);
    return fallback;
  }
}
