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
 * The API will not transcribe less than 100ms, and says so with an error.
 *
 * 24kHz, 16-bit, mono: 4800 bytes is 100ms. A little over it, because a commit
 * that is refused is far more expensive than a turn that was never going to
 * contain a word.
 */
const MIN_COMMIT_BYTES = 24_000 * 2 * 0.12;

/** The last rung of the config negotiation ladder. See `configure`. */
const LAST_CONFIG_RUNG = 3;

/** Milliseconds of 24kHz PCM16 in a byte count, for logging. */
function pcm24Ms(bytes: number): number {
  return Math.round((bytes / 2 / 24_000) * 1000);
}

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

  /**
   * Turns committed and awaiting a transcript.
   *
   * Correlated by the server's `item_id`, NOT by arrival order, and that is a
   * scar. This was a plain FIFO on the assumption that commits are answered in
   * order — true, right up until one of them is not answered at all. A commit
   * that errored left its turn stranded in the queue forever, so every later
   * transcript shifted off the wrong id, was reported against a turn the child
   * had moved past, and was discarded as stale. The turn actually waiting never
   * resolved, the watchdog fired, opened a new turn, and that one desynchronised
   * too: the session livelocked, reopening the microphone every twelve seconds
   * and never once progressing.
   *
   * `item_id` removes the ordering assumption entirely. One lost turn now costs
   * one turn.
   */
  private awaiting: { turnId: number; itemId: string | null }[] = [];
  /** Bytes appended for the open turn, so a too-short commit can be skipped. */
  private appended = 0;
  private partial = '';

  /** How far down the config negotiation ladder we are. */
  private rung = 0;
  /** Which spelling of the language hint this model wants, and whether we tried. */
  private langField: 'languages' | 'language';
  private langSwapped = false;
  private readyTimer: NodeJS.Timeout | null = null;
  /** Events asked for before the socket opened. */
  private outbox: string[] = [];
  private transcribeModels: string[] = env.transcribeModel
    ? [env.transcribeModel]
    : [...TRANSCRIBE_MODELS];

  constructor(private cb: RealtimeCallbacks) {
    this.langField = this.preferredLanguageField(this.transcribeModels[0] ?? '');
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
          // A different model may well want the other spelling, and has not
          // rejected anything yet. Negotiate from scratch.
          this.langField = this.preferredLanguageField(this.transcribeModels[0]);
          this.langSwapped = false;
          this.rung = 0;
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
   * Hand one committed turn its words, whatever they turn out to be.
   *
   * The ONE promise this class makes: every turn that is committed comes back
   * exactly once. Empty counts. A turn that never resolves is a session stuck in
   * PROCESSING with the mic shut — the child tapped, nothing happened, and there
   * is nothing they can do about it.
   *
   * `itemId` is how a transcript finds its turn. Falling back to the oldest
   * entry covers models that do not echo one; that is a guess, but a bounded
   * one, because a resolved turn always leaves the queue either way.
   */
  private resolve(itemId: string | null, text: string) {
    let index = itemId ? this.awaiting.findIndex((a) => a.itemId === itemId) : -1;
    if (index < 0) index = 0;

    const entry = this.awaiting[index];
    if (!entry) {
      console.warn(`[realtime] transcript with no turn waiting: "${text}"`);
      return;
    }
    this.awaiting.splice(index, 1);
    console.log(`[realtime] turn ${entry.turnId} heard "${text}"`);
    this.cb.onTranscript(entry.turnId, text);
  }

  /**
   * Resolve every pending turn with an empty transcript.
   *
   * Used when the connection itself is gone and nothing else is coming.
   */
  private failAwaiting(why: string) {
    const stuck = this.awaiting.splice(0, this.awaiting.length);
    if (stuck.length) console.warn(`[realtime] ${stuck.length} turn(s) lost: ${why}`);
    for (const { turnId } of stuck) this.cb.onTranscript(turnId, '');
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
   * Which field this model wants the language in.
   *
   * There is no single right answer, which is the whole problem: `languages`
   * (plural, a list) on gpt-live-transcribe, `language` (singular, ISO-639-1) on
   * whisper-1 and the gpt-4o-transcribe family. Sending BOTH to cover the
   * difference is not belt and braces, it is an error — "The 'language' and
   * 'languages' parameters cannot be used together" — and it fails the session
   * at startup, before the child has heard anything.
   *
   * So: guess from the model name, and negotiate if the guess is wrong.
   */
  private preferredLanguageField(model: string): 'languages' | 'language' {
    return /live-transcribe/i.test(model) ? 'languages' : 'language';
  }

  private languageParam(): Record<string, unknown> {
    return this.langField === 'languages' ? { languages: ['en'] } : { language: 'en' };
  }

  /**
   * Configure the session.
   *
   * `turn_detection: null` is the single most important line in this file. It
   * hands the turn boundary to the child's thumb: nothing is transcribed until
   * we commit, and we commit exactly once, when they close the mic.
   *
   * `rung` walks a negotiation ladder rather than a single retry. Which optional
   * fields a transcription model accepts genuinely varies, and the difference
   * between "no noise reduction" and "deaf" is the whole app — so each rung
   * gives up the least valuable thing left, and English survives to the last.
   */
  private configure(rung = 0) {
    this.rung = rung;

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

    // Rung 2 drops the tuning; rung 3 drops the language hint itself, which is
    // the last thing worth giving up and is why it is last.
    const tuned = rung < 2;
    const withLanguage = rung < 3;

    this.send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: AUDIO.realtimeSampleRate },
            // Laptop speakers and a laptop microphone in the same room.
            ...(tuned ? { noise_reduction: { type: 'far_field' as const } } : {}),
            transcription: {
              model: this.transcribeModels[0],

              // English, pinned — but in exactly ONE field.
              //
              // These models auto-detect language when not told, and a child
              // sounding out unfamiliar words is exactly the input that fools
              // detection: "Max sits on the red bench" came back once as
              // "मैंक्स सेज on the red bench". That does not break scoring, which
              // is Azure's job on the raw audio and always en-US. What it risks
              // is the story — a transcript with no Latin in it shares no words
              // with the passage, so a child reading their line reads as talking
              // and the plot follows a hallucination. `looksMistranscribed`
              // catches what gets through.
              ...(withLanguage ? this.languageParam() : {}),
              ...(tuned ? { delay: TRANSCRIBE_DELAY } : {}),
              // Children are the hardest speakers this model will meet: half
              // words, invented ones, and a lot of sounding out. Telling it what
              // it is listening to is free and measurably helps short phrases.
              prompt:
                'English only. A young child, roughly four to seven years old, ' +
                'reading a short English story aloud or talking to a friendly ' +
                'companion. Expect partial words, sounding out letter by letter, ' +
                'and enthusiasm. Always transcribe in the Latin alphabet, even ' +
                'when a word is mispronounced or unclear.',
            },
            // No automatic turn detection. The child's thumb is the boundary.
            turn_detection: null,
          },
        },
      },
    });
  }

  /**
   * The server refused the session config. Give up the least valuable thing and
   * try again.
   *
   * Returns false once the ladder is exhausted, which is the only point at which
   * a configuration problem is worth putting in front of a child.
   */
  private renegotiate(message: string): boolean {
    // The two language fields are mutually exclusive and which one is right
    // depends on the model, so this is a straight swap rather than a rung.
    if (/language/i.test(message) && !this.langSwapped) {
      this.langSwapped = true;
      this.langField = this.langField === 'languages' ? 'language' : 'languages';
      console.warn(`[realtime] retrying with \`${this.langField}\` instead`);
      this.configure(this.rung);
      return true;
    }

    if (this.rung >= LAST_CONFIG_RUNG) return false;

    console.warn(`[realtime] session config rejected, retrying without optional fields`);
    this.configure(this.rung + 1);
    return true;
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
          `[realtime] listening — ${this.transcribeModels[0]}, manual turns, ` +
            `${this.rung < LAST_CONFIG_RUNG ? `${this.langField}=en` : 'NO language pin'}` +
            `${this.rung < 2 ? `, delay=${TRANSCRIBE_DELAY}` : ''}`,
        );
        break;
      }

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.partial += event.delta;
          const pending = this.awaiting[0]?.turnId ?? this.openTurn;
          if (pending !== null && pending !== undefined) this.cb.onPartial?.(pending, this.partial);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript ?? this.partial ?? '').trim();
        this.partial = '';
        this.resolve(event.item_id ?? null, text);
        break;
      }

      case 'conversation.item.input_audio_transcription.failed': {
        this.partial = '';
        console.warn('[realtime] transcription failed', JSON.stringify(event.error ?? {}));
        // An empty transcript, not silence: the state machine leaves PROCESSING
        // either way, which is the only thing that must not fail to happen.
        this.resolve(event.item_id ?? null, '');
        break;
      }

      // The server has taken the buffer and named it. This is what lets a
      // transcript find its own turn instead of trusting arrival order.
      case 'input_audio_buffer.committed': {
        const waiting = this.awaiting.find((a) => a.itemId === null);
        if (waiting && event.item_id) waiting.itemId = event.item_id;
        break;
      }

      case 'error': {
        const message = event.error?.message ?? JSON.stringify(event.error);
        console.error('[realtime]', message);

        // A rejected session config is recoverable, and must be recovered from
        // SILENTLY: this happens during setup, before the child has heard
        // anything, and "Something went wrong" is not what a five-year-old
        // should be shown because two API fields are mutually exclusive.
        if (!this.ready && /language|session|param|unknown|invalid/i.test(message)) {
          if (this.renegotiate(message)) break;
          console.error('[realtime] every session config was rejected');
        }

        // ANY failure to commit resolves the turn it was for.
        //
        // This used to match two exact phrases and let everything else fall
        // through to onError — which left the turn sitting in `awaiting`
        // forever and desynchronised every turn after it. The real message is
        // "the buffer is too small. Expected at least 100ms of audio", which
        // matched neither pattern, so one child tapping twice quickly could
        // livelock the whole session.
        //
        // The lesson is not a better regex. It is that a committed turn must
        // come back on EVERY path, so the question is only whether this is worth
        // telling anyone about — never whether the turn is owed an answer.
        if (/buffer/i.test(message)) {
          const benign = /empty|too small|at least \d+ ?ms/i.test(message);
          if (!benign) console.error(`[realtime] commit failed: ${message}`);
          this.resolve(null, '');
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
    const captured = this.appended;
    this.openTurn = null;
    this.appended = 0;

    // Too little audio to be a turn: a double tap, a mic that produced no
    // frames, or a child who opened and closed it in one motion.
    //
    // The floor used to be zero bytes, which is not the API's floor — it wants
    // at least 100ms — so a 40ms turn was sent, refused, and the refusal was the
    // start of a livelock. Answering it here means the round trip that can fail
    // never happens.
    if (captured < MIN_COMMIT_BYTES) {
      console.log(`[realtime] turn ${turnId} had ${pcm24Ms(captured)}ms of audio — nothing to hear`);
      this.cb.onTranscript(turnId, '');
      return;
    }

    this.awaiting.push({ turnId, itemId: null });
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /**
   * Stop waiting for a turn's words.
   *
   * Called when something upstream has already given up on it — the watchdog,
   * usually. Without this the abandoned entry stays in the queue and the next
   * transcript is matched against it, which is precisely the desynchronisation
   * that `item_id` exists to prevent. Belt as well as braces.
   */
  abandon(turnId: number) {
    const before = this.awaiting.length;
    this.awaiting = this.awaiting.filter((a) => a.turnId !== turnId);
    if (this.awaiting.length !== before) {
      console.warn(`[realtime] gave up on turn ${turnId}`);
    }
  }

  /** The mic closed but the audio is not wanted. Nothing is transcribed. */
  discard(turnId: number) {
    if (this.openTurn === turnId) this.openTurn = null;
    this.abandon(turnId);
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
