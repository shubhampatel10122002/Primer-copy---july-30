import { NextResponse } from 'next/server';
import { query, one, getDemoChild } from '@/lib/db';
import { SKILLS } from '@/lib/skills';

export const dynamic = 'force-dynamic';

/**
 * Start over: blank the profile so the next session opens with onboarding.
 *
 * "Fresh" is keyed on the name (lib/profile.ts), so clearing it is what actually
 * triggers the conversation. Memory, notes and the prepared plan go with it —
 * they all describe a child we are about to meet again from scratch.
 *
 * `reading_events` is append-only and is never touched (CLAUDE.md). Mastery is
 * derived from those events, so it is returned to the cold-start prior and the
 * consolidation watermark is moved past everything already recorded — otherwise
 * the next consolidation would fold the old child's reading back in.
 */
export async function POST() {
  try {
    const child = await getDemoChild();
    if (!child) {
      return NextResponse.json({ error: 'No child to reset. Run `npm run db:seed`.' }, { status: 404 });
    }

    await query('UPDATE children SET name = $2, age = NULL, onboarding_notes = NULL WHERE id = $1', [
      child.id,
      '',
    ]);

    await query(
      `INSERT INTO child_memory (child_id, interests, personality_notes, canon)
       VALUES ($1, '[]', '', '{}')
       ON CONFLICT (child_id) DO UPDATE
         SET interests = '[]', personality_notes = '', canon = '{}',
             version = child_memory.version + 1, updated_at = now()`,
      [child.id],
    );

    await query('DELETE FROM next_plans WHERE child_id = $1', [child.id]);

    for (const skill of SKILLS) {
      await query(
        `INSERT INTO skill_mastery (child_id, skill_id, p_mastery, last_practiced)
         VALUES ($1, $2, 0.2, NULL)
         ON CONFLICT (child_id, skill_id) DO UPDATE SET p_mastery = 0.2, last_practiced = NULL`,
        [child.id, skill.id],
      );
    }

    const latest = await one<{ max: number | null }>(
      'SELECT MAX(id) AS max FROM reading_events WHERE child_id = $1',
      [child.id],
    );
    await query(
      `INSERT INTO consolidation_state (child_id, last_event_id, last_run_at)
       VALUES ($1, $2, now())
       ON CONFLICT (child_id) DO UPDATE SET last_event_id = EXCLUDED.last_event_id`,
      [child.id, latest?.max ?? 0],
    );

    return NextResponse.json({ ok: true, childId: child.id });
  } catch (err) {
    return NextResponse.json({ error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
