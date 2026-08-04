import WebSocket from 'ws';
import { env, AUDIO } from '../lib/env';

/**
 * The ears. Not the voice.
 *
 * We are here for exactly one event: `input_audio_buffer.speech_started`, which
 * server-side VAD emits from the audio itself within a couple of hundred
 * milliseconds of the child's first syllable. Every design before this had to
 * infer "they have started talking" from a transcript, which arrives a second
 * late — long enough that the narrator had finished its sentence anyway.
 *
 * This session cannot speak, structurally: `output_modalities: ['text']` means
 * it has no audio to emit even if something asked it to, and
 * `create_response: false` means nothing asks. Narration goes through
 * `server/tts.ts`, which is a text-to-speech endpoint with no conversation and
 * no opinion — because when this file WAS the voice, it once read back what the
 * child had just said instead of the line it was handed.
 *
 * Pronunciation assessment stays on Azure, on the same audio: no general-purpose
 * speech model returns per-phoneme accuracy for a five-year-old reading
 * "bridge".
 */

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * Transcription models to try, best first.
 *
 * Which of these a project may use varies, and getting it wrong has no symptom
 * other than the child never being heard — ours was refused
 * `gpt-4o-mini-transcribe` outright ("Project does not have access to model").
 * So this is a list that gets walked on `model_not_found`, not one name we hope
 * is right.
 *
 * The names move faster than any document. `npm run realtime:check` asks your
 * project directly which ones it has and prints them; pin one with
 * OPENAI_TRANSCRIBE_MODEL if you want to stop guessing entirely.
 */
const TRANSCRIBE_MODELS = [
  // Least likely to be refused first. Being listed in /v1/models is NOT the same
  // as the project being allowed to use it — this project can see
  // gpt-live-transcribe and gpt-4o-mini-transcribe and is refused both.
  'whisper-1',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-realtime-whisper',
  'gpt-live-transcribe',
] as const;

export interface RealtimeCallbacks {
  /** The child started speaking. Fires from server VAD, not from a transcript. */
  onSpeechStarted: () => void;
  /** The child stopped speaking. */
  onSpeechStopped?: () => void;
  /** A complete utterance from the child, transcribed. */
  onUtterance: (text: string) => void;
  onError?: (message: string) => void;
  /** The connection came up or went down. */
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
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
  private ws!: WebSocket;
  private ready = false;
  private closed = false;
  /** Fatal errors reach the UI; benign races only reach the log. */
  private seenEventTypes = new Set<string>();

  private partialTranscript = '';
  private configureAttempts = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  /** Events asked for before the socket opened. */
  private outbox: string[] = [];
  /** Transcription models to try, in order, as the project allows them. */
  private transcribeModels: string[] = env.transcribeModel
    ? [env.transcribeModel]
    : [...TRANSCRIBE_MODELS];
  /** Set once every candidate has been refused. VAD still works without it. */
  private transcriptionDisabled = false;

  constructor(private cb: RealtimeCallbacks) {
    this.connect();
  }

