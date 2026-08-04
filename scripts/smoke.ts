/**
 * Verifies every external dependency with the configured credentials.
 * Run: npm run smoke
 */
import { generateText } from 'ai';
import { pool, query, getDemoChild, schemaIsReady, describeTarget } from '../lib/db';
import { model } from '../lib/llm/client';
import { checkAzureCredentials } from '../server/azure';
import { respondToChild } from '../lib/llm/respond';
import { env } from '../lib/env';

const results: { name: string; ok: boolean; detail: string }[] = [];

const TIMEOUT_MS = 25_000;

/**
 * Every check is bounded. A blocked network (corporate proxy, firewall) makes
 * the Azure SDK hangs silently rather than erroring, so a hard timeout
 * is the difference between a diagnosable failure and a mystery.
 */
async function check(name: string, fn: () => Promise<string>) {
  process.stdout.write(`  ${name}… `);
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out after ${TIMEOUT_MS / 1000}s — the host is unreachable (firewall, proxy, or offline)`,
              ),
            ),
          TIMEOUT_MS,
        );
      }),
    ]);
    results.push({ name, ok: true, detail });
    console.log(`OK — ${detail}`);
  } catch (err) {
    const detail = String((err as Error)?.message ?? err);
    results.push({ name, ok: false, detail });
    console.log(`FAILED — ${detail}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  console.log('\nPrimer smoke test\n');

  await check(`Postgres (${describeTarget()})`, async () => {
    // Check the schema before querying it, so a fresh database reports the fix
    // rather than a raw "relation does not exist".
    const { ready, missing } = await schemaIsReady();
    if (!ready) {
      throw new Error(
        `connected, but the schema is not applied (missing: ${missing.join(', ')}) — run: npm run db:reset`,
      );
    }
    const child = await getDemoChild();
    if (!child) throw new Error('schema is present but no child is seeded — run: npm run db:seed');
    const skills = await query<{ n: number }>(
      'SELECT count(*)::int AS n FROM skill_mastery WHERE child_id = $1',
      [child.id],
    );
    return `child "${child.name}", ${skills[0].n} skills tracked`;
  });

  await check('Anthropic (Sonnet)', async () => {
    const { text } = await generateText({
      model: model.narrator(),
      prompt: 'Reply with exactly the word: ready',
    });
    return `${text.trim().slice(0, 20)}`;
  });

  await check('Anthropic (conversation responder)', async () => {
    const r = await respondToChild({
      childName: 'Maya',
      transcript: 'my dog is named Max!',
      currentPassage: 'The cat sat.',
      currentWord: 'cat',
      storyPremise: 'A cat looks for a bell',
      learned: [],
      dialogue: [],
      socraticSoFar: 0,
      socraticLimit: 3,
      source: 'off_script',
    });
    if (r.intent !== 'chitchat') throw new Error(`expected chitchat, got ${r.intent}`);
    if (!r.speakText.trim()) throw new Error('no reply text');
    return `${r.intent} -> "${r.speakText.slice(0, 48)}"`;
  });

  await check(`Azure Speech (${env.azureRegion})`, async () => {
    await checkAzureCredentials();
    return 'credentials accepted, push stream opened';
  });

  await check('OpenAI text-to-speech', async () => {
    const { checkTts } = await import('../server/tts');
    const { bytes, model } = await checkTts();
    return `${bytes} bytes (~${(bytes / 2 / 24000).toFixed(2)}s) via ${model}, voice ${env.ttsVoice}`;
  });

  await check('OpenAI Realtime ears (transcription session)', async () => {
    // Connect only. This session cannot speak and no longer detects turns —
    // `npm run realtime:check` runs a full open/commit/transcribe turn and
    // lists the transcription models this project may actually use.
    const { RealtimeVoice } = await import('../server/realtime');
    const voice = await new Promise<any>((resolve, reject) => {
      const v: any = new RealtimeVoice({
        onTranscript: () => {},
        onOpen: () => resolve(v),
        onError: (m: string) => reject(new Error(m)),
      });
      setTimeout(() => reject(new Error('no connection within 15s')), 15_000);
    });
    const model = voice.transcriptionModel;
    await voice.close();
    return `connected, transcribing with ${model}`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log('All checks passed. Run `npm run dev` and open http://localhost:3000\n');
  } else {
    console.log(`${failed.length} check(s) failed:\n`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    console.log('');
  }

  await pool.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
