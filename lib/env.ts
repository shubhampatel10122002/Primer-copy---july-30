import 'dotenv/config';
import { config } from 'dotenv';

// Next.js loads .env.local itself; the standalone WS server and scripts do not.
config({ path: '.env.local', override: false, quiet: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env.local.`);
  return v;
}

export const env = {
  get anthropicKey() {
    return required('ANTHROPIC_API_KEY');
  },
  get azureKey() {
    return required('AZURE_SPEECH_KEY');
  },
  get azureRegion() {
    return process.env.AZURE_SPEECH_REGION || 'eastus';
  },
  get openaiKey() {
    return required('OPENAI_API_KEY');
  },
  /** alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer. */
  get ttsVoice() {
    return process.env.OPENAI_TTS_VOICE || process.env.OPENAI_REALTIME_VOICE || 'nova';
  },
  /** Pin a transcription model. Empty means walk the fallback list. */
  get transcribeModel() {
    return process.env.OPENAI_TRANSCRIBE_MODEL || '';
  },
  get databaseUrl() {
    return process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/primer';
  },
  get wsPort() {
    return Number(process.env.WS_PORT || 3001);
  },
};

/** Models. Sonnet for anything the child hears; Haiku for classification + safety. */
export const MODELS = {
  narrator: 'claude-sonnet-5',
  planner: 'claude-sonnet-5',
  consolidate: 'claude-sonnet-5',
  intent: 'claude-haiku-4-5',
  safety: 'claude-haiku-4-5',
} as const;

/**
 * Audio constants.
 *
 * The microphone is captured at 16kHz because that is what Azure's pronunciation
 * assessment wants, and scoring is the thing with the strict requirement. The
 * Realtime API wants 24kHz, so the server upsamples on the way in — cheap, and it
 * keeps the assessment path bit-for-bit what it always was.
 *
 * Playback is 24kHz PCM16 because that is what the speech endpoint returns.
 *
 * There is no half-duplex tail constant any more. It existed to keep scoring
 * shut for 300ms after playback so we could not score our own voice; the mic
 * button makes that impossible instead of merely unlikely — while Ollie is
 * speaking the microphone is closed, and no audio leaves the browser at all.
 */
export const AUDIO = {
  micSampleRate: 16000,
  realtimeSampleRate: 24000,
  ttsSampleRate: 24000,
} as const;
