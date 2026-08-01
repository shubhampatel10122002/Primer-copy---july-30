'use client';

/**
 * Browser audio pipeline. PLAN.md §8.
 *
 * Capture: getUserMedia -> AudioWorklet -> 16kHz PCM16 frames -> WebSocket.
 * Playback: float32 PCM chunks from the server -> Web Audio with a jitter buffer.
 * Half-duplex: the client pauses capture while the narrator speaks (the server
 * gate is authoritative; this is the belt-and-suspenders half).
 */

/** What the Realtime API sends back: 24kHz mono PCM16, little-endian. */
const TTS_SAMPLE_RATE = 24000;
const MIC_SAMPLE_RATE = 16000;
/** Buffer this much audio before starting playback, to survive network jitter. */
const JITTER_BUFFER_SEC = 0.12;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private playHead = 0;
  private scheduled: AudioBufferSourceNode[] = [];
  private destroyed = false;
  private warnedAfterDestroy = false;

  onAudioFrame: ((pcm: ArrayBuffer) => void) | null = null;
  onLevel: ((rms: number) => void) | null = null;

  get sampleRate() {
    return this.ctx?.sampleRate ?? 0;
  }

  async init(): Promise<void> {
    if (this.ctx) return;

    // Let the browser pick its native rate and resample our 24kHz buffers for us.
    // Forcing the context to 24kHz used to be worth it when playback and capture
    // shared a rate; now they do not, and a mismatched context is the thing most
    // likely to make the voice sound pitched.
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
      if (data?.type === 'audio') this.onAudioFrame?.(data.buffer);
      else if (data?.type === 'level') this.onLevel?.(data.value);
    };

    this.source.connect(this.node);
  }

  /** Pause/resume capture. Called on tts_start / tts_end. */
  setMuted(muted: boolean) {
    this.node?.port.postMessage({ type: 'mute', value: muted });
  }

  /** Queue one float32 PCM chunk from the server for gapless playback. */
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

    // PCM16 is two bytes per sample; drop any ragged tail.
    const usable = pcm.byteLength - (pcm.byteLength % 2);
    if (usable <= 0) return;

    const ints = new Int16Array(pcm, 0, usable / 2);
    const samples = new Float32Array(ints.length);
    for (let i = 0; i < ints.length; i++) samples[i] = ints[i] / 32768;

    // Declaring the buffer at 24kHz is what tells Web Audio to resample it to the
    // context rate. Get this wrong and Ollie sounds like a chipmunk.
    const buffer = this.ctx.createBuffer(1, samples.length, TTS_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.playHead < now + 0.01) {
      // Starting fresh (or we underran) — re-arm the jitter buffer.
      this.playHead = now + JITTER_BUFFER_SEC;
    }
    src.start(this.playHead);
    this.playHead += buffer.duration;

    this.scheduled.push(src);
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
    };
  }

  /** Barge-in: kill everything already scheduled, immediately. */
  stopPlayback() {
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.scheduled = [];
    this.playHead = this.ctx?.currentTime ?? 0;
  }

  /** True while queued audio is still playing out. */
  get isPlaying() {
    return !!this.ctx && this.playHead > this.ctx.currentTime + 0.01;
  }

  /**
   * How much audio is still queued ahead of the playback position.
   *
   * The server sends the text of an utterance before streaming its audio, and it
   * considers itself finished when it stops *sending* — not when the
   * browser stops *playing*. This is what the UI uses to hold a caption back
   * until the previous utterance has actually finished out loud.
   */
  playbackRemainingMs(): number {
    if (!this.ctx) return 0;
    return Math.max(0, (this.playHead - this.ctx.currentTime) * 1000);
  }

  async destroy() {
    this.destroyed = true;
    this.stopPlayback();
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
