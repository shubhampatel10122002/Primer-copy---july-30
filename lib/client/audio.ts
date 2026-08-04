'use client';

/**
 * Browser audio pipeline. PLAN.md §8.
 *
 * Capture: getUserMedia -> AudioWorklet -> 16kHz PCM16 frames -> WebSocket,
 * emitted ONLY while the mic is open. When it is closed, no audio leaves the
 * browser at all. That is the strongest form the mutual-exclusion rule can
 * take: not "we ignore it", not "the server drops it" — it is never sent.
 *
 * Playback: PCM16 chunks from the server -> Web Audio with a jitter buffer, and
 * a drain signal, because the server stops SENDING audio seconds before the
 * child stops HEARING it (see `onPlaybackDrained`).
 *
 * This file also owns end-of-speech detection, which runs only when the state
 * machine arms it — a mic session the child opened themselves is never closed by
 * silence.
 */

/** What the speech endpoint returns: 24kHz mono PCM16, little-endian. */
const TTS_SAMPLE_RATE = 24000;
const MIC_SAMPLE_RATE = 16000;

/**
 * Buffer this much audio before starting playback, to survive network jitter.
 *
 * Also the floor on how long a barge-in can take to be silent: cancelling drops
 * everything scheduled, so the worst case is one buffer's worth already inside
 * the audio device. 120ms is comfortably under the perceptual threshold.
 */
const JITTER_BUFFER_SEC = 0.12;

/** How often to check whether playback has finished, in ms. */
const DRAIN_POLL_MS = 40;

/**
 * Absolute floor for "that was a sound, not a room".
 *
 * A hard minimum under the adaptive threshold, so a silent room with a very low
 * noise floor cannot make its own hiss count as speech.
 */
const SPEECH_RMS_FLOOR = 0.014;

/** How far above the measured room noise a sound has to be to count. */
const SPEECH_RMS_MULTIPLE = 2.5;

/**
 * A turn that never hears any speech at all closes after this.
 *
 * Not the same number as the silence threshold, and not the same situation: this
 * is a reading turn that opened and got nothing — the child is thinking, or has
 * wandered off. It closes empty so the session can offer a nudge, which is the
 * only thing that helps.
 */
