/**
 * Audio worklets for the pet.
 *
 * pcm-capture: mic (device rate, e.g. 48 kHz) -> 16-bit PCM at 16 kHz, posted in fixed-size chunks with an RMS level
 *              and the RMS below ~900 Hz (voiced speech lives there; typing, hiss and fans mostly do not), for the
 *              speech gate in speech-gate.js.
 * pcm-player : 16-bit PCM at the context rate (24 kHz) -> speakers, with a small jitter buffer,
 *              instant flush for barge-in, and a level for the mouth animation.
 */

class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { targetRate = 16000, chunkSamples = 640 } = options.processorOptions ?? {};
    this.step = sampleRate / targetRate; // input samples per output sample
    this.chunkSamples = chunkSamples; // 640 samples = 40 ms at 16 kHz
    this.chunk = new Int16Array(chunkSamples);
    this.filled = 0;
    this.sumSquares = 0;
    this.t = 0; // read position for the next output sample, relative to the current block (may be in [-1, 0))
    this.last = 0; // last (filtered) sample of the previous block
    this.lowpass = 0;
    this.alpha = 1 - Math.exp((-2 * Math.PI * 7000) / sampleRate); // one-pole low-pass at ~7 kHz against aliasing
    this.lowAlpha = 1 - Math.exp((-2 * Math.PI * 900) / targetRate); // two one-poles at ~900 Hz on the 16 kHz signal
    this.low1 = 0;
    this.low2 = 0;
    this.lowSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const block = new Float32Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      this.lowpass += this.alpha * (channel[i] - this.lowpass);
      block[i] = this.lowpass;
    }

    let t = this.t;
    while (t < block.length - 1) {
      const index = Math.floor(t);
      const frac = t - index;
      const a = index < 0 ? this.last : block[index];
      const b = block[index + 1];
      const sample = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.chunk[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.sumSquares += sample * sample;
      this.low1 += this.lowAlpha * (sample - this.low1);
      this.low2 += this.lowAlpha * (this.low1 - this.low2);
      this.lowSquares += this.low2 * this.low2;
      if (this.filled === this.chunkSamples) {
        const level = Math.sqrt(this.sumSquares / this.chunkSamples);
        const low = Math.sqrt(this.lowSquares / this.chunkSamples);
        this.port.postMessage({ pcm: this.chunk.buffer, level, low }, [this.chunk.buffer]);
        this.chunk = new Int16Array(this.chunkSamples);
        this.filled = 0;
        this.sumSquares = 0;
        this.lowSquares = 0;
      }
      t += this.step;
    }
    this.last = block[block.length - 1];
    this.t = t - block.length;
    return true;
  }
}

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.buffered = 0;
    this.primed = false;
    this.primeSamples = Math.round(sampleRate * 0.06); // wait for 60 ms of audio before starting, to ride out jitter
    this.levelSum = 0;
    this.levelCount = 0;
    this.blocks = 0;
    this.wasPlaying = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === "push") {
        const pcm = new Int16Array(data.pcm);
        const samples = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
        this.queue.push(samples);
        this.buffered += samples.length;
      } else if (data.type === "clear") {
        this.queue = [];
        this.offset = 0;
        this.buffered = 0;
        this.primed = false;
      } else if (data.type === "flush") {
        this.primed = true; // end of the turn: play whatever is left, however short
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.primed && this.buffered >= this.primeSamples) this.primed = true;

    let written = 0;
    let sum = 0;
    while (this.primed && written < out.length && this.queue.length > 0) {
      const head = this.queue[0];
      const count = Math.min(out.length - written, head.length - this.offset);
      for (let i = 0; i < count; i++) {
        const sample = head[this.offset + i];
        out[written + i] = sample;
        sum += sample * sample;
      }
      written += count;
      this.offset += count;
      this.buffered -= count;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    for (let i = written; i < out.length; i++) out[i] = 0;
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (this.queue.length === 0) this.primed = false;

    const playing = written > 0;
    this.levelSum += sum;
    this.levelCount += out.length;
    if (++this.blocks % 4 === 0 || playing !== this.wasPlaying) {
      this.port.postMessage({ level: Math.sqrt(this.levelSum / Math.max(1, this.levelCount)), playing });
      this.levelSum = 0;
      this.levelCount = 0;
    }
    this.wasPlaying = playing;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
registerProcessor("pcm-player", PcmPlayer);
