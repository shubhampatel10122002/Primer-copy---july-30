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

import { env, AUDIO } from '../lib/env';
import { RealtimeVoice, upsample16to24 } from '../server/realtime';

const verbose = process.argv.includes('--verbose');

function line(label: string, detail = '') {
  console.log(`  ${label.padEnd(28)} ${detail}`);
}

async function main() {
  console.log('\nRealtime connectivity check\n');
  line('model', env.realtimeModel);
  line('voice', env.realtimeVoice);
  line('transcription', env.transcribeModel || 'auto (falls back on model_not_found)');
  line('key', `${env.openaiKey.slice(0, 7)}…${env.openaiKey.slice(-4)}`);
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
    onAudio: (pcm) => {
      if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
      audioBytes += pcm.length;
      if (verbose) line('audio delta', `${pcm.length} bytes`);
    },
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

  // Interrupting is the thing that has to work, so prove the cancel path too.
  line('cancel test', 'speaking, then cancelling immediately');
  const doomed = voice.speak('This line should be cut off before you hear much of it.');
  setTimeout(() => doomed.cancel(), 150);
  await doomed.done;
  line('cancel', 'returned cleanly (watch for a "no active response" error above)');
  console.log('');

  const say = 'Hi there! I am Ollie, and I am ready to read with you.';
  line('speaking', JSON.stringify(say));
  const handle = voice.speak(say);

  const timeout = setTimeout(() => {
    line('TIMEOUT', 'no response.done within 20s');
    handle.cancel();
  }, 20_000);
  await handle.done;
  clearTimeout(timeout);

  const seconds = audioBytes / 2 / AUDIO.ttsSampleRate;
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
