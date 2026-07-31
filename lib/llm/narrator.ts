import { generateObject } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { model } from './client';
import { runSafetyPass } from './safety';
import { checkVocab } from '../vocab';
import { mentionsWord } from '../praise';
import * as T from '../templates';
import type { Child, ChildMemory, SessionPlan } from '../types';

export const narratorSchema = z.object({
  speak_text: z.string().describe('Exactly what the narrator says aloud. 2-3 short sentences.'),
  child_passage: z
    .string()
    .nullable()
    .describe('The 1-2 sentences the child reads next, or null if the child should not read now.'),
  plan_update: z.string().nullable().describe('Optional: revised remaining beats'),
  current_beat_index: z.number().int().min(0),
});

export type NarratorTurn = z.infer<typeof narratorSchema>;

/**
 * The narrator writes STORY. It no longer writes conversation.
 *
 * Answering the child — a question, a comment, a "this is boring" — is one fast
 * call in lib/llm/respond.ts, because a reply that arrives four seconds late is
 * not a reply. What is left here is the content the child actually reads and the
 * beats around it, where quality is worth the extra second and the full safety
 * pass earns its place.
 */
export type NarratorMode =
  | 'OPENING'
  | 'NEXT_BEAT'
  | 'ENCOURAGE'
  | 'REMIX'
  | 'ADAPT'
  | 'CHECK_IN'
  | 'CONTINUE'
  | 'CLOSING';

function buildSystemPrompt(args: {
  child: Child;
  memory: ChildMemory;
  plan: SessionPlan;
  learned: string[];
}): string {
  const { child, memory, plan, learned } = args;
  const canon = memory.canon ?? {};
  const interests = memory.interests
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((i) => i.topic)
    .join(', ');

  return [
    `You are a warm, playful reading companion telling a story with ${child.name}${
      child.age ? `, who is ${child.age}` : ''
    }.`,
    '',
    '# What you know about this child',
    child.onboarding_notes ? `Parent notes: ${child.onboarding_notes}` : '',
    `Interests: ${interests || 'still learning what they love'}`,
    `Personality notes: ${memory.personality_notes || 'none yet'}`,
    `Story canon (recurring characters): ${(canon.characters ?? []).join(', ') || 'none yet'}`,
    `Open threads from past sessions: ${(canon.open_threads ?? []).join('; ') || 'none yet'}`,
    '',
    // Refreshed by updatePlan/updateLearned as the child tells us things. It is
    // background knowledge, not a to-do list: the state machine decides when a
    // detail is actually allowed into the story (see lib/facts.ts).
    ...(learned.length
      ? [
          '# What they have told you during this session',
          ...learned.map((l) => `- ${l}`),
          'Let this colour how you talk to them. Do NOT work these into the story unless a',
          'turn explicitly tells you to — timing is decided elsewhere.',
          '',
        ]
      : []),
    '# This session plan',
    `Goal: ${plan.goal}`,
    `Premise: ${plan.premise}`,
    `Characters: ${plan.characters.join(', ')}`,
    `Beats: ${plan.beats.map((b, i) => `${i}. ${b}`).join(' | ')}`,
    `Difficulty: ${plan.difficulty}`,
    `Words to work in naturally: ${plan.vocab_constraints.must_use_words.join(', ')}`,
    `Max words per sentence in the child's passage: ${plan.vocab_constraints.max_sentence_words}`,
    `Allowed spelling patterns: ${plan.vocab_constraints.allowed_patterns}`,
    '',
    '# Hard rules',
    '1. Warm, playful, age-appropriate. Short sentences. Never lecture.',
    '2. You are not answering the child here — that happens elsewhere and has already happened. Tell the story.',
    "3. The child's passage must obey the vocab constraints and work in the must-use words naturally.",
    '4. Nothing scary, nothing violent, nothing sad about family. No brand or IP content (no Elsa, no Pokemon) even if the child asks — offer an original stand-in instead, e.g. "a snow queen named Elka".',
    '5. Stay inside the story world. Weave any interruption back into the story within one sentence.',
    '6. If told the child is frustrated, get easier and shorter immediately and offer a choice ("Want a brand new story, or should we see what Blue does next?"). Choices give a child back their sense of control.',
    '',
    '# Output',
    'speak_text is read aloud by a text-to-speech voice — write it to be spoken, never with stage directions, markdown, or emoji.',
    "child_passage is displayed for the child to read aloud. Keep it to 1-2 sentences. Set it to null when the child should not be reading (a closing, or a check-in).",
    'current_beat_index is which plan beat you are on.',
  ]
    .filter(Boolean)
    .join('\n');
}

