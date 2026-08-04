/**
 * Mic capture worklet. Downsamples the AudioContext rate to 16kHz mono and
 * emits 16-bit PCM frames for Azure. PLAN.md §8.1.
 *
 * Capture is GATED on the mic being open. While it is closed this emits no
 * audio frames at all — not silence, not dropped-on-arrival frames, nothing.
 * The mic button is the only thing that opens it.
 *
 * The RMS level keeps flowing either way, because two things need it while the
 * mic is shut: the mic-check meter, and the room-noise floor that end-of-speech
 * detection measures itself against.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.cursor = 0;
    this.lastSample = 0;
    this.out = [];
    this.frameSize = 640; // 40ms at 16kHz
    this.capturing = false;
    this.levelCounter = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'capture') {
        this.capturing = !!e.data.value;
        // Whatever is half-assembled belongs to the other side of the gate.
        this.out.length = 0;
        this.cursor = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || ch.length === 0) return true;

    // The level runs whether or not we are capturing: the mic check needs it
    // before a session exists, and the noise floor has to be measured from the
    // quiet BEFORE the child starts talking to be worth anything.
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    if (++this.levelCounter % 4 === 0) {
      this.port.postMessage({ type: 'level', value: rms });
    }

    if (!this.capturing) {
      this.cursor = 0;
      return true;
    }

    // Linear-interpolating resample with a cursor that survives block boundaries.
    let i = this.cursor;
    while (i < ch.length) {
      const idx = Math.floor(i);
      const frac = i - idx;
      const a = idx === 0 ? this.lastSample : ch[idx - 1];
      const b = ch[idx];
      this.out.push(a + (b - a) * frac);
      i += this.ratio;
    }
    this.cursor = i - ch.length;
    this.lastSample = ch[ch.length - 1];

    while (this.out.length >= this.frameSize) {
      const chunk = this.out.splice(0, this.frameSize);
      const pcm = new Int16Array(chunk.length);
      for (let n = 0; n < chunk.length; n++) {
        const s = Math.max(-1, Math.min(1, chunk[n]));
        pcm[n] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: 'audio', buffer: pcm.buffer }, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