const NO_SPEECH_TIMEOUT_MS = 8_000;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private playHead = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  /** Half a PCM16 sample left over from the previous chunk. See playChunk. */
  private pcmCarry: Uint8Array | null = null;
  private destroyed = false;
  private warnedAfterDestroy = false;

  /** No frames are emitted unless this is true. Driven by the state machine. */
  private capturing = false;

  // -- end-of-speech detection (armed only when autoCloseArmed) --------------
  private autoCloseTurn: number | null = null;
  private silenceMs = 0;
  private noiseFloor = SPEECH_RMS_FLOOR;
  private heardSpeech = false;
  private lastLoudAt = 0;
  private armedAt = 0;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;

  // -- playback drain --------------------------------------------------------
  private streamingUtterance: number | null = null;
  private streamComplete = false;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  onAudioFrame: ((pcm: ArrayBuffer) => void) | null = null;
  onLevel: ((rms: number) => void) | null = null;
  /** The child is audibly talking right now. Drives the indicator only. */
  onSpeaking: ((on: boolean) => void) | null = null;
  /** Armed silence detection fired. Only ever for an auto-close-armed turn. */
  onSpeechEnd: ((turnId: number) => void) | null = null;
  /**
   * Every queued sample has now been heard.
   *
   * This — not the end of the network stream — is when the AI has finished
   * speaking. Auto-opening the mic any earlier puts the microphone live while
   * Ollie is still audible, and hands his own voice to pronunciation assessment.
   */
  onPlaybackDrained: ((utteranceId: number) => void) | null = null;

  get sampleRate() {
    return this.ctx?.sampleRate ?? 0;
  }

  get isCapturing() {
    return this.capturing;
  }

  async init(): Promise<void> {
    if (this.ctx) return;

    // Let the browser pick its native rate and resample our 24kHz buffers for
    // us. Forcing the context to 24kHz used to be worth it when playback and
    // capture shared a rate; now they do not, and a mismatched context is the
    // thing most likely to make the voice sound pitched.
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    await this.ctx.audioWorklet.addModule('/worklets/capture-processor.js');

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetSampleRate: MIC_SAMPLE_RATE },
    });

    this.node.port.onmessage = (e) => {
      const data = e.data;
      if (data?.type === 'audio') {
        // The gate is here as well as in the worklet. Two locks on one door,
        // because a frame that escapes while the mic is closed is a frame of
        // Ollie's own voice landing in the child's next sentence.
        if (this.capturing) this.onAudioFrame?.(data.buffer);
      } else if (data?.type === 'level') {
        this.onLevel?.(data.value);
        this.observeLevel(data.value);
      }
    };

    this.source.connect(this.node);
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  /**
   * Open or close the microphone.
   *
   * Only the state machine calls this, via its `open_mic` / `close_mic`
   * effects. Nothing else in the UI is allowed to touch capture directly.
   */
  setCapturing(on: boolean) {
    if (this.capturing === on) return;
    this.capturing = on;
    this.node?.port.postMessage({ type: 'capture', value: on });
    if (!on) {
      this.disarmAutoClose();
      this.onSpeaking?.(false);
    }
  }

  // -------------------------------------------------------------------------
  // End-of-speech detection
  // -------------------------------------------------------------------------

  /**
   * Start watching for the child to finish.
   *
   * Called for exactly one kind of mic session: one the system opened at the end
   * of an AI passage, in story mode. A session the child opened themselves never
   * gets here — they are interrupting, and interrupting is not a reading turn.
   */
  armAutoClose(turnId: number, silenceMs: number) {
    this.disarmAutoClose();
    this.autoCloseTurn = turnId;
    this.silenceMs = silenceMs;
    this.heardSpeech = false;
    this.armedAt = now();
    this.lastLoudAt = this.armedAt;
    // Re-measure the room for each turn rather than carrying a stale floor from
    // before Ollie started talking.
    this.noiseFloor = SPEECH_RMS_FLOOR;

    this.silenceTimer = setInterval(() => this.checkSilence(), 60);
  }

  disarmAutoClose() {
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.silenceTimer = null;
    this.autoCloseTurn = null;
    this.heardSpeech = false;
  }

  /** Track the room's noise floor and whether anything is currently above it. */
  private observeLevel(rms: number) {
    // Decay towards quiet quickly, rise slowly: the floor should follow a room
    // getting noisier, not a child getting loud.
    this.noiseFloor =
      rms < this.noiseFloor ? this.noiseFloor * 0.7 + rms * 0.3 : this.noiseFloor * 0.995 + rms * 0.005;

    if (!this.capturing) return;

    const threshold = Math.max(SPEECH_RMS_FLOOR, this.noiseFloor * SPEECH_RMS_MULTIPLE);
    const loud = rms > threshold;
    if (loud) {
      this.lastLoudAt = now();
      if (this.autoCloseTurn !== null && !this.heardSpeech) {
        this.heardSpeech = true;
      }
      this.onSpeaking?.(true);
    } else if (now() - this.lastLoudAt > 250) {
      this.onSpeaking?.(false);
    }
  }

  private checkSilence() {
    const turnId = this.autoCloseTurn;
    if (turnId === null || !this.capturing) return;

    const quietFor = now() - this.lastLoudAt;

    // They read, and then stopped. This is the ordinary end of a reading turn.
    if (this.heardSpeech && quietFor >= this.silenceMs) {
      this.disarmAutoClose();
      this.onSpeechEnd?.(turnId);
      return;
    }

    // They never started. Close it empty so the session can nudge them —
    // sitting with an open mic in front of a child who is stuck helps nobody.
    if (!this.heardSpeech && now() - this.armedAt >= NO_SPEECH_TIMEOUT_MS) {
      this.disarmAutoClose();
      this.onSpeechEnd?.(turnId);
    }
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /** A new utterance is about to stream. Resets the drain bookkeeping. */
  beginUtterance(utteranceId: number) {
    this.streamingUtterance = utteranceId;
    this.streamComplete = false;
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  /**
   * The server has finished sending audio for this utterance.
   *
   * Not the same as finished playing. From here we watch the queue, and report
   * only once the last sample has actually been heard.
   */
  endUtteranceStream(utteranceId: number) {
    if (this.streamingUtterance !== utteranceId) return;
    this.streamComplete = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = setInterval(() => this.checkDrained(), DRAIN_POLL_MS);
    this.checkDrained();
  }

  private checkDrained() {
    if (!this.streamComplete || this.streamingUtterance === null) return;
    if (this.playbackRemainingMs() > 0) return;

    const utteranceId = this.streamingUtterance;
    this.streamingUtterance = null;
    this.streamComplete = false;
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.onPlaybackDrained?.(utteranceId);
  }

  /** Queue one PCM16 chunk from the server for gapless playback. */
  playChunk(pcm: ArrayBuffer) {
    // Never fail silently here. A destroyed engine used to swallow every chunk
    // without a trace, which is indistinguishable from "the app is broken".
    if (this.destroyed) {
      if (!this.warnedAfterDestroy) {
        this.warnedAfterDestroy = true;
        console.error(
          '[audio] received TTS audio after the engine was destroyed — nothing will play. ' +
            'Something tore down the AudioEngine while the session was still using it.',
        );
      }
      return;
    }
    if (!this.ctx) {
      if (!this.warnedAfterDestroy) {
        this.warnedAfterDestroy = true;
        console.error('[audio] no AudioContext — call init() before playing audio.');
      }
      return;
    }

    // A backgrounded tab or an OS audio-device change can suspend the context
    // after it was unlocked. Scheduled sources then play into silence with no
    // error, which looks exactly like "the app is broken".
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }

    // PCM16 is two bytes per sample. An odd-length chunk must NOT simply lose
    // its last byte: the next chunk would then be read off by one, pairing the
    // low byte of each sample with the high byte of the next, which sounds
    // exactly like radio static. Carry the odd byte forward instead.
    //
    // The server aligns its chunks too; this is the second lock on that door.
    let bytes = new Uint8Array(pcm);
    if (this.pcmCarry) {
      const joined = new Uint8Array(this.pcmCarry.length + bytes.length);
      joined.set(this.pcmCarry, 0);
      joined.set(bytes, this.pcmCarry.length);
      bytes = joined;
      this.pcmCarry = null;
    }
    if (bytes.length % 2 === 1) {
      this.pcmCarry = bytes.slice(bytes.length - 1);
      bytes = bytes.slice(0, bytes.length - 1);
    }
    if (bytes.length === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

    // Declaring the buffer at 24kHz is what tells Web Audio to resample it to
    // the context rate. Get this wrong and Ollie sounds like a chipmunk.
    const buffer = this.ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const nowSec = this.ctx.currentTime;
    if (this.playHead < nowSec + 0.01) {
      // Starting fresh (or we underran) — re-arm the jitter buffer.
      this.playHead = nowSec + JITTER_BUFFER_SEC;
    }
    src.start(this.playHead);
    this.playHead += buffer.duration;

    this.scheduled.push(src);
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
    };
  }

  /**
   * Barge-in: kill everything already scheduled, immediately.
   *
   * Called synchronously from the tap handler, before any message reaches the
   * server, so the gap between the child's thumb and silence is one frame plus
   * whatever the audio device already has — well inside 100ms.
   */
  stopPlayback() {
    this.pcmCarry = null;
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled = [];
    this.playHead = this.ctx?.currentTime ?? 0;

    // Whatever was streaming is cancelled, not finished: no drain report.
    this.streamingUtterance = null;
    this.streamComplete = false;
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  /**
   * How much audio is still queued ahead of the playback position.
   *
   * Used for the drain signal, and to hold a caption back until the previous
   * utterance has actually finished out loud.
   */
  playbackRemainingMs(): number {
    if (!this.ctx) return 0;
    return Math.max(0, (this.playHead - this.ctx.currentTime) * 1000);
  }

  async destroy() {
    this.destroyed = true;
    this.stopPlayback();
    this.disarmAutoClose();
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.stream = null;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
