/**
 * Playback worklet. ONE continuous stream of Ollie's voice, from many chunks.
 *
 * This exists because of how the voice used to be played, which was: build an
 * AudioBuffer per network chunk, declare it at 24kHz, and schedule it at an
 * accumulated float time on the context's clock. Every part of that is
 * reasonable and the result hissed.
 *
 * Three things went wrong at every chunk boundary, and there are a dozen or more
 * boundaries per second:
 *
 *   1. RESAMPLING RESTARTED. The context runs at 44.1 or 48kHz, so each buffer
 *      was resampled from 24kHz on its way out — independently, by a resampler
 *      that had never seen the chunk before it and never would. A filter with no
 *      history rings at its edges, and its edges were everywhere.
 *
 *   2. START TIMES QUANTISED. `start(playHead)` lands on the nearest output
 *      sample, and `playHead` accumulated fractional 24kHz durations, so
 *      consecutive chunks overlapped or gapped by a fraction of a sample. A
 *      sub-sample step in a waveform is a click.
 *
 *   3. UNDERRUN INSERTED SILENCE. Falling behind re-armed the whole jitter
 *      buffer, dropping 120ms of nothing into the middle of a word.
 *
 * Clicks at a dozen a second are not heard as clicks. They are heard as a bad
 * radio signal, which is exactly what it was described as.
 *
 * So: samples go into one buffer, and this reads out of it at whatever rate the
 * context wants, interpolating with a read position that carries across chunk
 * boundaries and across underruns. There are no boundaries in the output because
 * there is only ever one stream. What arrives in chunks is data, not audio.
 */

/** Report the buffer level about this often, in render quanta (~2.7ms each). */
const REPORT_EVERY = 8;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};

    this.inputRate = opts.inputSampleRate || 24000;
    /** Input samples consumed per output sample. Fixed; the phase is not. */
    this.step = this.inputRate / sampleRate;
    /** How much has to be buffered before playback starts, or restarts. */
    this.prebuffer = Math.max(1, Math.round(this.inputRate * (opts.jitterSec || 0.12)));

    this.buf = new Float32Array(this.inputRate * 4);
    /** Fractional read position. Fractional is the point: it is the phase. */
    this.readIdx = 0;
    this.writeIdx = 0;
    this.playing = false;
    this.quanta = 0;
    /**
     * Which flush the reports below belong to.
     *
     * Echoed back so the main thread can tell a level measured BEFORE a
     * barge-in from one measured after. Without it a report already in flight
     * lands after the flush and restores a queue length of several seconds
     * that no longer exists — which the caption timing would then wait out.
     */
    this.flushSeq = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'samples') {
        this.append(new Float32Array(data.buffer));
      } else if (data.type === 'flush') {
        // Barge-in. Everything queued is about a moment that has passed.
        this.readIdx = 0;
        this.writeIdx = 0;
        this.playing = false;
        this.flushSeq = data.seq || 0;
        this.report();
      }
    };
  }

  /** Make room for `n` more samples, compacting or growing as needed. */
  reserve(n) {
    const start = Math.floor(this.readIdx);
    const live = this.writeIdx - start;

    if (live + n <= this.buf.length) {
      // Room overall; slide the live region down if it does not fit at the end.
      if (this.writeIdx + n > this.buf.length && start > 0) {
        this.buf.copyWithin(0, start, this.writeIdx);
        this.readIdx -= start;
        this.writeIdx -= start;
      }
      if (this.writeIdx + n <= this.buf.length) return;
    }

    // TTS streams faster than real time, so a long utterance can arrive whole
    // while its first second is still playing. Grow rather than drop: dropping
    // here would be a missing word, not a glitch.
    let capacity = this.buf.length;
    while (capacity < live + n) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(this.buf.subarray(start, this.writeIdx), 0);
    this.buf = grown;
    this.readIdx -= start;
    this.writeIdx = live;
  }

  append(samples) {
    if (!samples.length) return;
    this.reserve(samples.length);
    this.buf.set(samples, this.writeIdx);
    this.writeIdx += samples.length;
  }

  report() {
    this.port.postMessage({
      type: 'level',
      buffered: Math.max(0, this.writeIdx - this.readIdx),
      flushSeq: this.flushSeq,
    });
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    const out = channels && channels[0];
    if (!out) return true;

    let i = 0;

    // Start (or restart) only once there is enough to survive a hiccup. The
    // read position is NOT reset here, so resuming after an underrun continues
    // the same interpolation phase rather than stepping the waveform.
    if (!this.playing && this.writeIdx - this.readIdx >= this.prebuffer) this.playing = true;

    if (this.playing) {
      for (; i < out.length; i++) {
        const idx = Math.floor(this.readIdx);
        // Two samples are needed to interpolate between.
        if (idx + 1 >= this.writeIdx) {
          this.playing = false;
          break;
        }
        const frac = this.readIdx - idx;
        const a = this.buf[idx];
        out[i] = a + (this.buf[idx + 1] - a) * frac;
        this.readIdx += this.step;
      }
    }

    for (; i < out.length; i++) out[i] = 0;

    // Every other output channel gets the same mono signal.
    for (let c = 1; c < channels.length; c++) channels[c].set(out);

    if (++this.quanta % REPORT_EVERY === 0) this.report();
    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