  /**
   * Open the socket. Called again when a transcription model is refused.
   *
   * A model the project cannot use does not fail politely — the server closes
   * the whole connection (1001) with the refusal as the reason. So walking the
   * list on a per-item transcription failure never got a chance to run; the
   * session was already gone. Reconnecting is the only way down the list.
   */
  private connect() {
    this.ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(env.realtimeModel)}`, {
      headers: { Authorization: `Bearer ${env.openaiKey}` },
    });

    this.ws.on('open', () => {
      // Configure FIRST, then release anything that was asked for while we were
      // still connecting — order matters, the session has to exist before a
      // response can be created in it.
      this.configure();
      const queued = this.outbox.splice(0, this.outbox.length);
      for (const data of queued) this.ws.send(data);
      if (queued.length) console.log(`[realtime] session ready (${queued.length} message(s) queued during setup)`);
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

    this.ws.on('error', (err) => {
      // A refused model surfaces here as well as on close; the close handler
      // owns the recovery, so do not shout about it twice.
      const message = String(err);
      if (this.refusedModel(message)) return;
      this.cb.onError?.(`realtime socket: ${message}`);
    });

    this.ws.on('close', (code, reason) => {
      this.ready = false;
      const why = reason.toString();

      if (!this.closed && this.refusedModel(why)) {
        const dead = this.transcribeModels.shift();

        if (this.transcribeModels.length > 0) {
          console.warn(
            `[realtime] no access to ${dead} — reconnecting with ${this.transcribeModels[0]}`,
          );
          setTimeout(() => this.connect(), 150);
          return;
        }

        // Every candidate refused. Reconnect with transcription switched off
        // rather than leaving the session dead: without it the child cannot be
        // understood, but barge-in still works, so at least the narrator still
        // stops when they talk. Say so loudly — this is not a degradation
        // anyone should have to infer from the app being strange.
        this.transcriptionDisabled = true;
        console.error(
          '[realtime] NO transcription model is available to this project. ' +
            'Barge-in will still work but nothing the child says can be understood. ' +
            'Run `npm run realtime:check` — it tests every model and tells you which to pin.',
        );
        this.cb.onError?.(
          'Ollie can hear that you are talking but cannot understand the words yet — ' +
            'no transcription model is available on this OpenAI project.',
        );
        setTimeout(() => this.connect(), 150);
        return;
      }

      this.cb.onClose?.(code, why);
    });
  }

  /** Was this failure "the project cannot use that transcription model"? */
  private refusedModel(message: string): boolean {
    if (this.transcriptionDisabled) return false;
    if (!/does not have access to model|model_not_found/i.test(message)) return false;
    return this.transcribeModels.some((m) => message.includes(m));
  }

  /**
   * Queue anything sent before the socket is open.
   *
   * This used to `return` on a socket that was still connecting, which quietly
   * threw the event away. `Session.start()` creates this object and asks for the
   * greeting in the same tick — about a second before the WebSocket finishes its
   * handshake — so the very first `response.create` of every session went in the
   * bin. Nothing was ever spoken, `done` never resolved because `response.done`
   * never came, and the session hung until a stray noise triggered the VAD and
   * cancelled a response that had never existed.
   *
   * That was the "few seconds of nothing at the start", the "produced NO audio",
   * and the phantom barge-in, all from one dropped message.
   */
  private send(event: Record<string, unknown>) {
    const data = JSON.stringify(event);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.outbox.push(data);
      return;
    }
    // Closing or closed: there is nobody to tell.
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
  private configure(minimal = false) {
    this.configureAttempts += 1;

    // If the server never confirms, we would drop mic audio forever and the
    // session would be silently deaf. Fall forward instead, loudly.
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.ready || this.closed) return;
      console.warn(
        '[realtime] no session.updated after 4s — proceeding on the default config. ' +
          'Run `REALTIME_TRACE=1 npm run realtime:check` to see what the server said.',
      );
      this.ready = true;
    }, 4_000);

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        // TEXT, not audio. This session is ears; it has nothing to say and now
        // has no way to say it. See the note at the top of the file.
        output_modalities: ['text'],
        instructions: 'Do not respond. You are only listening.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
            ...(this.transcriptionDisabled
              ? {}
              : { transcription: { model: this.transcribeModels[0], language: 'en' } }),
            // Laptop speakers and a laptop microphone in the same room.
            ...(minimal ? {} : { noise_reduction: { type: 'far_field' as const } }),
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              // Children pause mid-sentence constantly. This is the "have they
              // finished?" window, and it is deliberately longer than the default.
              silence_duration_ms: 900,
              // Nothing here ever replies. Both of these exist to make sure of
              // it from two directions.
              create_response: false,
              interrupt_response: false,
            },
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
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        console.log(
          this.transcriptionDisabled
            ? '[realtime] listening WITHOUT transcription — barge-in only'
            : `[realtime] transcribing with ${this.transcribeModels[0]}`,
        );
        if (process.env.REALTIME_TRACE) {
          console.log('[realtime] effective session', JSON.stringify(event.session, null, 2));
        }
        if (this.ready) break;
        this.ready = true;
        console.log('[realtime] session ready — listening');
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
        console.log(`[realtime] heard "${text}"`);
        if (text) this.cb.onUtterance(text);
        break;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        this.partialTranscript = '';
        const err = event.error ?? {};
        console.warn('[realtime] transcription failed', JSON.stringify(err));

        // The project cannot use this model. Nothing the child says will ever be
        // heard until we pick one it can, so move down the list and reconfigure.
        if (/model_not_found|does not have access/i.test(JSON.stringify(err)) && this.transcribeModels.length > 1) {
          const dead = this.transcribeModels.shift();
          console.warn(`[realtime] no access to ${dead} — switching to ${this.transcribeModels[0]}`);
          this.send({
            type: 'session.update',
            session: {
              type: 'realtime',
              audio: { input: { transcription: { model: this.transcribeModels[0], language: 'en' } } },
            },
          });
        }
        break;
      }

      case 'error': {
        const message = event.error?.message ?? JSON.stringify(event.error);
        console.error('[realtime]', message);

        // A cancel that raced a response into existence is a bookkeeping detail,
        // not something to put in front of a five-year-old as "Something went
        // wrong". Only things that actually break the session reach the UI.
        // A rejected session config is recoverable: try again without the
        // optional fields. Some models do not accept every one of them, and the
        // difference between "no noise reduction" and "deaf" is the whole app.
        if (!this.ready && this.configureAttempts === 1 && /session|param|unknown|invalid/i.test(message)) {
          console.warn('[realtime] session config rejected, retrying without optional fields');
          this.configure(true);
          break;
        }

        const benign =
          /no active response|cancellation failed|already has an active response|buffer is empty/i.test(
            message,
          );
        if (!benign) this.cb.onError?.(`realtime: ${message}`);

        // An error usually kills the in-flight response; do not hang on it.
        break;
      }

      default:
        // Log each unfamiliar event once. When transcription silently does not
        // arrive, this is the only way to find out that it never fired.
        if (!this.seenEventTypes.has(event.type)) {
          this.seenEventTypes.add(event.type);
          if (process.env.REALTIME_TRACE) console.log('[realtime] first', event.type);
        }
        break;
    }
  }

  /** Mic audio, 16kHz PCM16 as captured. Upsampled here. */
  write(pcm16k: Buffer) {
    if (this.closed || !this.ready) {
      // DROPPED, not buffered.
      //
      // Buffering it seemed kind — a second of audio captured while the socket
      // was still configuring, handed over as soon as it was ready. What it
      // actually did was hand a whole second of sound to the VAD in one burst,
      // at the exact moment the greeting started. The mic check screen has the
      // child say "Hi Ollie!" out loud thirty seconds earlier, the room is not
      // silent, and the very first thing that happened in every session was a
      // barge-in that killed the greeting before a word of it was audible.
      //
      // Nothing said before the session is configured is addressed to us.
      return;
    }
    const pcm24k = upsample16to24(pcm16k);
    if (pcm24k.length === 0) return;
    this.appendAudio(pcm24k);
  }

  private appendAudio(pcm24k: Buffer) {
    this.send({ type: 'input_audio_buffer.append', audio: pcm24k.toString('base64') });
  }

  /** Which transcription model is currently configured, if any. */
  get transcriptionModel(): string {
    return this.transcriptionDisabled ? 'none' : (this.transcribeModels[0] ?? 'none');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
