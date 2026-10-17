// [engine] AudioWorklet processors, loaded by audio/context.ts via `?worker&url` + ctx.audioWorklet.addModule.
// Runs in AudioWorkletGlobalScope: no DOM, no imports. Two processors:
//   'mic-tap'     — posts MicBlock-shaped messages {frame, samples} of BLOCK_SIZE samples of input channel 0.
//                   frame = context frame of samples[0]. No input connected → zeros, so time keeps flowing.
//   'capture-tap' — records its input (mono mix) with the frame of the first sample; flushes on {type:'stop'}.
// Both use port.postMessage with transferable buffers (no SharedArrayBuffer: GitHub Pages sends no COOP/COEP).
// Frame stamps come from our own counter (FrameClock), not straight from `currentFrame`: under load Chromium's
// currentFrame occasionally reads one quantum (128 frames) behind, also on a node's very first process() call,
// while the samples are contiguous (measured: content = stamp + 128). A wrong stamp makes the block overlap its predecessor, and
// the analysis restarts on any discontinuity (lost notes/hits).

declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: new (options?: unknown) => WorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
interface WorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

/** samples per mic-tap message (4 render quanta of 128) */
const BLOCK_SIZE = 512;
/** samples per capture-tap message */
const CAPTURE_CHUNK = 8192;
/** currentFrame further than this from our count is a real discontinuity → re-sync at once */
const RESYNC_FRAMES = 256;

/**
 * Frame of each render quantum. Counts process() calls; the observed glitch only ever reads currentFrame BEHIND
 * the true frame (content = stamp + 128, never the reverse), so the count only moves forward:
 *   currentFrame behind the count (< 2 quanta)  → a glitched read: ignore it;
 *   currentFrame ahead of it (< 2 quanta)       → our count was behind (the first sync read a glitch): 'correct';
 *   ≥ RESYNC_FRAMES either way                  → a real discontinuity: 'jump'.
 */
class FrameClock {
  private next = -1;
  /** what the last at() did to the count */
  change: 'none' | 'correct' | 'jump' = 'none';
  at(current: number, n: number): number {
    this.change = 'none';
    if (this.next < 0 || Math.abs(current - this.next) >= RESYNC_FRAMES) {
      if (this.next >= 0) this.change = 'jump';
      this.next = current;
    } else if (current > this.next) {
      this.change = 'correct';
      this.next = current;
    }
    const f = this.next;
    this.next += n;
    return f;
  }
}

/** Accumulates render quanta into fixed blocks, stamping each block with the frame of its first sample. */
class BlockAccumulator {
  private buf: Float32Array;
  private fill = 0;
  private frame = 0;
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
    this.buf = new Float32Array(size);
  }
  /** append `n` samples (zeros when src is null) whose first sample is context frame `frame`; returns full blocks */
  push(src: Float32Array | null, n: number, frame: number, out: (frame: number, samples: Float32Array) => void, correction = false): void {
    // a block holds contiguous frames only. A clock correction (our count was behind) re-stamps the held samples:
    // they are contiguous with this quantum and were stamped too early by the same amount. A jump starts a new block.
    if (this.fill > 0 && frame !== this.frame + this.fill) {
      if (correction) this.frame = frame - this.fill;
      else this.flush(out);
    }
    let i = 0;
    while (i < n) {
      if (this.fill === 0) this.frame = frame + i;
      const take = Math.min(n - i, this.size - this.fill);
      if (src) this.buf.set(src.subarray(i, i + take), this.fill);
      else this.buf.fill(0, this.fill, this.fill + take);
      this.fill += take;
      i += take;
      if (this.fill === this.size) this.flush(out);
    }
  }
  /** emit what is held (a partial block) */
  flush(out: (frame: number, samples: Float32Array) => void): void {
    if (this.fill === 0) return;
    const full = this.fill === this.size ? this.buf : this.buf.slice(0, this.fill);
    out(this.frame, full);
    this.buf = new Float32Array(this.size);
    this.fill = 0;
  }
}

/** mic-tap: channel 0 of the input, in BLOCK_SIZE blocks */
class MicTap extends AudioWorkletProcessor implements WorkletProcessor {
  private readonly acc = new BlockAccumulator(BLOCK_SIZE);
  private readonly clock = new FrameClock();
  private readonly post = (frame: number, samples: Float32Array) => {
    this.port.postMessage({ frame, samples }, [samples.buffer]);
  };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const ch0 = inputs[0]?.[0] ?? null;
    const n = ch0?.length ?? outputs[0]?.[0]?.length ?? 128;
    const frame = this.clock.at(currentFrame, n);
    this.acc.push(ch0, n, frame, this.post, this.clock.change === 'correct');
    return true;
  }
}

/** capture-tap: mono mix of the input, posted in CAPTURE_CHUNK chunks; {type:'stop'} flushes and ends */
class CaptureTap extends AudioWorkletProcessor implements WorkletProcessor {
  private readonly acc = new BlockAccumulator(CAPTURE_CHUNK);
  private readonly clock = new FrameClock();
  private stopped = false;
  private mono = new Float32Array(128);
  private readonly post = (frame: number, samples: Float32Array) => {
    this.port.postMessage({ type: 'chunk', frame, samples }, [samples.buffer]);
  };
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'stop') this.stopped = true;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.stopped) {
      this.acc.flush(this.post);
      this.port.postMessage({ type: 'end' });
      return false;
    }
    const chans = inputs[0] ?? [];
    const n = chans[0]?.length ?? outputs[0]?.[0]?.length ?? 128;
    if (this.mono.length !== n) this.mono = new Float32Array(n);
    this.mono.fill(0);
    for (const ch of chans) for (let i = 0; i < n; i++) this.mono[i] += ch[i] / chans.length;
    const frame = this.clock.at(currentFrame, n);
    this.acc.push(chans.length ? this.mono : null, n, frame, this.post, this.clock.change === 'correct');
    return true;
  }
}

registerProcessor('mic-tap', MicTap);
registerProcessor('capture-tap', CaptureTap);
