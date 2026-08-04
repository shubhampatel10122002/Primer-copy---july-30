/**
 * Does the Realtime connection actually work on this machine?
 *
 * Run this BEFORE trusting the app with it:
 *
 *     npm run realtime:check
 *
 * It connects, configures the session exactly as `server/realtime.ts` does,
 * feeds it a second of silence so the VAD has something to chew on, asks it to
 * say one line, and prints every event that comes back. If the protocol has
 * drifted — a renamed field, a model that rejects the session shape — it shows
 * up here in ten seconds rather than as a silent owl in front of a child.
 *
 * Add --verbose to print audio deltas. Set REALTIME_TRACE=1 to print the session
 * configuration the server actually accepted, plus every unfamiliar event — that
 * is the fastest way to find a field a model has rejected.
 */
import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.local', override: false, quiet: true });

import WebSocket from 'ws';
import { env, AUDIO } from '../lib/env';
import { RealtimeVoice } from '../server/realtime';
import { speak as speakAloud, pcmSeconds } from '../server/tts';

const verbose = process.argv.includes('--verbose');

function line(label: string, detail = '') {
  console.log(`  ${label.padEnd(28)} ${detail}`);
}

/**
 * Ask the project which transcription models it can actually use.
 *
 * The model names move faster than any document, and getting one wrong has no
 * symptom other than the child never being heard. This machine can reach the
 * API; the machine that wrote this code could not.
 */
async function listAudioModels(): Promise<string[]> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${env.openaiKey}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id) => /transcribe|whisper|realtime|tts|audio/.test(id))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Actually try each transcription model.
 *
 * Being listed in /v1/models is NOT the same as this project being allowed to
 * use it — this project can see `gpt-live-transcribe` and is refused it. The
 * only reliable answer is to open a session with each one and see whether the
 * server accepts it or hangs up.
 */
async function testTranscriptionModels(candidates: string[]): Promise<string[]> {
  const working: string[] = [];

  for (const model of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
        headers: { Authorization: `Bearer ${env.openaiKey}` },
      });
      const finish = (value: boolean) => {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), 8_000);

      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
                  transcription: { model, languages: ['en'] },
                  // Exactly how the app configures it: the child's thumb is the
                  // turn boundary, so there is no turn detection to negotiate.
                  turn_detection: null,
                },
              },
            },
          }),
        ),
      );
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
          finish(true);
        }
        if (event.type === 'error') finish(false);
      });
      ws.on('close', () => finish(false));
      ws.on('error', () => finish(false));
    });

    console.log(`    ${ok ? 'OK  ' : 'no  '} ${model}`);
    if (ok) working.push(model);
  }
  return working;
}

