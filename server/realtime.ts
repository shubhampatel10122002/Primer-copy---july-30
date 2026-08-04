import WebSocket from 'ws';
import { env, AUDIO } from '../lib/env';

/**
 * The ears. A Realtime TRANSCRIPTION session, and nothing else.
 *
 * Two things changed here when the mic button arrived, and both are the same
 * change: turn-taking left this file.
 *
 * It used to be a full `type: 'realtime'` session running server VAD, and the
 * event that mattered was `input_audio_buffer.speech_started` — the audio-level
 * signal that the child had begun talking, which is what made barge-in fast
 * enough to be worth having. A tap is faster and is never wrong, so that entire
 * signal path is gone.
 *
 * What replaces it is better suited to what we actually want. A transcription
 * session with `turn_detection: null` does no turn detection at all: it
 * transcribes exactly the audio between an append and an explicit
 * `input_audio_buffer.commit`. So "the child tapped to close the mic" and "the
 * transcript is final" become the same instant, by construction, rather than two
 * things a timer had to guess were related.
 *
 * The alternative was to leave server VAD on and ignore the parts we did not
 * want. That does not work: with turn detection enabled the server commits the
 * buffer itself at every pause it hears, which is a SECOND turn boundary
 * competing with the button — and children pause constantly, so it would fire
 * first and cut them off mid-list. Exactly the failure the settle-delay
 * machinery existed to paper over. One boundary, owned by the child.
 *
 * Pronunciation assessment stays on Azure, on the same audio: no general-purpose
 * speech model returns per-phoneme accuracy for a five-year-old reading
 * "bridge".
 */

/**
 * `intent=transcription` selects a transcription session, which — unlike a
 * conversation session — has no way to generate speech even in principle. The
 * old session had to be talked out of speaking with `output_modalities: ['text']`
 * AND `create_response: false`, after a version that WAS the voice read back
 * what the child had just said instead of the line it was handed.
 */
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

/**
 * Transcription models to try, best first.
 *
 * `gpt-live-transcribe` (28 July 2026) is the current low-latency streaming
 * model and the documented migration target for `gpt-realtime-whisper`. It is
 * first because latency here is the child waiting to be answered.
 *
 * Which of these a project may use varies, and getting it wrong has no symptom
 * other than the child never being heard — this project has been refused
 * `gpt-4o-mini-transcribe` outright ("Project does not have access to model").
 * So this is a list that gets walked on refusal, not one name we hope is right.
 *
 * `npm run realtime:check` asks your project directly which ones it has and
 * prints them; pin one with OPENAI_TRANSCRIBE_MODEL to stop guessing entirely.
 */
const TRANSCRIBE_MODELS = [
  'gpt-live-transcribe',
  'gpt-realtime-whisper',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
] as const;

/**
 * How much audio context the model buys before emitting text.
 *
 * Lower settings produce earlier partials at some cost to word error rate. A
 * child is waiting for an answer at the end of every turn, so this is the one
 * place in the app where latency beats a fractional accuracy gain — the words
 * that have to be scored precisely go to Azure, not here.
 */
const TRANSCRIBE_DELAY = process.env.OPENAI_TRANSCRIBE_DELAY || 'minimal';

export interface RealtimeCallbacks {
  /**
   * A finished transcript for one committed turn.
   *
   * `turnId` is whatever was passed to `commit()`, threaded back so a transcript
   * that arrives after the child has already taken the floor again can be
   * recognised as stale and dropped rather than answered.
   */
  onTranscript: (turnId: number, text: string) => void;
  /** Streaming text for a turn still in progress. Display only. */
  onPartial?: (turnId: number, text: string) => void;
  onError?: (message: string) => void;
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
  private seenEventTypes = new Set<string>();

  /**
   * The turn whose audio is currently in the input buffer.
   *
   * Null between turns, which is also the gate on `write()`: with no open turn
   * there is nothing to append audio to, so a stray frame cannot end up
   * prepended to the child's next sentence.
   */
  private openTurn: number | null = null;
  /** Turns committed and awaiting a transcript, oldest first. */
  private awaiting: number[] = [];
  /** Bytes appended for the open turn, so an empty commit can be skipped. */
  private appended = 0;
  private partial = '';

