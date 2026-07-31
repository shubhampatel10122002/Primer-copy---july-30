import { generateObject } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { model } from './client';
import type { OnboardingDraft, OnboardingLearned } from '../profile';

/**
 * Getting to know a child who has never used this before.
 *
 * This is a conversation, not a form. The agent asks one thing at a time, reacts
 * to whatever it gets, and reports what it heard as structured fields on the
 * side. Whether that is enough to start is not its call — lib/profile.ts decides
 * (`hasEnoughToStart`) and the session loop enforces a turn cap, so a chatty
 * child cannot talk their way past the story and a shy one cannot be interviewed
 * into silence.
 *
 * Sonnet, not Haiku: this is the child's first impression of the voice, and it
 * is doing two things at once (sounding warm, extracting fields).
 */

const onboardingSchema = z.object({
  speak_text: z
    .string()
    .describe('What the companion says aloud. One or two short sentences, ending in ONE question.'),
  learned: z.object({
    name: z.string().nullable().describe("The child's first name, if they just said it. Else null."),
    age: z.number().int().nullable().describe('Their age, if they just said it. Else null.'),
    interests: z
      .array(z.string())
      .describe('Things they just told you they like. Lowercase, one or two words each. Empty if none.'),
    note: z
      .string()
      .nullable()
      .describe('Anything else worth remembering about them, one short sentence. Else null.'),
  }),
  ready: z
    .boolean()
    .describe('True when you know their name and at least one thing they love, and could start.'),
});

export interface OnboardingReply {
  speak: string;
  learned: OnboardingLearned;
  ready: boolean;
}

const SYSTEM = [
  'You are Ollie, a warm, playful owl who reads stories with young children.',
  'You are meeting this child for the very first time and want to know them a little',
  'before you make up a story just for them.',
  '',
  '# How to talk',
  '- You are speaking out loud to a 4-6 year old. Short sentences. No markdown, no emoji,',
  '  no stage directions.',
  '- Ask exactly ONE question per turn, and make it an easy one.',
  '- React to what they said before you ask the next thing. Never fire questions in a row.',
  '- Never read a list of questions and never sound like a form. "What should I call you?"',
  '  not "Please state your name and age."',
  '- If they say something surprising or funny, enjoy it for one sentence first.',
  '- If they do not answer, or answer something else entirely, roll with it warmly and',
  '  gently try once more in a different way.',
  '',
  '# What you are trying to learn',
  '1. Their name. Always ask this first.',
  '2. One or two things they love — animals, trucks, space, dancing, anything.',
  '3. Anything else they volunteer that would make a story feel like theirs.',
  'Their age is nice to have. Never interrogate them for it.',
  '',
  '# Rules',
  '- Nothing scary, nothing sad about family.',
  '- No brand or IP characters, even if they ask. Offer an original stand-in instead.',
  '- Do not start telling a story yet, and do not promise one in every turn.',
  '- Fill "learned" with only what the child actually just said. Never guess a name.',
].join('\n');

export class OnboardingAgent {
  private history: ModelMessage[] = [];

  /**
   * One onboarding turn. Pass null for the opening line, then whatever the child
   * said (or null when they said nothing intelligible).
   */
  async turn(childSaid: string | null, draft: OnboardingDraft): Promise<OnboardingReply> {
    const known = [
      `Known so far — name: ${draft.name ?? 'unknown'}`,
      `age: ${draft.age ?? 'unknown'}`,
      `interests: ${draft.interests.join(', ') || 'none yet'}`,
    ].join(' | ');

    const userMessage =
      childSaid === null
        ? this.history.length === 0
          ? `Say hello and ask their name. This is the first thing they will ever hear you say.\n${known}`
          : `They did not say anything. Nudge them warmly and ask again in an easier way.\n${known}`
        : `The child said: "${childSaid}"\n${known}`;

    try {
      const { object } = await generateObject({
        model: model.narrator(),
        schema: onboardingSchema,
        system: SYSTEM,
        messages: [...this.history, { role: 'user', content: userMessage }],
      });

      this.history.push({ role: 'user', content: userMessage });
      this.history.push({ role: 'assistant', content: JSON.stringify(object) });

      return {
        speak: object.speak_text,
        learned: {
          name: object.learned.name,
          age: object.learned.age,
          interests: object.learned.interests,
          note: object.learned.note,
        },
        ready: object.ready,
      };
    } catch (err) {
      console.error('[onboarding] generation failed', err);
      // A failed call must not leave a child staring at a silent screen. Ask the
      // one question that matters and let the loop try again.
      return {
        speak: draft.name
          ? `Tell me something you really love, ${draft.name}!`
          : "Hi! I'm Ollie. What should I call you?",
        learned: {},
        ready: false,
      };
    }
  }

  /**
   * The hand-off line: warm, specific, and honest that something is being made.
   * Generated rather than templated because naming what the child just told you
   * is the whole point of the moment.
   */
  async finale(draft: OnboardingDraft): Promise<string> {
    try {
      const { object } = await generateObject({
        model: model.narrator(),
        schema: z.object({ speak_text: z.string() }),
        system: SYSTEM,
        messages: [
          ...this.history,
          {
            role: 'user',
            content: [
              'Onboarding is over. Say goodbye to the questions.',
              `Greet ${draft.name ?? 'them'} warmly by name, mention ${
                draft.interests[0] ?? 'the things they love'
              } specifically so they know you were listening,`,
              'and tell them you are making up a story just for them right now.',
              'Two or three short sentences. Do not ask a question. Do not start the story yet.',
            ].join(' '),
          },
        ],
      });
      return object.speak_text;
    } catch (err) {
      console.error('[onboarding] finale failed, using template', err);
      const who = draft.name ? `, ${draft.name}` : '';
      const what = draft.interests[0] ? ` with ${draft.interests[0]} in it` : '';
      return `I loved hearing all that${who}! Give me one second — I'm making up a story just for you${what}.`;
    }
  }
}
