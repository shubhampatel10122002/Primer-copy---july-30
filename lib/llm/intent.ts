import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import type { FactKind } from '../facts';
import type { Intent } from '../types';

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
  /** For chitchat: the topic worth remembering as an interest signal. */
  interest_topic: z.string().nullable(),
  /**
   * Anything the child revealed about their own life, in whatever intent — a
   * lost tooth, a birthday, a dog's name, being bored right now.
   */
  fact: z
    .string()
    .nullable()
    .describe(
      'What they revealed about themselves, as a short third-person note ("lost a tooth yesterday", "has a birthday on Saturday"). Null if they revealed nothing personal.',
    ),
  fact_kind: z
    .enum(['interest', 'event', 'feeling', 'person', 'other'])
    .nullable()
    .describe(
      'interest = something they love; event = something that happened or is coming up; feeling = how they feel right now; person = a person or pet in their life.',
    ),
  /**
   * For change_request: what they actually want instead. Null when they only said
   * they were bored — "different" is not a topic, and the difference decides
   * whether we can rebuild the story or have to ask them what they want.
   */
  requested_topic: z
    .string()
    .nullable()
    .describe(
      'The new subject they asked for ("trucks", "space"), or null if they want a change but did not say what to.',
    ),
  reasoning: z.string(),
});

export interface IntentResult {
  intent: Intent;
  interestTopic: string | null;
  fact: string | null;
  factKind: FactKind | null;
  requestedTopic: string | null;
  reasoning: string;
}

/** One Haiku call classifies the child's utterance and pulls out anything personal. */
export async function classifyIntent(args: {
  transcript: string;
  currentPassage: string | null;
  currentWord: string | null;
  storyPremise: string;
  /** How they got our attention: the owl, speaking up mid-passage, or talking over us. */
  source?: 'button' | 'off_script' | 'barge_in';
}): Promise<IntentResult> {
  const { transcript, currentPassage, currentWord, storyPremise, source = 'button' } = args;

  if (!transcript || transcript.trim().length < 2) {
    return {
      intent: 'unclear',
      interestTopic: null,
      fact: null,
      factKind: null,
      requestedTopic: null,
      reasoning: 'empty transcript',
    };
  }

  try {
    const { object } = await generateObject({
      model: model.intent(),
      schema,
      system: [
        'You classify what a young child said to an AI reading companion. Choose exactly one intent.',
        '',
        'help_with_word — they want to know what a word says or how to read it. Procedural help.',
        'question_about_story_or_world — a thinking question ("why is the dragon sad?", "why is the sky blue?").',
        'change_request — they want a different story, topic, or character, or they are bored with this one ("this is boring, I want trucks").',
        'chitchat — they shared something about their life ("my dog is named Max!", "I lost a tooth"). Set interest_topic to the thing they care about.',
        'want_to_stop — they want to be done reading entirely ("I\'m done", "can I go?").',
        'sensitive_topic — death, divorce, someone hurting them, or a real-world fear. When in doubt between this and a story question, choose this.',
        'unclear — babble, silence, or genuinely unintelligible.',
        '',
        'Separately from the intent, fill in `fact` whenever the child revealed something',
        'about their own life — even in passing, and even when the intent is something else.',
        '"I want a story about trucks, I got a truck for my birthday" is a change_request AND',
        'a fact. Write the fact in the third person, as a short note a friend would remember.',
        'Leave it null for anything about the story rather than about them.',
        '',
        'For change_request, set requested_topic ONLY to something they actually named.',
        '"I want trucks" -> "trucks". "I\'m bored" -> null, because bored is not a topic.',
        'Never invent one: null is what tells the companion to ask them what they want.',
      ].join('\n'),
      prompt: [
        `Story premise: ${storyPremise}`,
        currentPassage ? `Passage they are reading: ${currentPassage}` : '',
        currentWord ? `Word they are on: ${currentWord}` : '',
        source === 'off_script'
          ? 'They spoke up in the middle of reading, without pressing the talk button.'
          : source === 'barge_in'
            ? 'They talked over the narrator to say this, so it mattered enough to interrupt.'
            : 'They pressed the talk button to say this.',
        '',
        `The child said: "${transcript}"`,
      ]
        .filter(Boolean)
        .join('\n'),
    });

    return {
      intent: object.intent as Intent,
      interestTopic: object.interest_topic,
      fact: object.fact,
      factKind: (object.fact_kind ?? null) as FactKind | null,
      requestedTopic: object.requested_topic,
      reasoning: object.reasoning,
    };
  } catch (err) {
    console.error('[intent] classification failed', err);
    return {
      intent: 'unclear',
      interestTopic: null,
      fact: null,
      factKind: null,
      requestedTopic: null,
      reasoning: 'classifier error',
    };
  }
}
