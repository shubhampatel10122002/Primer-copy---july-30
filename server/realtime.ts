import WebSocket from 'ws';
import { env, AUDIO } from '../lib/env';

/**
 * The voice and the ears, on one connection.
 *
 * This replaces two things that used to be separate and separately imperfect:
 * an always-on Azure recognizer that told us what the child said, and Cartesia,
 * which said things back. The problem was never either of them individually —
 * it was that nothing in that arrangement knew the child had started talking
 * until a transcript arrived, which is far too late to stop a sentence.
 *
 * The Realtime API detects speech itself, in the audio, and says so
 * (`input_audio_buffer.speech_started`) within a couple of hundred milliseconds
 * of the first syllable. That single event is why we are here: barge-in stops
 * being something we infer and becomes something we are told.
 *
 * What has NOT moved: pronunciation assessment. Azure still scores every
 * passage, because no general-purpose speech model returns per-phoneme accuracy
 * for a five-year-old reading "bridge". The two run on the same audio.
 */

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

export interface RealtimeCallbacks {
  /** The child started speaking. Fires from server VAD, not from a transcript. */
  onSpeechStarted: () => void;
  /** The child stopped speaking. */
  onSpeechStopped?: () => void;
  /** A complete utterance from the child, transcribed. */
  onUtterance: (text: string) => void;
  /** Audio to play, 24kHz mono PCM16. */
  onAudio: (pcm: Buffer) => void;
  onError?: (message: string) => void;
  /** The connection came up or went down. */
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}

export interface SpeakHandle {
  /** Resolves when the utterance has finished generating (or was cancelled). */
  done: Promise<void>;
  cancel: () => void;
}

/** Upsample 16kHz PCM16 to the 24kHz PCM16 the Realtime API expects. */
export function upsample16to24(pcm16k: Buffer): Buffer {
  const inSamples = pcm16k.length >> 1;
  if (inSamples === 0) return Buffer.alloc(0);

  const outSamples = Math.floor((inSamples * AUDIO.realtimeSampleRate) / AUDIO.micSampleRate);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = AUDIO.micSampleRate / AUDIO.realtimeSampleRate; // 2/3

  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm16k.readInt16LE(Math.min(idx, inSamples - 1) * 2);
    const b = pcm16k.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}

export class RealtimeVoice {
  private ws: WebSocket;
  private ready = false;
  private closed = false;
  /** Audio buffered until the session is configured. */
  private pending: Buffer[] = [];

  /** The response currently being spoken, if any. */
  private active: {
    id: string | null;
    resolve: () => void;
    cancelled: boolean;
  } | null = null;

  private partialTranscript = '';

