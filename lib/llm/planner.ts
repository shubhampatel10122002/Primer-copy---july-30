import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import { describeTargets, comfortableSkills } from '../pedagogy';
import { SKILL_BY_ID } from '../skills';
import type { ChildMemory, Mastery, SessionPlan, Child } from '../types';

/**
 * Deliberately loose bounds.
 *
 * These used to be tight (`beats` 3-7, `must_use_words` 3-8) and a plan came
 * back with NINE must-use words. `generateObject` threw, the whole plan was
 * discarded, and the child got `fallbackPlan()` — a hardcoded dragon story with
 * nothing to do with anything they had just told us. One word over a limit that
 * exists only for tidiness cost the entire personalization.
 *
 * So the schema now accepts anything usable and `clampPlan` trims it. A list
 * that is one item too long is not a malformed plan; it is a plan with one extra
 * item, and code can fix that without an LLM.
 */
const planSchema = z.object({
  goal: z.string().describe('One line: which skills this session practices and reviews'),
  target_skills: z.array(z.string()),
  premise: z.string().describe('One sentence describing the story'),
  characters: z.array(z.string()),
  beats: z.array(z.string()).min(2).describe('Story beats in order, one short phrase each'),
  difficulty: z.number().int().min(1).max(5),
  vocab_constraints: z.object({
    must_use_words: z.array(z.string()).min(1),
    max_sentence_words: z.number().int().min(4).max(20),
    allowed_patterns: z.string(),
  }),
});

/** Trim an over-generous plan into the shape the session machinery expects. */
function clampPlan(plan: SessionPlan): SessionPlan {
  return {
    ...plan,
    beats: plan.beats.slice(0, 7),
    vocab_constraints: {
      ...plan.vocab_constraints,
      must_use_words: plan.vocab_constraints.must_use_words.slice(0, 8),
      max_sentence_words: Math.min(12, Math.max(4, plan.vocab_constraints.max_sentence_words)),
    },
  };
}

export async function generateSessionPlan(args: {
  child: Child;
  memory: ChildMemory;
  mastery: Mastery[];
  targetSkills: string[];
}): Promise<SessionPlan> {
  const { child, memory, mastery, targetSkills } = args;

  const interests = memory.interests
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((i) => `${i.topic} (${i.weight})`)
    .join(', ');

  const canon = memory.canon ?? {};

  const { object } = await generateObject({
    model: model.planner(),
    schema: planSchema,
    system: [
      'You plan a ~15 minute read-aloud session for a beginning reader.',
      'The child reads short passages aloud; an AI narrator reads the story beats.',
      'Design a warm, playful story that naturally exercises the target reading skills.',
      'Hard rules:',
      "- THE PREMISE MUST BE ABOUT WHAT THIS CHILD LOVES. Their top interest belongs in the",
      '  premise itself, not as a detail in beat four. A child who told you they love cars',
      '  should hear a story about cars. This outranks continuity, canon, and your own taste.',
      '- Nothing scary, violent, or sad about family.',
      '- No brand or IP content (no Elsa, no Pokemon, no Lamborghini, no Bugatti). Invent',
      '  original stand-ins that scratch the same itch — a fast red racer with a number on',
      '  the door, not a named marque.',
      '- must_use_words must be decodable words that exercise the target skills.',
      '- Reuse characters and open threads from canon ONLY when they fit what the child is',
      '  interested in now. A returning character the child has gone off is not continuity.',
      '- beats are short planning notes for the narrator, not final prose.',
    ].join('\n'),
    prompt: [
      `Child: ${child.name}${child.age ? `, age ${child.age}` : ''}`,
      child.onboarding_notes ? `Parent notes: ${child.onboarding_notes}` : '',
      memory.interests.length
        ? `WHAT THIS STORY MUST BE ABOUT: ${
            memory.interests.slice().sort((a, b) => b.weight - a.weight)[0].topic
          }`
        : '',
      `Interests (weighted): ${interests || 'none recorded yet'}`,
      `Personality notes: ${memory.personality_notes || 'none yet'}`,
      `Canon characters: ${(canon.characters ?? []).join(', ') || 'none yet'}`,
      `Open threads: ${(canon.open_threads ?? []).join('; ') || 'none yet'}`,
      `Past story summaries: ${(canon.past_summaries ?? []).slice(-3).join(' | ') || 'none yet'}`,
      '',
      `Target skills for this session: ${describeTargets(targetSkills)}`,
      `Target skill ids (copy these verbatim into target_skills): ${targetSkills.join(', ')}`,
      `Skills the child is already comfortable with: ${
        comfortableSkills(mastery).join(', ') || 'none recorded yet — assume a true beginner'
      }`,
      '',
      'Produce the session plan.',
    ]
      .filter(Boolean)
      .join('\n'),
  });

  // Trust our own skill ids over the model's echo of them.
  return clampPlan({ ...object, target_skills: targetSkills } as SessionPlan);
}

