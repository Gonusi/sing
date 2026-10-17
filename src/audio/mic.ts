// [engine] getUserMedia (or, with ?test, no device at all) → mic-tap worklet → 2 s ring buffer → subscribers.
//
// Graph:  [MediaStreamSource | inject() buffer sources | loopback delay] → tap (AudioWorkletNode 'mic-tap') → engine.sink
// Every block is stamped by the worklet with the context frame of its first sample, so
//   stamp (context seconds) = frame / sampleRate.
// Always channel 0: iOS with echoCancellation off can deliver stereo with audio only in the left channel.
import type { MicBlock, MicFeed, Sec } from '../types.ts';
import type { AudioEngine } from './context.ts';

export interface Mic extends MicFeed {
  /** re-open the device with a new echoCancellation setting */
  setEc(ec: boolean): Promise<void>;
  /** MediaStreamTrack.getSettings().latency when the browser reports it */
  reportedLatency(): Sec | null;
  dispose(): void;
  // ---- engine extensions ----
  /** test only: route the speaker feed (engine.limiter) → DelayNode(delaySec) → mic input (speaker→mic). Returns undo. */
  loopback(delaySec: Sec): () => void;
  /** context time just after the newest sample received (0 before the first block) */
  latest(): Sec;
  /** diagnostics: blocks received, discontinuities (block.frame ≠ previous end) and frames missing in them */
  stats(): { blocks: number; gaps: number; gapFrames: number; recent: [number, number, number][] };
}

export interface MicOptions {
  /** true: never call getUserMedia; audio only comes from inject() */
  test: boolean;
  ec: boolean;
}

/** ring buffer length */
const RING_SEC = 2;
/** don't hammer getUserMedia when a track keeps ending */
const REOPEN_MIN_INTERVAL_MS = 2000;
/** DelayNode maxDelayTime headroom for loopback() */
const LOOPBACK_MAX_DELAY_SEC = 2;

export async function createMic(engine: AudioEngine, opts: MicOptions): Promise<Mic> {
  const { ctx } = engine;
  const sampleRate = ctx.sampleRate;
  const ring = createRing(Math.ceil(RING_SEC * sampleRate));
  const subs = new Set<(b: MicBlock) => void>();
  const tap = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  tap.connect(engine.sink);
  const stats = { blocks: 0, gaps: 0, gapFrames: 0, recent: [] as [number, number, number][] };
  tap.port.onmessage = (e: MessageEvent<MicBlock>) => {
    const block = e.data;
    const expected = ring.endFrame();
    if (stats.blocks > 0 && block.frame !== expected) {
      stats.gaps++;
      stats.gapFrames += block.frame - expected;
      stats.recent.push([block.frame, block.frame - expected, block.samples.length]);
      if (stats.recent.length > 8) stats.recent.shift();
    }
    stats.blocks++;
    ring.write(block.frame, block.samples);
    for (const cb of [...subs]) {
      try {
        cb(block);
      } catch (err) {
        console.error('mic subscriber failed', err);
      }
    }
  };

  const device = createDevice(ctx, tap, opts.ec);
  if (!opts.test) await device.open();
  // re-acquire a mic track that ended (iOS background, device lost) once audio is back / the page is visible
  let lastReopen = 0;
  const reopenIfEnded = () => {
    if (opts.test || !device.ended() || document.visibilityState !== 'visible') return;
    if (performance.now() - lastReopen < REOPEN_MIN_INTERVAL_MS) return;
    lastReopen = performance.now();
    void device.open().catch((e) => console.error('mic reopen failed', e));
  };
  device.onEnded = reopenIfEnded;
  const offLifecycle = engine.onLifecycle((ev) => {
    if (ev === 'resumed') reopenIfEnded();
  });
  document.addEventListener('visibilitychange', reopenIfEnded);

  return {
    sampleRate,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    read(from, to) {
      return ring.read(Math.round(from * sampleRate), Math.round(to * sampleRate), sampleRate);
    },
    inject(buf, at) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(tap);
      src.onended = () => src.disconnect();
      src.start(at);
    },
    async setEc(ec) {
      device.ec = ec;
      if (!opts.test) await device.open();
    },
    reportedLatency: () => device.latency(),
    dispose() {
      offLifecycle();
      document.removeEventListener('visibilitychange', reopenIfEnded);
      device.close();
      subs.clear();
      tap.port.onmessage = null;
      tap.disconnect();
    },
    loopback(delaySec) {
      const d = ctx.createDelay(Math.max(LOOPBACK_MAX_DELAY_SEC, delaySec + 0.1));
      d.delayTime.setValueAtTime(delaySec, ctx.currentTime);
      engine.limiter.connect(d);
      d.connect(tap);
      return () => {
        engine.limiter.disconnect(d);
        d.disconnect();
      };
    },
    latest: () => ring.endFrame() / sampleRate,
    stats: () => ({ ...stats }),
  };
}

// ---------- the real input device ----------

interface Device {
  ec: boolean;
  /** called when the live track ends on its own */
  onEnded: () => void;
  open(): Promise<void>;
  close(): void;
  ended(): boolean;
  latency(): Sec | null;
}

function createDevice(ctx: AudioContext, tap: AudioNode, ec: boolean): Device {
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  const dev: Device = {
    ec,
    onEnded: () => {},
    async open() {
      dev.close();
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: dev.ec, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      stream = s;
      s.getAudioTracks().forEach((t) => t.addEventListener('ended', () => stream === s && dev.onEnded()));
      source = ctx.createMediaStreamSource(s);
      source.connect(tap);
    },
    close() {
      source?.disconnect();
      stream?.getTracks().forEach((t) => t.stop());
      source = null;
      stream = null;
    },
    ended: () => !stream || stream.getAudioTracks().every((t) => t.readyState === 'ended'),
    latency() {
      const track = stream?.getAudioTracks()[0];
      const lat = (track?.getSettings() as MediaTrackSettings & { latency?: number } | undefined)?.latency;
      return typeof lat === 'number' && Number.isFinite(lat) ? lat : null;
    },
  };
  return dev;
}

// ---------- ring buffer of samples, addressed by context frame ----------

interface Ring {
  write(frame: number, samples: Float32Array): void;
  /** samples of frames [f0, f1), clipped to what is held; t = time of the first returned sample */
  read(f0: number, f1: number, sampleRate: number): { t: Sec; samples: Float32Array };
  /** frame just after the newest sample */
  endFrame(): number;
}

function createRing(size: number): Ring {
  const buf = new Float32Array(size);
  let end = 0; // frame after the newest written sample
  let start = 0; // oldest valid frame
  const put = (frame: number, v: number) => (buf[frame % size] = v);
  return {
    write(frame, samples) {
      if (frame > end) for (let f = Math.max(end, frame - size); f < frame; f++) put(f, 0); // gap → silence
      for (let i = 0; i < samples.length; i++) put(frame + i, samples[i]);
      if (end === 0 && start === 0) start = frame;
      end = Math.max(end, frame + samples.length);
      start = Math.max(start, end - size);
    },
    read(f0, f1, sampleRate) {
      const a = Math.max(f0, start);
      const b = Math.min(f1, end);
      if (b <= a) return { t: Math.max(f0, Math.min(f1, end)) / sampleRate, samples: new Float32Array(0) };
      const out = new Float32Array(b - a);
      for (let f = a; f < b; f++) out[f - a] = buf[f % size];
      return { t: a / sampleRate, samples: out };
    },
    endFrame: () => end,
  };
}