  private configureAttempts = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  /** Events asked for before the socket opened. */
  private outbox: string[] = [];
  private transcribeModels: string[] = env.transcribeModel
    ? [env.transcribeModel]
    : [...TRANSCRIBE_MODELS];

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
    this.ws = new WebSocket(REALTIME_URL, {
      headers: { Authorization: `Bearer ${env.openaiKey}` },
    });

    this.ws.on('open', () => {
      // Configure FIRST, then release anything queued during the handshake —
      // the session has to exist before audio can be appended to it.
      this.configure();
      const queued = this.outbox.splice(0, this.outbox.length);
      for (const data of queued) this.ws.send(data);
      if (queued.length) {
        console.log(`[realtime] session ready (${queued.length} message(s) queued during setup)`);
      }
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

        // Every candidate refused. Unlike the old design there is nothing left
        // to fall back to: without transcription this session has no other job,
        // and a mic button that records into a void is worse than an error.
        console.error(
          '[realtime] NO transcription model is available to this project. ' +
            'Run `npm run realtime:check` — it tests every model and tells you which to pin.',
        );
        this.cb.onError?.(
          'Ollie cannot understand speech right now — no transcription model is ' +
            'available on this OpenAI project.',
        );
        this.failAwaiting('no transcription model available');
        return;
      }

      // Any turn still waiting for words is never going to get them. Say so
      // rather than leaving the state machine in PROCESSING forever.
      if (!this.closed) this.failAwaiting(`connection closed (${code})`);
      this.cb.onClose?.(code, why);
    });
  }

  /** Was this failure "the project cannot use that transcription model"? */
  private refusedModel(message: string): boolean {
    if (!/does not have access to model|model_not_found/i.test(message)) return false;
    return this.transcribeModels.some((m) => message.includes(m));
  }

  /**
   * Resolve every pending turn with an empty transcript.
   *
   * A turn that never comes back is a session stuck in PROCESSING with the mic
   * shut — the child tapped, nothing happened, and there is nothing they can do
   * about it. An empty transcript at least reaches the state machine, which
   * knows how to get back to a usable state from there.
   */
  private failAwaiting(why: string) {
    const stuck = this.awaiting.splice(0, this.awaiting.length);
    if (stuck.length) console.warn(`[realtime] ${stuck.length} turn(s) lost: ${why}`);
    for (const turnId of stuck) this.cb.onTranscript(turnId, '');
  }

  /** Queue anything sent before the socket is open. */
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
   * `turn_detection: null` is the single most important line in this file. It
   * hands the turn boundary to the child's thumb: nothing is transcribed until
   * we commit, and we commit exactly once, when they close the mic.
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
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
            // Laptop speakers and a laptop microphone in the same room.
            ...(minimal ? {} : { noise_reduction: { type: 'far_field' as const } }),
            transcription: {
              model: this.transcribeModels[0],
              languages: ['en'],
              ...(minimal ? {} : { delay: TRANSCRIBE_DELAY }),
              // Children are the hardest speakers this model will meet: half
              // words, invented ones, and a lot of sounding out. Telling it what
              // it is listening to is free and measurably helps short phrases.
              prompt:
                'A young child, roughly four to seven years old, reading a short ' +
                'story aloud or talking to a friendly companion. Expect partial ' +
                'words, sounding out letter by letter, and enthusiasm.',
            },
            // No automatic turn detection. The child's thumb is the boundary.
            turn_detection: null,
          },
        },
      },
    });
  }

  private handle(event: any) {
    switch (event.type) {
      case 'session.created':
        break;

      case 'transcription_session.updated':
      case 'session.updated': {
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyTimer = null;
        if (process.env.REALTIME_TRACE) {
          console.log('[realtime] effective session', JSON.stringify(event.session, null, 2));
        }
        if (this.ready) break;
        this.ready = true;
        console.log(
          `[realtime] listening — ${this.transcribeModels[0]}, manual turns (delay=${TRANSCRIBE_DELAY})`,
        );
        break;
      }

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.partial += event.delta;
          const turnId = this.awaiting[0] ?? this.openTurn;
          if (turnId !== null && turnId !== undefined) this.cb.onPartial?.(turnId, this.partial);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? this.partial ?? '').trim();
        this.partial = '';
        // Commits are answered in order, so the oldest outstanding turn owns
        // this transcript. Threading the id through is what lets a late one be
        // recognised as belonging to a turn the child has already moved past.
        const turnId = this.awaiting.shift();
        if (turnId === undefined) {
          console.warn(`[realtime] transcript with no turn waiting: "${text}"`);
          break;
        }
        console.log(`[realtime] turn ${turnId} heard "${text}"`);
        this.cb.onTranscript(turnId, text);
        break;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        this.partial = '';
        const err = event.error ?? {};
        console.warn('[realtime] transcription failed', JSON.stringify(err));
        const turnId = this.awaiting.shift();
        // An empty transcript, not silence: the state machine leaves PROCESSING
        // either way, which is the only thing that must not fail to happen.
        if (turnId !== undefined) this.cb.onTranscript(turnId, '');
        break;
      }

      case 'input_audio_buffer.committed':
        break;

      case 'error': {
        const message = event.error?.message ?? JSON.stringify(event.error);
        console.error('[realtime]', message);

        // A rejected session config is recoverable: try again without the
        // optional fields. Models differ in which they accept, and the
        // difference between "no noise reduction" and "deaf" is the whole app.
        if (
          !this.ready &&
          this.configureAttempts === 1 &&
          /session|param|unknown|invalid/i.test(message)
        ) {
          console.warn('[realtime] session config rejected, retrying without optional fields');
          this.configure(true);
          break;
        }

        // Committing a buffer with nothing in it is a race, not a fault: the
        // child tapped twice, or tapped and said nothing. It is handled where it
        // happens, and must never reach a five-year-old as "Something went
        // wrong".
        if (/buffer is empty|buffer too small/i.test(message)) {
          const turnId = this.awaiting.shift();
          if (turnId !== undefined) this.cb.onTranscript(turnId, '');
          break;
        }

        this.cb.onError?.(`realtime: ${message}`);
        break;
      }

      default:
        if (!this.seenEventTypes.has(event.type)) {
          this.seenEventTypes.add(event.type);
          if (process.env.REALTIME_TRACE) console.log('[realtime] first', event.type);
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // The turn API. Exactly mirrors the mic button.
  // -------------------------------------------------------------------------

  /**
   * The mic opened. Audio from here to `commit`/`discard` is one turn.
   *
   * The buffer is cleared first. Anything left in it belongs to a turn that was
   * abandoned, and a room noise captured before the child started would
   * otherwise arrive glued to the front of their first word.
   */
  beginTurn(turnId: number) {
    this.openTurn = turnId;
    this.appended = 0;
    this.partial = '';
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /**
   * The mic closed. Transcribe what was said.
   *
   * Resolves through `onTranscript` — always, including when there was nothing
   * to transcribe, because the state machine is in PROCESSING waiting for it.
   */
  commit(turnId: number) {
    if (this.openTurn !== turnId) {
      console.warn(`[realtime] commit for turn ${turnId}, but ${this.openTurn} is open`);
    }
    this.openTurn = null;

    // Nothing was captured — a double tap, or a mic that produced no frames.
    // Committing an empty buffer is an API error; answering it ourselves keeps
    // the turn's promise without one.
    if (this.appended === 0) {
      this.cb.onTranscript(turnId, '');
      return;
    }

    this.awaiting.push(turnId);
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /** The mic closed but the audio is not wanted. Nothing is transcribed. */
  discard(turnId: number) {
    if (this.openTurn === turnId) this.openTurn = null;
    this.appended = 0;
    this.partial = '';
    this.send({ type: 'input_audio_buffer.clear' });
  }

  /**
   * Mic audio, 16kHz PCM16 as captured. Upsampled here.
   *
   * Dropped rather than buffered when no turn is open or the session is not yet
   * configured. Nothing said while the mic is closed is addressed to us, and
   * handing a second of captured room noise to a turn the moment it opens is
   * how a child's first word ends up behind a cough.
   */
  write(pcm16k: Buffer) {
    if (this.closed || !this.ready || this.openTurn === null) return;
    const pcm24k = upsample16to24(pcm16k);
    if (pcm24k.length === 0) return;
    this.appended += pcm24k.length;
    this.send({ type: 'input_audio_buffer.append', audio: pcm24k.toString('base64') });
  }

  /** Which transcription model is currently configured. */
  get transcriptionModel(): string {
    return this.transcribeModels[0] ?? 'none';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.failAwaiting('session closed');
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}