  constructor(private cb: RealtimeCallbacks) {
    this.ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(env.realtimeModel)}`, {
      headers: { Authorization: `Bearer ${env.openaiKey}` },
    });

    this.ws.on('open', () => {
      this.configure();
      this.cb.onOpen?.();
    });

    this.ws.on('message', (data) => {
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handle(event);
    });

    this.ws.on('error', (err) => this.cb.onError?.(`realtime socket: ${String(err)}`));
    this.ws.on('close', (code, reason) => {
      this.ready = false;
      this.cb.onClose?.(code, reason.toString());
    });
  }

  private send(event: Record<string, unknown>) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(event));
  }

  /**
   * Configure the session.
   *
   * `create_response: false` is the single most important line in this file. The
   * model would otherwise reply to everything it hears — including a child
   * reading their passage out loud, which it would treat as being talked to. We
   * want its ears and its voice, not its judgment about when to use them: what
   * counts as reading, what needs an answer, and what happens next are decided by
   * the state machine, exactly as before.
   */
  private configure() {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions:
          'You are Ollie, a warm, playful owl who reads stories with young children. ' +
          'You will be told exactly what to say. Say it warmly and clearly, at an unhurried ' +
          'pace, as if reading a picture book aloud to a five-year-old.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
            transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
            // Laptop speakers and a laptop microphone in the same room.
            noise_reduction: { type: 'far_field' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              // Children pause mid-sentence constantly. This is the "have they
              // finished?" window, and it is deliberately longer than the default.
              silence_duration_ms: 900,
              // We decide when to reply. See above.
              create_response: false,
              // But DO stop talking the moment they start.
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
            voice: env.realtimeVoice,
            speed: 0.95,
          },
        },
      },
    });
  }

  private handle(event: any) {
    switch (event.type) {
      case 'session.created':
        break;

      case 'session.updated': {
        if (this.ready) break;
        this.ready = true;
        // Anything captured while we were connecting still belongs to the child.
        for (const chunk of this.pending) this.appendAudio(chunk);
        this.pending = [];
        break;
      }

      // The whole reason for this integration: speech detected in the audio
      // itself, before any transcription has happened.
      case 'input_audio_buffer.speech_started':
        this.cb.onSpeechStarted();
        break;

      case 'input_audio_buffer.speech_stopped':
        this.cb.onSpeechStopped?.();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) this.partialTranscript += event.delta;
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? this.partialTranscript ?? '').trim();
        this.partialTranscript = '';
        if (text) this.cb.onUtterance(text);
        break;
      }

      case 'conversation.item.input_audio_transcription.failed':
        this.partialTranscript = '';
        break;

      // Audio out. The event name changed across model versions; accept both.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (this.active?.cancelled) break;
        if (typeof event.delta === 'string') {
          this.cb.onAudio(Buffer.from(event.delta, 'base64'));
        }
        break;
      }

      case 'response.created':
        if (this.active && !this.active.id) this.active.id = event.response?.id ?? null;
        break;

      case 'response.done': {
        const done = this.active;
        this.active = null;
        done?.resolve();
        break;
      }

      case 'error':
        this.cb.onError?.(`realtime: ${event.error?.message ?? JSON.stringify(event.error)}`);
        // An error usually kills the in-flight response; do not hang on it.
        if (this.active) {
          const done = this.active;
          this.active = null;
          done.resolve();
        }
        break;

      default:
        break;
    }
  }

  /** Mic audio, 16kHz PCM16 as captured. Upsampled here. */
  write(pcm16k: Buffer) {
    if (this.closed) return;
    const pcm24k = upsample16to24(pcm16k);
    if (pcm24k.length === 0) return;
    if (!this.ready) {
      // Bounded: a couple of seconds is plenty to cover session setup.
      if (this.pending.length < 60) this.pending.push(pcm24k);
      return;
    }
    this.appendAudio(pcm24k);
  }

  private appendAudio(pcm24k: Buffer) {
    this.send({ type: 'input_audio_buffer.append', audio: pcm24k.toString('base64') });
  }

  /**
   * Say exactly this.
   *
   * The story, the passages, the coaching lines and the fixed comfort template
   * are all written elsewhere — by the narrator on Sonnet, or by hand — and this
   * only voices them. So the instruction is verbatim-or-nothing: the model is a
   * mouth here, not an author.
   */
  speak(text: string): SpeakHandle {
    if (this.closed || !text.trim()) {
      return { done: Promise.resolve(), cancel: () => {} };
    }

    // One utterance at a time. The caller serialises, but a barge-in can land
    // between the two, so make it safe here too.
    this.cancelActive();

    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const entry = { id: null as string | null, resolve, cancelled: false };
    this.active = entry;

    this.send({
      type: 'response.create',
      response: {
        // Out of band: this is narration we wrote, not the model's turn in a
        // conversation, and it must not accumulate as "things I decided to say".
        conversation: 'none',
        output_modalities: ['audio'],
        instructions: [
          'Read the following aloud, word for word, exactly as written.',
          'Do not add anything. Do not greet. Do not comment. Do not paraphrase.',
          'Do not read this instruction aloud.',
          '',
          text,
        ].join('\n'),
      },
    });

    return {
      done,
      cancel: () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        if (this.active === entry) this.active = null;
        this.send({ type: 'response.cancel' });
        resolve();
      },
    };
  }

  private cancelActive() {
    if (!this.active) return;
    const entry = this.active;
    this.active = null;
    entry.cancelled = true;
    this.send({ type: 'response.cancel' });
    entry.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelActive();
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