/**
 * More beats for a story the child asked to keep reading.
 *
 * Cheaper and safer than replanning: the premise, characters, difficulty and
 * vocab constraints all stay exactly as they were, so continuing does not
 * silently reset the pedagogy. Only the road ahead is extended.
 */
export async function extendPlanBeats(args: {
  plan: SessionPlan;
  fromBeat: number;
  learned: string[];
}): Promise<string[]> {
  const { plan, fromBeat, learned } = args;

  try {
    const { object } = await generateObject({
      model: model.planner(),
      schema: z.object({
        beats: z.array(z.string()).min(2).max(4).describe('The next story beats, one short phrase each'),
      }),
      system: [
        'You extend a story that a young child is reading aloud and wants to continue.',
        'Produce the next few beats only — short planning notes, not prose.',
        'Hard rules:',
        '- Continue the existing story. Do not restart it or introduce a new premise.',
        '- The last beat you write should be able to end the story warmly, never on a cliffhanger.',
        '- Nothing scary, violent, or sad about family. No brand or IP content.',
      ].join('\n'),
      prompt: [
        `Premise: ${plan.premise}`,
        `Characters: ${plan.characters.join(', ')}`,
        `Beats so far: ${plan.beats.map((b, i) => `${i}. ${b}`).join(' | ')}`,
        `They have just finished beat ${fromBeat}.`,
        learned.length ? `Things the child mentioned today: ${learned.join('; ')}` : '',
        '',
        'Write the next beats.',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    return object.beats;
  } catch (err) {
    console.error('[planner] beat extension failed, using fallback beats', err);
    const hero = plan.characters[0] ?? 'our friend';
    return [`${hero} finds one more surprise`, `${hero} heads home happy`];
  }
}

/**
 * Deterministic fallback so a planner outage can never block a demo.
 *
 * It takes the child's memory because it has to: this used to be a hardcoded
 * story about a dragon and a lost bell, and the one time it fired for real it
 * handed a child who had just spent a minute telling us about cars a story about
 * a dragon. A fallback is allowed to be plain. It is not allowed to be about
 * somebody else.
 */
export function fallbackPlan(
  child: Child,
  targetSkills: string[],
  memory?: ChildMemory,
): SessionPlan {
  const topic =
    memory?.interests
      .slice()
      .sort((a, b) => b.weight - a.weight)[0]
      ?.topic?.trim() || null;

  // Practice words from the skills we are actually targeting, rather than the
  // four words that happened to suit a dragon.
  const practice = targetSkills
    .flatMap((id) => SKILL_BY_ID.get(id)?.examples ?? [])
    .filter((w) => w.length <= 6);
  const mustUse = (practice.length >= 3 ? practice : ['map', 'bell', 'friend', 'blue']).slice(0, 5);

  if (!topic) {
    return {
      goal: `practice ${targetSkills.join(', ')}`,
      target_skills: targetSkills,
      premise: `${child.name} finds a door in the garden that was never there before`,
      characters: [child.name, 'a small brave friend'],
      beats: [
        `${child.name} finds the little door`,
        'Something friendly is waiting on the other side',
        `${child.name} and the friend fix what is broken and head home happy`,
      ],
      difficulty: 2,
      vocab_constraints: {
        must_use_words: mustUse,
        max_sentence_words: 7,
        allowed_patterns: 'short vowels and simple blends only',
      },
    };
  }

  return {
    goal: `practice ${targetSkills.join(', ')}`,
    target_skills: targetSkills,
    premise: `${child.name} has a big day with ${topic}`,
    characters: [child.name, `a friend who loves ${topic}`],
    beats: [
      `${child.name} discovers something surprising about ${topic}`,
      `Something goes wrong and ${child.name} has to help`,
      `${child.name} fixes it, and the day with ${topic} ends happily`,
    ],
    difficulty: 2,
    vocab_constraints: {
      must_use_words: mustUse,
      max_sentence_words: 7,
      allowed_patterns: 'short vowels and simple blends only',
    },
  };
}