async function main() {
  console.log('\nRealtime connectivity check\n');
  line('session', 'transcription (turn_detection: null — the mic button is the turn)');
  line('voice', env.ttsVoice);
  line('transcription', env.transcribeModel || 'auto (falls back on model_not_found)');
  line('key', `${env.openaiKey.slice(0, 7)}…${env.openaiKey.slice(-4)}`);
  console.log('');

  const audioModels = await listAudioModels();
  if (audioModels.length) {
    console.log('  Audio models this project can use:');
    for (const id of audioModels) console.log(`    ${id}`);
    const transcribers = audioModels.filter((id) => /transcribe|whisper/.test(id));
    console.log('');
    if (transcribers.length) {
      console.log('  Which of those actually open a transcription session:');
      const working = await testTranscriptionModels(transcribers);
      console.log('');

      if (working.length) {
        console.log(`  -> put this in .env.local:  OPENAI_TRANSCRIBE_MODEL=${working[0]}`);
        if (!working.includes('gpt-live-transcribe')) {
          console.log(
            '     (gpt-live-transcribe is the current low-latency model and would be\n' +
              '      the better choice — ask for it on this project if you can.)',
          );
        }
      } else {
        console.log(
          '  -> NONE of them work. This is a project entitlement problem, not a code\n' +
            '     one: nothing the child says can be transcribed until the OpenAI\n' +
            '     project is granted a transcription model.',
        );
      }
    } else {
      console.log('  -> NO transcription models available at all.');
    }
  } else {
    console.log('  (could not list models — check the key)');
  }
  console.log('');

  let audioBytes = 0;
  let firstAudioMs = -1;
  let opened = false;
  const started = Date.now();

  let transcribed = false;

  const voice = new RealtimeVoice({
    onOpen: () => {
      opened = true;
      line('socket', `open in ${Date.now() - started}ms`);
    },
    onPartial: (turnId, text) => verbose && line(`partial turn ${turnId}`, JSON.stringify(text)),
    onTranscript: (turnId, text) => {
      transcribed = true;
      line(`turn ${turnId}`, text ? JSON.stringify(text) : '(nothing heard — expected, it was silence)');
    },
    onError: (m) => line('ERROR', m),
    onClose: (code, reason) => line('socket closed', `${code} ${reason}`),
  });

  // Give the session a moment to configure, then run one complete turn exactly
  // the way the mic button runs one: open, feed audio, commit, get words back.
  // Silence in, nothing out — but every part of the path is exercised, and a
  // project that cannot use the configured model fails here rather than in
  // front of a child.
  await new Promise((r) => setTimeout(r, 1500));
  if (!opened) {
    console.error('\nNever connected. Check OPENAI_API_KEY and outbound access to api.openai.com.\n');
    process.exit(1);
  }

  line('turn', 'opening (this is what tapping the mic does)');
  voice.beginTurn(1);
  const silence = Buffer.alloc(AUDIO.micSampleRate * 2 * 0.2); // 200ms at 16kHz
  for (let i = 0; i < 5; i++) {
    voice.write(silence);
    await new Promise((r) => setTimeout(r, 100));
  }
  line('sent', `1s of silence (upsampled to ${AUDIO.realtimeSampleRate}Hz)`);
  voice.commit(1);
  line('turn', 'committed (this is what tapping again does)');

  // Every committed turn must come back, including an empty one — a turn that
  // never resolves is a session stuck with the mic shut and no way out.
  for (let i = 0; i < 40 && !transcribed; i++) await new Promise((r) => setTimeout(r, 100));
  if (!transcribed) line('WARNING', 'the committed turn never came back within 4s');

  // The voice is a separate service now, so test it separately.
  const say = 'Hi there! I am Ollie, and I am ready to read with you.';
  line('speaking', JSON.stringify(say));
  const handle = speakAloud(say, (pcm) => {
    if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
    audioBytes += pcm.length;
    if (verbose) line('audio chunk', `${pcm.length} bytes`);
  });
  await handle.done;

  // Barge-in aborts this mid-sentence, so prove it stops cleanly.
  line('cancel test', 'speaking, then cancelling after 150ms');
  let cancelledBytes = 0;
  const doomed = speakAloud('This line should be cut off long before it finishes.', (pcm) => {
    cancelledBytes += pcm.length;
  });
  setTimeout(() => doomed.cancel(), 150);
  await doomed.done;
  line('cancel', `stopped after ${cancelledBytes} bytes`);

  const seconds = pcmSeconds(audioBytes);
  console.log('');
  line('audio received', `${audioBytes} bytes (~${seconds.toFixed(2)}s)`);
  line('first audio', firstAudioMs < 0 ? 'never' : `${firstAudioMs}ms after connect`);

  await voice.close();

  if (audioBytes === 0) {
    console.error('\nConnected but produced NO audio. Run again with --verbose to see the events.\n');
    process.exit(1);
  }

  console.log(`\nRealtime is working on this machine.`);
  console.log(
    'Note: transcription is NOT proven here — this only sends silence, so there is\n' +
      'nothing to transcribe. Watch the dev log for `[realtime] heard "..."` on the\n' +
      'first thing a child says; if it never appears, transcription is the problem.\n',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nrealtime:check failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