const MODE_INSTRUCTIONS: Record<NarratorMode, string> = {
  OPENING:
    'Open the story. Greet the child by name in one short sentence, then tell the first beat in 2-3 sentences. Then give them their first passage to read.',
  NEXT_BEAT:
    // A brief acknowledgment of the reading is prepended separately by the state
    // machine (it knows how the reading actually went; this turn is prefetched
    // before the child finishes). So react to the STORY here, and do not open
    // with praise of your own or the child hears two compliments in a row.
    'The child just finished reading their passage. React to the story, advance to the next beat in 2-3 sentences, then give the next passage. Do not praise or comment on their reading — that is handled elsewhere. Do not greet them.',
  ENCOURAGE:
    'The child has read two passages beautifully. Give ONE short praise line that names something specific they did well, then continue the story with the next beat and passage.',
  REMIX:
    "The child asked for something different. Acknowledge their idea enthusiastically, then regenerate the NEXT beat and passage with their new theme. Keep the SAME difficulty, the SAME target skills, and the SAME must-use words. The child changes the costume; the lesson stays.",
  ADAPT:
    'The child is struggling. Make this easier immediately: one short sentence for the passage, simplest words possible, and offer them a choice about what happens next. Stay upbeat — never signal that they failed.',
  CHECK_IN:
    'They have been reading for a while and this is a natural pause. Celebrate the effort warmly, name the specific progress you are given in the context, and then ask ONE question: whether they want to keep reading or stop for today. Make both answers sound equally fine — never pressure them to continue. Do not advance the story. Set child_passage to null.',
  CONTINUE:
    'They said they want to keep reading. Pick the story straight back up where it left off in 2-3 sentences — do not re-introduce yourself, do not recap from the beginning, do not thank them for continuing — then give them the next passage.',
  CLOSING:
    'Wrap the story up warmly in one beat — never on a cliffhanger. Reference something specific the child did today. Set child_passage to null.',
};

/**
 * One narrator conversation per session. The state machine decides the mode;
 * the narrator only decides the words.
 */
export class Narrator {
  private history: ModelMessage[] = [];
  private system: string;
  private learned: string[] = [];

  constructor(
    private child: Child,
    private memory: ChildMemory,
    private plan: SessionPlan,
  ) {
    this.system = buildSystemPrompt({ child, memory, plan, learned: [] });
  }

  private rebuild() {
    this.system = buildSystemPrompt({
      child: this.child,
      memory: this.memory,
      plan: this.plan,
      learned: this.learned,
    });
  }

  /** Replaces the plan after a REMIX/ADAPT rewrite so later turns stay consistent. */
  updatePlan(plan: SessionPlan) {
    this.plan = plan;
    this.rebuild();
  }

  /** Everything the child has volunteered so far, for tone. Not a weave instruction. */
  updateLearned(learned: string[]) {
    this.learned = learned;
    this.rebuild();
  }

