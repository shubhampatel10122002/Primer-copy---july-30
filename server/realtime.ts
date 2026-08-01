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

/**
 * Transcription models to try, best first.
 *
 * Which of these a project may actually use varies — ours was refused
 * `gpt-4o-mini-transcribe` outright ("Project does not have access to model"),
 * and a session with no working transcription is a session where nothing the
 * child says is ever heard. So the list is walked on `model_not_found` rather
 * than being one name we hope is right.
 *
 * `gpt-realtime-whisper` is the one the Realtime docs use and is part of the
 * same family as the session model; `whisper-1` is the oldest and most widely
 * enabled. Override with OPENAI_TRANSCRIBE_MODEL to pin one.
 */
const TRANSCRIBE_MODELS = [
  'gpt-realtime-whisper',
  'whisper-1',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
] as const;

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
  /** Fatal errors reach the UI; benign races only reach the log. */
  private seenEventTypes = new Set<string>();

  /** The response currently being spoken, if any. */
  private active: {
    id: string | null;
    resolve: () => void;
    cancelled: boolean;
    /** True once the server has confirmed a response exists to cancel. */
    started: boolean;
  } | null = null;

  private partialTranscript = '';
  /** A cancel that arrived before the server confirmed the response existed. */
  private pendingCancel = false;
  private configureAttempts = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  /** Events asked for before the socket opened. */
  private outbox: string[] = [];
  /** Transcription models to try, in order, as the project allows them. */
  private transcribeModels: string[] = env.transcribeModel
    ? [env.transcribeModel]
    : [...TRANSCRIBE_MODELS];

  constructor(private cb: RealtimeCallbacks) {
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

    this.ws.on('error', (err) => this.cb.onError?.(`realtime socket: ${String(err)}`));
    this.ws.on('close', (code, reason) => {
      this.ready = false;
      this.cb.onClose?.(code, reason.toString());
    });
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
        output_modalities: ['audio'],
        instructions:
          'You are Ollie, a warm, playful owl who reads stories with young children. ' +
          'You will be told exactly what to say. Say it warmly and clearly, at an unhurried ' +
          'pace, as if reading a picture book aloud to a five-year-old.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
            transcription: { model: this.transcribeModels[0], language: 'en' },
            // Laptop speakers and a laptop microphone in the same room.
            ...(minimal ? {} : { noise_reduction: { type: 'far_field' as const } }),
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              // Children pause mid-sentence constantly. This is the "have they
              // finished?" window, and it is deliberately longer than the default.
              silence_duration_ms: 900,
              // We decide when to reply. See above.
              create_response: false,
              // And we do the interrupting, on speech_started, so that exactly
              // one thing is responsible for it. With both, the server cancels
              // the response and then our cancel arrives to find nothing there.
              interrupt_response: false,
            },
          },
          output: minimal
            ? { format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate }, voice: env.realtimeVoice }
            : {
                format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
                voice: env.realtimeVoice,
                // Unhurried, like reading a picture book. Dropped on the retry
                // in case a model rejects the field.
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
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
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
        if (err.code === 'model_not_found' && this.transcribeModels.length > 1) {
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
        if (this.active) this.active.started = true;
        // Cancelled before the server had even created it. Send the cancel NOW,
        // when there is finally something to cancel — sending it earlier is what
        // produced "Cancellation failed: no active response found" on the very
        // first barge-in of every session.
        if (this.pendingCancel) {
          this.pendingCancel = false;
          this.send({ type: 'response.cancel' });
        }
        break;

      case 'response.done': {
        const done = this.active;
        this.active = null;
        done?.resolve();
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
        if (this.active) {
          const done = this.active;
          this.active = null;
          done.resolve();
        }
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

    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));

    // Never wait forever for a `response.done` that is not coming. A silently
    // dropped event once left the whole session hanging on this promise, and the
    // only thing that unstuck it was a stray noise triggering the VAD.
    const watchdog = setTimeout(() => {
      if (this.active === entry) {
        console.error('[realtime] no response.done after 30s — releasing the utterance');
        this.active = null;
        settle();
      }
    }, 30_000);
    const resolve = () => {
      clearTimeout(watchdog);
      settle();
    };

    const entry = { id: null as string | null, resolve, cancelled: false, started: false };
    this.active = entry;
    this.pendingCancel = false;

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
        // Audio stops reaching the child either way — `cancelled` gates that.
        // Telling the server is only about not paying for tokens nobody hears,
        // and it can only be told once it knows the response exists.
        if (entry.started) this.send({ type: 'response.cancel' });
        else this.pendingCancel = true;
        resolve();
      },
    };
  }

  private cancelActive() {
    if (!this.active) return;
    const entry = this.active;
    this.active = null;
    entry.cancelled = true;
    if (entry.started) this.send({ type: 'response.cancel' });
    else this.pendingCancel = true;
    entry.resolve();
  }

  /** Which transcription model is currently configured. */
  get transcriptionModel(): string {
    return this.transcribeModels[0];
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.cancelActive();
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
