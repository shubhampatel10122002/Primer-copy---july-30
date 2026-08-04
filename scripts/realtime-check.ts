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
async function testTranscriptionModels(
  candidates: string[],
  sessionModel: string,
): Promise<string[]> {
  const working: string[] = [];

  for (const model of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(sessionModel)}`,
        { headers: { Authorization: `Bearer ${env.openaiKey}` } },
      );
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
              type: 'realtime',
              output_modalities: ['text'],
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
                  transcription: { model, language: 'en' },
                },
              },
            },
          }),
        ),
      );
      ws.on('message', (data) => {
        const event = JSON.parse(data.toString());
        if (event.type === 'session.updated') finish(true);
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
  line('model', env.realtimeModel);
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
      console.log(`  Which of those open a session with model ${env.realtimeModel}:`);
      const working = await testTranscriptionModels(transcribers, env.realtimeModel);
      console.log('');

      if (working.length) {
        console.log(`  -> put this in .env.local:  OPENAI_TRANSCRIBE_MODEL=${working[0]}`);
      } else {
        // Does the SESSION model change the answer? Worth knowing before anyone
        // concludes the project has no transcription at all.
        const alternate = env.realtimeModel === 'gpt-realtime' ? 'gpt-realtime-2.1' : 'gpt-realtime';
        console.log(`  None worked. Trying the same list against ${alternate}:`);
        const other = await testTranscriptionModels(transcribers, alternate);
        console.log('');
        console.log(
          other.length
            ? `  -> the SESSION model is the problem. Put BOTH of these in .env.local:\n` +
              `        OPENAI_REALTIME_MODEL=${alternate}\n` +
              `        OPENAI_TRANSCRIBE_MODEL=${other[0]}`
            : '  -> NONE work on either session model. This is a project entitlement\n' +
              '     problem, not a code one: nothing the child says can be transcribed\n' +
              '     until the OpenAI project is granted a transcription model.',
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

  const voice = new RealtimeVoice({
    onOpen: () => {
      opened = true;
      line('socket', `open in ${Date.now() - started}ms`);
    },
    onSpeechStarted: () => line('speech_started', 'VAD fired (barge-in signal)'),
    onSpeechStopped: () => line('speech_stopped', ''),
    onUtterance: (text) => line('transcript', JSON.stringify(text)),
    onError: (m) => line('ERROR', m),
    onClose: (code, reason) => line('socket closed', `${code} ${reason}`),
  });

  // Give the session a moment to configure, then feed silence so the input
  // pipeline is exercised the same way a real session exercises it.
  await new Promise((r) => setTimeout(r, 1500));
  if (!opened) {
    console.error('\nNever connected. Check OPENAI_API_KEY and outbound access to api.openai.com.\n');
    process.exit(1);
  }

  const silence = Buffer.alloc(AUDIO.micSampleRate * 2 * 0.2); // 200ms at 16kHz
  for (let i = 0; i < 5; i++) {
    voice.write(silence);
    await new Promise((r) => setTimeout(r, 100));
  }
  line('sent', `1s of silence (upsampled to ${AUDIO.realtimeSampleRate}Hz)`);

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
