/**
 * The child's profile before there is a child's profile.
 *
 * Onboarding is a conversation, not a form, so the facts arrive in whatever
 * order the child happens to mention them and often not at all. This file holds
 * the accumulating draft and the rule for when there is enough to start telling
 * a story. The LLM proposes; this decides.
 */

import type { Child, ChildMemory } from './types';

export interface OnboardingDraft {
  name: string | null;
  age: number | null;
  interests: string[];
  /** Anything else worth telling the story planner, one short note per line. */
  notes: string[];
}

/** What the onboarding agent claims it learned in one turn. */
export interface OnboardingLearned {
  name?: string | null;
  age?: number | null;
  interests?: string[] | null;
  note?: string | null;
}

export const MAX_INTERESTS = 6;

export function emptyDraft(): OnboardingDraft {
  return { name: null, age: null, interests: [], notes: [] };
}

/** Model output is not trusted to be clean — a name is one or two words, not a sentence. */
function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[^\p{L}\p{M}'’\- ]/gu, '');
  if (!s) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 2) return null;
  const name = words.join(' ');
  if (name.length > 24) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function cleanTopic(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s || s.length > 40) return null;
  return s;
}

export function mergeDraft(draft: OnboardingDraft, learned: OnboardingLearned): OnboardingDraft {
  const next: OnboardingDraft = {
    name: draft.name,
    age: draft.age,
    interests: [...draft.interests],
    notes: [...draft.notes],
  };

  // First name heard wins. A child who says "I'm Maya" and later mentions their
  // sister Ada should not be renamed Ada.
  const name = cleanName(learned.name);
  if (name && !next.name) next.name = name;

  if (typeof learned.age === 'number' && Number.isFinite(learned.age)) {
    const age = Math.round(learned.age);
    if (age >= 2 && age <= 12) next.age = age;
  }

  for (const raw of learned.interests ?? []) {
    const topic = cleanTopic(raw);
    if (!topic) continue;
    if (next.interests.some((i) => i.toLowerCase() === topic)) continue;
    if (next.interests.length >= MAX_INTERESTS) break;
    next.interests.push(topic);
  }

  const note = learned.note?.trim();
  if (note && !next.notes.includes(note)) next.notes.push(note);

  return next;
}

/**
 * Enough to start a story: a name and at least one thing they like.
 *
 * The name is non-negotiable — every template line and the whole premise are
 * built around it. One interest is what separates "a story" from "a story for
 * you"; more than that is a bonus, not a requirement, because a shy child should
 * not be interviewed until they produce three.
 */
export function hasEnoughToStart(draft: OnboardingDraft): boolean {
  return Boolean(draft.name) && draft.interests.length >= 1;
}

/** A name alone is enough to fall back to when a child stops answering. */
export function canStartAtAll(draft: OnboardingDraft): boolean {
  return Boolean(draft.name);
}

const PLACEHOLDER_NAMES = new Set(['', 'friend', 'child', 'new child', 'unknown', 'reader']);

/**
 * Does this profile need onboarding?
 *
 * Keyed on the name, because that is what "reset the profile" clears and what
 * onboarding is guaranteed to produce. A returning child whose memory has not
 * been consolidated yet still has a name, and must not be interviewed again.
 */
export function isFreshProfile(child: Pick<Child, 'name'>, _memory?: ChildMemory): boolean {
  return PLACEHOLDER_NAMES.has((child.name ?? '').trim().toLowerCase());
}

/** The draft as the free-text notes the planner and narrator already read. */
export function draftToNotes(draft: OnboardingDraft): string {
  const parts: string[] = [];
  if (draft.interests.length) parts.push(`Loves ${draft.interests.join(', ')}.`);
  parts.push(...draft.notes);
  return parts.join(' ').trim();
}

/** The draft as memory-model interests, newest first at a confident weight. */
export function draftToInterests(
  draft: OnboardingDraft,
  now = new Date(),
): { topic: string; weight: number; last_seen: string }[] {
  const ts = now.toISOString();
  return draft.interests.map((topic, i) => ({
    topic,
    // The first thing a child volunteers is the thing they care about most.
    weight: Math.max(0.6, Number((1 - i * 0.1).toFixed(2))),
    last_seen: ts,
  }));
}
