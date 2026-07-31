/**
 * What the child told us today, and when the story is allowed to use it.
 *
 * The point of this file is the *timing*. A child who mentions a loose tooth and
 * hears about a loose tooth in the very next sentence has not been listened to;
 * they have been echoed, and it is unsettling rather than delightful. A detail
 * that surfaces two beats later, as a prop in the world rather than the subject
 * of the scene, reads as the story quietly knowing them.
 *
 * So: deterministic code decides WHICH fact is used and WHEN. The narrator only
 * decides how to work it in.
 */

import type { ChildMemory } from './types';

export type FactKind = 'interest' | 'event' | 'feeling' | 'person' | 'other';

export interface ChildFact {
  id: number;
  /** Short third-person note, e.g. "lost a tooth yesterday". */
  text: string;
  /** One or two words for the memory model, e.g. "tooth". */
  topic: string;
  kind: FactKind;
  capturedAtBeat: number;
  wovenAtBeat: number | null;
}

/** Beats between hearing something and letting it show up in the story. */
export const WEAVE_DELAY_BEATS = 2;

/** Beats between two woven details, so the story never becomes a list of facts. */
export const WEAVE_SPACING_BEATS = 2;

/**
 * Kinds that are never woven into the story.
 *
 * A feeling ("I'm bored", "I'm scared") is answered in the moment by the intent
 * router — folding it into a passage two minutes later would be tone deaf.
 */
const NEVER_WOVEN: ReadonlySet<FactKind> = new Set<FactKind>(['feeling']);

/** Most story-worthy first, when several facts are eligible at once. */
const KIND_PRIORITY: Record<FactKind, number> = {
  event: 0,
  interest: 1,
  person: 2,
  other: 3,
  feeling: 99,
};

export class FactLedger {
  private facts: ChildFact[] = [];
  private nextId = 1;

  add(input: { text: string; topic?: string | null; kind?: FactKind | null; beat: number }): ChildFact | null {
    const text = input.text.trim();
    if (!text) return null;

    // Same thing said twice (kids repeat themselves) should not become two
    // separate weaves.
    const seen = this.facts.find((f) => f.text.toLowerCase() === text.toLowerCase());
    if (seen) return seen;

    const fact: ChildFact = {
      id: this.nextId++,
      text,
      topic: (input.topic ?? '').trim() || text,
      kind: input.kind ?? 'other',
      capturedAtBeat: input.beat,
      wovenAtBeat: null,
    };
    this.facts.push(fact);
    return fact;
  }

  all(): readonly ChildFact[] {
    return this.facts;
  }

  find(id: number): ChildFact | null {
    return this.facts.find((f) => f.id === id) ?? null;
  }

  get size(): number {
    return this.facts.length;
  }

  /** Everything learned today, for the narrator's standing context. */
  summaryLines(): string[] {
    return this.facts.map((f) => f.text);
  }

  /**
   * The one detail the story may use at this beat, or null.
   *
   * Eligible means: not a feeling, not already used, heard at least
   * WEAVE_DELAY_BEATS ago, and no other detail woven in the last
   * WEAVE_SPACING_BEATS.
   */
  pickForWeaving(beat: number): ChildFact | null {
    const recentlyWoven = this.facts.some(
      (f) => f.wovenAtBeat !== null && beat - f.wovenAtBeat < WEAVE_SPACING_BEATS,
    );
    if (recentlyWoven) return null;

    const eligible = this.facts.filter(
      (f) =>
        f.wovenAtBeat === null &&
        !NEVER_WOVEN.has(f.kind) &&
        beat - f.capturedAtBeat >= WEAVE_DELAY_BEATS,
    );
    if (eligible.length === 0) return null;

    return eligible.slice().sort((a, b) => {
      const kind = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
      if (kind !== 0) return kind;
      return a.capturedAtBeat - b.capturedAtBeat; // oldest waiting first
    })[0];
  }

  markWoven(id: number, beat: number) {
    const fact = this.facts.find((f) => f.id === id);
    if (fact) fact.wovenAtBeat = beat;
  }

  /** The beat that would have carried this detail was discarded — reopen it. */
  release(id: number) {
    const fact = this.facts.find((f) => f.id === id);
    if (fact) fact.wovenAtBeat = null;
  }
}

/**
 * Fold today's facts into the persisted memory model.
 *
 * Pure so the merge is testable and so the session can hand the result straight
 * to one UPDATE. Consolidation (PLAN.md §12) still does the deeper Sonnet
 * rewrite — this only makes sure the next session's planner already knows what
 * the child said today, without anyone having to press a button.
 */
export function mergeFactsIntoMemory(
  memory: ChildMemory,
  facts: readonly ChildFact[],
  now = new Date(),
): ChildMemory {
  const ts = now.toISOString();
  const interests = memory.interests.map((i) => ({ ...i }));

  for (const fact of facts) {
    if (fact.kind !== 'interest') continue;
    const topic = fact.topic.toLowerCase().trim();
    if (!topic) continue;

    const existing = interests.find((i) => i.topic.toLowerCase() === topic);
    if (existing) {
      // Same bump consolidation uses for a mentioned interest (PLAN.md §11).
      existing.weight = Math.min(1, Math.round((existing.weight + 0.3) * 100) / 100);
      existing.last_seen = ts;
    } else {
      interests.push({ topic: fact.topic.trim(), weight: 0.6, last_seen: ts });
    }
  }

  // Events and people are not interests — they are things to bring up next time.
  // canon is JSONB, so this needs no migration.
  const canon = { ...(memory.canon ?? {}) } as ChildMemory['canon'] & {
    recent_events?: { text: string; ts: string }[];
  };
  const events = facts
    .filter((f) => f.kind === 'event' || f.kind === 'person')
    .map((f) => ({ text: f.text, ts }));

  if (events.length) {
    const existing = canon.recent_events ?? [];
    const seen = new Set(existing.map((e) => e.text.toLowerCase()));
    canon.recent_events = [...existing, ...events.filter((e) => !seen.has(e.text.toLowerCase()))]
      // Keep this from growing forever; the last handful is what a story can use.
      .slice(-8);
  }

  return { ...memory, interests, canon };
}
