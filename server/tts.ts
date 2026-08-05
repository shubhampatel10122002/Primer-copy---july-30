import { env, AUDIO } from '../lib/env';

/**
 * The voice. A text-to-speech endpoint, not a conversational model.
 *
 * Narration used to be `response.create` on the Realtime session with
 * "read this aloud, word for word" in the instructions. That is asking a chat
 * model to behave like a mouth, and it does not reliably: it read back what the
 * child had just said instead of the line it was given. A model that is deciding
 * anything is a model that can decide wrong, and the things it voices here —
 * the passages, the coaching lines, the fixed comfort template that PLAN.md §5
 * says must never be improvised — are all written elsewhere on purpose.
 *
 * So the voice is now a TTS endpoint. It has no conversation, no context, and no
 * opinion. You give it a string and it returns that string as sound.
 */

const SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/** Tried in order; a project without access to the first falls through. */
const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1'];

export interface SpeakHandle {
  /** Resolves when the utterance has finished streaming (or was cancelled). */
  done: Promise<void>;
  cancel: () => void;
}

let workingModel: string | null = null;

/**
 * Speak `text`, streaming 24kHz mono PCM16 to `onChunk` as it arrives.
 *
 * Cancellable mid-sentence: `cancel()` aborts the HTTP request, so a barge-in
 * stops the audio at the network as well as at the speaker.
 */
export function speak(text: string, onChunk: (pcm: Buffer) => void): SpeakHandle {
  const controller = new AbortController();
  let cancelled = false;

  const done = (async () => {
    const candidates = workingModel ? [workingModel] : TTS_MODELS;

    for (const model of candidates) {
      try {
        const res = await fetch(SPEECH_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${env.openaiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            voice: env.ttsVoice,
            input: text,
            // Raw PCM: 24kHz, 16-bit, mono, little-endian. No container to strip
            // and nothing to decode before it can be played.
            response_format: 'pcm',
            speed: 0.95,
            ...(model.startsWith('gpt-')
              ? {
                  instructions:
                    'Warm, playful and unhurried, like reading a picture book aloud to a ' +
                    'five-year-old. Gentle energy, clear consonants, never rushed.',
                }
              : {}),
          }),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          // A model this project cannot use: try the next one rather than
          // leaving the child in silence.
          if (res.status === 403 || res.status === 404 || /model/i.test(body)) {
            console.warn(`[tts] ${model} unavailable (${res.status}) — trying the next`);
            continue;
          }
          throw new Error(`${res.status} ${body.slice(0, 200)}`);
        }

        // Say WHICH voice this is, once. The models differ audibly, and "the
        // voice does not sound clean" has two very different causes: something
        // wrong with the audio path, or a silent fall through to the older and
        // rougher model because the first one was refused. One log line
        // separates them without anyone having to guess.
        if (workingModel !== model) {
          workingModel = model;
          console.log(`[tts] speaking with ${model} (voice: ${env.ttsVoice})`);
        }
        if (!res.body) throw new Error('no response body');

        // PCM16 is TWO bytes per sample, and the network does not care.
        //
        // A chunk with an odd byte count leaves half a sample dangling. Emit it
        // as-is and the receiver pairs the bytes off by one from there on — every
        // subsequent sample built from the low byte of one and the high byte of
        // the next. That is not a glitch, it is white noise: the "bad radio
        // signal" hiss over the whole voice. So the odd byte is carried into the
        // next chunk and every buffer that leaves here is sample-aligned.
        const reader = res.body.getReader();
        let carry: Buffer | null = null;

        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished || cancelled) break;
          if (!value?.length) continue;

          let chunk: Buffer = carry ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
          carry = null;

          if (chunk.length % 2 === 1) {
            carry = chunk.subarray(chunk.length - 1);
            chunk = chunk.subarray(0, chunk.length - 1);
          }
          if (chunk.length) onChunk(chunk);
        }
        return;
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        console.error(`[tts] ${model} failed`, err);
      }
    }

    if (!cancelled) console.error(`[tts] every model failed for "${text.slice(0, 40)}…"`);
  })();

  return {
    done,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
    },
  };
}

/** One-shot check used by scripts/smoke.ts and realtime:check. */
export async function checkTts(): Promise<{ bytes: number; model: string }> {
  let bytes = 0;
  await speak('Ready.', (pcm) => {
    bytes += pcm.length;
  }).done;
  if (bytes === 0) throw new Error('no audio produced');
  return { bytes, model: workingModel ?? 'unknown' };
}

/** Seconds of audio in a PCM16 byte count, for logging. */
export function pcmSeconds(bytes: number): number {
  return bytes / 2 / AUDIO.ttsSampleRate;
}
