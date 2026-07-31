import { generateObject } from 'ai';
import { z } from 'zod';
import { model } from './client';
import type { ChildMemory, Child, TranscriptEntry } from '../types';

const schema = z.object({
  interests: z.array(
    z.object({
      topic: z.string(),
      weight: z.number().min(0).max(5),
      last_seen: z.string().describe('ISO date'),
    }),
  ),
  personality_notes: z
    .string()
    .describe('Evidence-based only. Cite the behavior, not a guess about the child.'),
  canon: z.object({
    characters: z.array(z.string()),
    past_summaries: z.array(z.string()),
    open_threads: z.array(z.string()),
  }),
});

export async function consolidateMemory(args: {
  child: Child;
  current: ChildMemory;
  transcript: TranscriptEntry[];
  interestSignals: string[];
}): Promise<ChildMemory> {
  const { child, current, transcript, interestSignals } = args;

  const transcriptText = transcript
    .map((e) => `[${e.kind}] ${e.text}`)
    .join('\n')
    .slice(0, 20_000);

  const { object } = await generateObject({
    model: model.consolidate(),
    schema,
    system: [
      "Update this child profile from today's session.",
      'Add new interests mentioned, decay stale ones, update canon with story events and open threads,',
      'and revise personality notes ONLY with evidence from the transcript.',
      '',
      'Rules:',
      '- Interest weights: existing interests have already been decayed by 0.9. Add +0.3 to any topic the child brought up today, and add new topics at 0.5. Cap at 5.',
      '- Things the child volunteered in talk mode are the strongest interest signal.',
      '- personality_notes must be observable and specific ("keeps going after a hard word instead of asking for help"), never a diagnosis or a label.',
      '- past_summaries: append one short sentence summarizing today. Keep at most 8 entries, newest last.',
      '- open_threads: what is unresolved and worth picking up next time.',
      '- characters: recurring characters the child now knows.',
      '- canon.recent_events lists things the child said about their own life. Use them as',
      '  evidence, and promote anything still live ("birthday on Saturday") to an open thread.',
    ].join('\n'),
    prompt: [
      `Child: ${child.name}${child.age ? `, age ${child.age}` : ''}`,
      '',
      '# Current memory (interests already decayed by 0.9)',
      JSON.stringify(current, null, 2),
      '',
      '# Interest signals detected during the session (talk mode chitchat)',
      interestSignals.join(', ') || 'none',
      '',
      "# Today's session transcript",
      transcriptText || '(empty session)',
    ].join('\n'),
  });

  // The schema deliberately does not expose recent_events for rewriting — they
  // are things the child actually said, not something to be paraphrased. Carry
  // them through by hand so consolidation cannot quietly erase them.
  return {
    ...(object as ChildMemory),
    canon: {
      ...object.canon,
      ...(current.canon?.recent_events?.length
        ? { recent_events: current.canon.recent_events.slice(-8) }
        : {}),
    },
  };
}

/** Field-level diff for the debug panel. "Watch it learn her." PLAN.md §12 step 6. */
export function diffMemory(before: ChildMemory, after: ChildMemory) {
  const beforeInterests = new Map(before.interests.map((i) => [i.topic, i.weight]));
  const afterInterests = new Map(after.interests.map((i) => [i.topic, i.weight]));

  const interestChanges: { topic: string; from: number | null; to: number | null }[] = [];
  for (const [topic, to] of afterInterests) {
    const from = beforeInterests.get(topic) ?? null;
    if (from !== to) interestChanges.push({ topic, from, to });
  }
  for (const [topic, from] of beforeInterests) {
    if (!afterInterests.has(topic)) interestChanges.push({ topic, from, to: null });
  }

  const arrDiff = (a: string[] = [], b: string[] = []) => ({
    added: b.filter((x) => !a.includes(x)),
    removed: a.filter((x) => !b.includes(x)),
  });

  return {
    interests: interestChanges,
    personality_notes: {
      from: before.personality_notes ?? '',
      to: after.personality_notes ?? '',
      changed: (before.personality_notes ?? '') !== (after.personality_notes ?? ''),
    },
    canon: {
      characters: arrDiff(before.canon?.characters, after.canon?.characters),
      open_threads: arrDiff(before.canon?.open_threads, after.canon?.open_threads),
      past_summaries: arrDiff(before.canon?.past_summaries, after.canon?.past_summaries),
    },
  };
}
