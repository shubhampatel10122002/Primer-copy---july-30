import { pool, query, one, waitForPostgres, schemaIsReady, describeTarget } from '../lib/db';
import { SKILLS } from '../lib/skills';

/**
 * Seeds one child row, a cold-start mastery profile, and memory.
 *
 * By default the profile is EMPTY: no name, no interests, no canon. That is what
 * makes the app open with onboarding (lib/profile.ts treats a blank name as a
 * profile that has never been filled in), which is the first thing a new user
 * should meet.
 *
 * The old pre-filled demo child is still one env var away:
 *
 *     SEED_CHILD_NAME=Maya npm run db:seed
 */
async function main() {
  await waitForPostgres();

  const { ready, missing } = await schemaIsReady();
  if (!ready) {
    throw new Error(
      `Cannot seed — the schema is not applied to ${describeTarget()}.\n` +
        `Missing tables: ${missing.join(', ')}\n\nRun: npm run db:migrate\n`,
    );
  }

  const name = process.env.SEED_CHILD_NAME ?? '';
  const preFilled = name.trim().length > 0;
  const age = preFilled ? Number(process.env.SEED_CHILD_AGE || 5) : null;
  const notes = preFilled
    ? process.env.SEED_CHILD_NOTES ||
      'Loves dragons and building things. Has a cat named Pepper and a big brother, Sam. Gets shy when she makes a mistake.'
    : null;

  let child = await one<{ id: string }>('SELECT id FROM children ORDER BY name LIMIT 1');
  if (!child) {
    child = await one<{ id: string }>(
      'INSERT INTO children (name, age, onboarding_notes) VALUES ($1,$2,$3) RETURNING id',
      [name, age, notes],
    );
    console.log(
      preFilled
        ? `Created child ${name} (${child!.id})`
        : `Created an empty profile (${child!.id}) — the first session will start with onboarding.`,
    );
  } else {
    await query('UPDATE children SET name=$2, age=$3, onboarding_notes=$4 WHERE id=$1', [
      child.id,
      name,
      age,
      notes,
    ]);
    console.log(
      preFilled ? `Child ${name} already exists (${child.id})` : `Reset the profile (${child.id}).`,
    );
  }

  const childId = child!.id;

  // Cold-start mastery: everything at the 0.2 prior, a couple of easy wins
  // pre-seeded so pickTargets has prerequisites to work with on day one.
  const warm = new Set(['short_a', 'short_i', 'sight_the', 'sight_and']);
  for (const skill of SKILLS) {
    await query(
      `INSERT INTO skill_mastery (child_id, skill_id, p_mastery, last_practiced)
       VALUES ($1,$2,$3,NULL)
       ON CONFLICT (child_id, skill_id) DO NOTHING`,
      [childId, skill.id, warm.has(skill.id) ? 0.75 : 0.2],
    );
  }
  console.log(`Seeded ${SKILLS.length} skills.`);

  // An empty profile gets empty memory — onboarding fills it in from the child's
  // own words, which is the whole point.
  const memory = preFilled
    ? {
        interests: [
          { topic: 'dragons', weight: 1.0, last_seen: new Date().toISOString() },
          { topic: 'building things', weight: 0.8, last_seen: new Date().toISOString() },
          { topic: 'cats', weight: 0.6, last_seen: new Date().toISOString() },
        ],
        personality:
          'Enjoys stories with a brave animal friend. Quiet when unsure — responds well to being offered a choice.',
        canon: {
          characters: ['Blue the dragon'],
          past_summaries: [],
          open_threads: ['Blue lost his bell somewhere in the garden'],
        },
      }
    : { interests: [], personality: '', canon: {} };

  await query(
    `INSERT INTO child_memory (child_id, interests, personality_notes, canon)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (child_id) DO UPDATE
       SET interests = EXCLUDED.interests,
           personality_notes = EXCLUDED.personality_notes,
           canon = EXCLUDED.canon,
           updated_at = now()`,
    [
      childId,
      JSON.stringify(memory.interests),
      memory.personality,
      JSON.stringify(memory.canon),
    ],
  );

  // A plan prepared for a previous profile would pre-empt onboarding entirely.
  await query('DELETE FROM next_plans WHERE child_id = $1', [childId]);

  await query(
    `INSERT INTO consolidation_state (child_id, last_event_id) VALUES ($1, 0)
     ON CONFLICT (child_id) DO NOTHING`,
    [childId],
  );

  console.log('Seed complete.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(`\nSeed failed: ${err?.message ?? err}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