  async turn(
    mode: NarratorMode,
    context: string,
    opts: {
      mustMention?: string | null;
      /** At least one of these must appear — used when several words qualify. */
      mustMentionAny?: string[];
      /** A detail the child shared that this beat may finally use. */
      weave?: string | null;
      /**
       * The last few things said, including anything the fast responder said on
       * your behalf. You did not write those, but the child heard them from you.
       */
      dialogue?: string[];
    } = {},
  ): Promise<NarratorTurn> {
    const mustMention = opts.mustMention?.trim() || null;
    const weave = opts.weave?.trim() || null;
    // One list, whichever way the caller expressed it. Satisfying it means using
    // at least one of these exact words.
    const required = mustMention ? [mustMention] : (opts.mustMentionAny ?? []).filter(Boolean);
    const satisfied = (text: string) =>
      required.length === 0 || required.some((w) => mentionsWord(text, w));

    const userMessage = [
      `MODE: ${mode}`,
      MODE_INSTRUCTIONS[mode],
      opts.dialogue?.length
        ? `\nJUST NOW (you and the child, in order — some of your lines were spoken for you, but the child heard them all as you):\n${opts.dialogue.join('\n')}`
        : '',
      context ? `\nCONTEXT: ${context}` : '',
      mustMention
        ? `\nHARD CONSTRAINT: the child read the word "${mustMention}". Praise that exact word, spelled exactly that way. Do NOT name any other word the child read, and do NOT substitute a similar-looking word — you have other words in your context that the child did not read.`
        : '',
      !mustMention && required.length
        ? `\nHARD CONSTRAINT: name at least one of these exact words, which the child really did read: ${required
            .map((w) => `"${w}"`)
            .join(', ')}. Do NOT name any other word — your context is full of words they never said.`
        : '',
      weave
        ? [
            '',
            `GENTLE PERSONALIZATION: the child mentioned earlier that they ${weave}.`,
            'Let that show up in the story world as a small detail — a prop, a passing',
            'likeness, something a character happens to have or notice. Do NOT say that they',
            'told you, do NOT address them about it, and do NOT make it the point of the scene.',
            'If it cannot be done gracefully in this beat, leave it out entirely.',
          ].join('\n')
        : '',
    ].join('\n');

    const attempt = async (extra?: string): Promise<NarratorTurn> => {
      const { object } = await generateObject({
        model: model.narrator(),
        schema: narratorSchema,
        system: this.system,
        messages: [
          ...this.history,
          { role: 'user', content: extra ? `${userMessage}\n\n${extra}` : userMessage },
        ],
      });
      return object;
    };

    let turn: NarratorTurn;
    try {
      turn = await attempt();
    } catch (err) {
      console.error('[narrator] generation failed', err);
      return this.fallback(mode);
    }

    // Objective constraints first — arithmetic, not an LLM judgment call.
    const vocab = checkVocab(turn.child_passage, this.plan.vocab_constraints);

    // Did it praise a word the child actually read? Checked in code, because
    // the model reaching for a similar word from its context is the exact
    // failure this constraint exists to prevent.
    const wrongWord = !satisfied(turn.speak_text);

    // Then the fuzzy safety judgments. Run in parallel with nothing else; this is
    // the only LLM call in the hot path besides the narrator itself.
    let verdict = await runSafetyPass({ turn, plan: this.plan, mode });

    const needsRetry = !verdict.ok || !vocab.ok || wrongWord;
    if (needsRetry) {
      const why = [
        verdict.ok ? '' : verdict.reason,
        vocab.feedback,
        wrongWord
          ? `You named a word the child did not read. The only words you may name are: ${required
              .map((w) => `"${w}"`)
              .join(', ')}.`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.warn(`[narrator] retrying (${verdict.severity}): ${why}`);
      try {
        const retry = await attempt(`Your previous draft had a problem: ${why} Fix it and try again.`);
        const retryVerdict = await runSafetyPass({ turn: retry, plan: this.plan, mode });

        if (retryVerdict.severity === 'hard') {
          // Two strikes on genuine safety — this is what templates are for.
          console.error('[narrator] hard safety failure twice, using template:', retryVerdict.reason);
          return this.fallback(mode);
        }

        // Still crediting the wrong word after being told twice? Do not let it
        // reach the child — a template that names the right word is strictly
        // better than fluent praise for something they never said.
        if (!satisfied(retry.speak_text)) {
          console.error(
            `[narrator] still praising the wrong word after a retry; using template for "${required[0]}"`,
          );
          return {
            ...retry,
            speak_text: T.encourageLine(`"${required[0]}"`),
          };
        }

        // Otherwise take the retry. A slightly long sentence is better pedagogy
        // than the fallback template, and the child hears a real story.
        turn = retry;
        verdict = retryVerdict;
      } catch (err) {
        console.error('[narrator] regeneration failed, keeping first draft', err);
        // Only refuse the first draft if it was a hard safety failure.
        if (verdict.severity === 'hard') return this.fallback(mode);
        if (wrongWord && required.length) {
          return { ...turn, speak_text: T.encourageLine(`"${required[0]}"`) };
        }
      }
    }

    this.history.push({ role: 'user', content: userMessage });
    this.history.push({ role: 'assistant', content: JSON.stringify(turn) });
    // Keep the conversation from growing without bound over a 15 minute session.
    if (this.history.length > 40) this.history = this.history.slice(-40);

    return turn;
  }

  private fallback(mode: NarratorMode): NarratorTurn {
    const character = this.plan.characters[0] ?? 'our friend';
    const needsPassage =
      mode === 'OPENING' || mode === 'NEXT_BEAT' || mode === 'ENCOURAGE' || mode === 'CONTINUE';

    // A check-in that falls back to "something new was about to happen" would
    // never ask the question the whole mode exists to ask.
    if (mode === 'CHECK_IN') {
      return {
        speak_text: T.checkInLine(this.child.name),
        child_passage: null,
        plan_update: null,
        current_beat_index: 0,
      };
    }

    return {
      speak_text: T.safeFallbackBeat(character),
      child_passage: needsPassage ? T.safeFallbackPassage() : null,
      plan_update: null,
      current_beat_index: 0,
    };
  }
}
