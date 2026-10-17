// [voice] Dev page driver for dev/voice/check.ts. Boots the REAL audio engine + test mic + recogniser and exposes
// window.__voice. Two modes:
//   real (default) fixtures go through mic.inject() into the real mic path (worklet → ring → recogniser), in real
//                  time; touch-down = the fixture's first sample, begin() HOLD_DELAY later, end() after the speech.
//   ?fast          a fake MicFeed and a fake clock: the fixture is pushed as 512-sample blocks as fast as the worker
//                  takes them. Same chunking and the same reply sequence as real mode → same commands, no timing.
// Times in reports: seconds of AudioContext time (real mode only).
import type { Command, MicBlock, MicFeed, Sec, VoiceStatus } from '../../src/types.ts';
import { createAudioEngine, type AudioEngine } from '../../src/audio/context.ts';
import { createMic } from '../../src/audio/mic.ts';
import { createRecognizer, type TraceEvent } from '../../src/voice/recognizer.ts';

export interface HoldOptions {
  /** fixture url (served by the check through page.route) */
  url: string;
  /** seconds from the file start */
  speechEnd: Sec;
  /** begin() this long after touch-down (holdStart fires at 300 ms) */
  holdDelaySec: Sec;
  /** end() this long after speechEnd (may be past the file's end: the bed / silence continues) */
  releaseAfterSec: Sec;
  /** the fixture starts this long after touch-down (bed only before it); default 0 */
  leadSec?: Sec;
  /** continuous room-noise bed under everything, RMS dBFS (like test-hooks mic.noise: white, low-passed 9 kHz) */
  bedDbfs?: number | null;
}

export interface HoldReport {
  /** what end() resolved with */
  command: Command | null;
  /** the first onCommand */
  fired: Command | null;
  /** onCommand calls during this hold (must be ≤ 1) */
  fireCount: number;
  /** onCommand time − speech end (negative = before the speech ended); real mode only */
  firedAfterSpeechEnd: Sec | null;
  /** onCommand time − end() call; real mode only */
  firedAfterRelease: Sec | null;
  /** end() call → end() resolved; real mode only */
  endResolveSec: Sec | null;
  /** onPartial texts, t = seconds after touch-down (real mode) or reply index (fast mode) */
  partials: { t: number; text: string }[];
  /** every reply of the hold (dev/voice/replay.ts) */
  trace: TraceEvent[];
}

export interface LoadReport {
  ms: number;
  status: VoiceStatus;
  /** [ms since load() started, fraction] */
  progress: [number, number][];
  error: string | null;
}

export interface VoicePage {
  booted: boolean;
  error: string | null;
  mode: 'real' | 'fast';
  sampleRate: number;
  load(): Promise<LoadReport>;
  status(): VoiceStatus;
  hold(o: HoldOptions): Promise<HoldReport>;
  /** main-thread JS heap (Chromium only) */
  jsHeap(): number | null;
}

declare global {
  interface Window {
    __voice: VoicePage;
  }
}

const FAST = new URLSearchParams(location.search).has('fast');
/** ?grammar=<JSON phrase list>: evaluate another grammar (dev/voice/compare-grammars.ts) */
const GRAMMAR = new URLSearchParams(location.search).get('grammar') ?? undefined;
const MODEL_URL = new URL(`${import.meta.env.BASE_URL}vosk/vosk-model-small-en-us-0.15.tar.gz`, location.href).href;
/** the worklet's block size (mic blocks are this long) */
const BLOCK_SAMPLES = 512;
/** inject this far ahead so the buffer source starts exactly at `at` */
const INJECT_LEAD_SEC = 0.15;
const POLL_MS = 4;
/** the composed hold audio runs this long past the release (covers end()'s tail) */
const TIMELINE_AFTER_RELEASE_SEC = 0.3;
const BED_LOWPASS_HZ = 9000;
const BED_SEED = 0x5eed;

/** add seeded white noise through an RBJ 2nd-order low-pass, RMS `dbfs` (the e2e test mic's noise bed) */
function bedNoise(out: Float32Array, sampleRate: number, dbfs: number): void {
  const w = (2 * Math.PI * BED_LOWPASS_HZ) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(out.length);
  let rng = BED_SEED, x1 = 0, x2 = 0, y1 = 0, y2 = 0, sum = 0;
  for (let i = 0; i < y.length; i++) {
    const x0 = ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    const y0 = b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    (x2 = x1), (x1 = x0), (y2 = y1), (y1 = y0);
    y[i] = y0;
    sum += y0 * y0;
  }
  const g = 10 ** (dbfs / 20) / Math.sqrt(sum / Math.max(1, y.length));
  for (let i = 0; i < out.length; i++) out[i] += y[i] * g;
}
/** fast mode pushes audio at this multiple of real time (the worker must keep up: see notes/voice.md) */
const FAST_SPEEDUP = Number(new URLSearchParams(location.search).get('speedup')) || 4;

const page = { booted: false, error: null, mode: FAST ? 'fast' : 'real' } as VoicePage;
window.__voice = page;
const out = document.getElementById('out')!;
const btn = document.getElementById('start') as HTMLButtonElement;

btn.addEventListener('click', () => {
  // synchronous inside the gesture, like main.ts
  const engineP = createAudioEngine();
  boot(engineP).catch((e: unknown) => {
    page.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    out.textContent = page.error;
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fake feed (fast mode) ----------

interface FakeFeed extends MicFeed {
  reset(): void;
  /** append one block; subscribers see it unless `silent` (pre-touch audio that only goes into the ring) */
  push(samples: Float32Array): void;
  now(): Sec;
}

function createFakeFeed(sampleRate: number): FakeFeed {
  let held: Float32Array[] = [];
  let frames = 0;
  const subs = new Set<(b: MicBlock) => void>();
  return {
    sampleRate,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    read(from, to) {
      const all = new Float32Array(frames);
      let o = 0;
      for (const b of held) {
        all.set(b, o);
        o += b.length;
      }
      const a = Math.max(0, Math.round(from * sampleRate));
      const b = Math.min(frames, Math.round(to * sampleRate));
      return { t: a / sampleRate, samples: b > a ? all.slice(a, b) : new Float32Array(0) };
    },
    inject() {
      throw new Error('fake feed: use push()');
    },
    reset() {
      held = [];
      frames = 0;
      subs.clear();
    },
    push(samples) {
      const block: MicBlock = { frame: frames, samples };
      held.push(samples);
      frames += samples.length;
      for (const cb of [...subs]) cb(block);
    },
    now: () => frames / sampleRate,
  };
}

// ---------- boot ----------

async function boot(engineP: Promise<AudioEngine>): Promise<void> {
  const engine = await engineP;
  const { ctx } = engine;
  page.sampleRate = ctx.sampleRate;
  const fake = FAST ? createFakeFeed(ctx.sampleRate) : null;
  const mic = fake ?? (await createMic(engine, { test: true, ec: false }));
  // fast mode: the recogniser only reads ctx.currentTime, so a fake clock is enough
  const recCtx = fake ? ({ get currentTime() { return fake.now(); } } as AudioContext) : ctx;
  let trace: TraceEvent[] = [];
  const recognizer = createRecognizer({ ctx: recCtx, mic, modelUrl: MODEL_URL, onTrace: (e) => trace.push(e), grammarJson: GRAMMAR });

  const decode = async (url: string): Promise<AudioBuffer> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fixture ${url}: HTTP ${res.status}`);
    return ctx.decodeAudioData(await res.arrayBuffer());
  };
  const waitUntil = async (t: Sec) => {
    while (ctx.currentTime < t) await sleep(POLL_MS);
  };

  /** collects onCommand / onPartial for one hold */
  const watch = (now: () => number) => {
    const r = { fired: null as Command | null, firedAt: null as number | null, fireCount: 0, partials: [] as { t: number; text: string }[] };
    const offC = recognizer.onCommand((c) => {
      r.fireCount++;
      if (!r.fired) {
        r.fired = c;
        r.firedAt = now();
      }
    });
    const offP = recognizer.onPartial((text) => r.partials.push({ t: now(), text }));
    trace = [];
    return { r, trace: () => trace, off: () => (offC(), offP()) };
  };

  /** the hold's audio from touch-down: bed + fixture at leadSec, long enough for the release + tail */
  async function timeline(o: HoldOptions): Promise<{ x: Float32Array<ArrayBuffer>; speechEnd: Sec }> {
    const f = (await decode(o.url)).getChannelData(0);
    const sr = ctx.sampleRate;
    const lead = Math.round((o.leadSec ?? 0) * sr);
    const speechEnd = (o.leadSec ?? 0) + o.speechEnd;
    const x = new Float32Array(Math.max(lead + f.length, Math.ceil((speechEnd + o.releaseAfterSec + TIMELINE_AFTER_RELEASE_SEC) * sr)));
    if (o.bedDbfs !== undefined && o.bedDbfs !== null) bedNoise(x, sr, o.bedDbfs);
    for (let i = 0; i < f.length; i++) x[lead + i] += f[i];
    return { x, speechEnd };
  }

  async function holdReal(o: HoldOptions): Promise<HoldReport> {
    const tl = await timeline(o);
    const buf = ctx.createBuffer(1, tl.x.length, ctx.sampleRate);
    buf.copyToChannel(tl.x, 0);
    const tDown = ctx.currentTime + INJECT_LEAD_SEC;
    (mic as MicFeed).inject(buf, tDown);
    await waitUntil(tDown + o.holdDelaySec);
    const w = watch(() => ctx.currentTime);
    recognizer.begin(tDown);
    const speechEndAt = tDown + tl.speechEnd;
    await waitUntil(speechEndAt + o.releaseAfterSec);
    const releaseAt = ctx.currentTime;
    const command = await recognizer.end();
    const resolvedAt = ctx.currentTime;
    w.off();
    await waitUntil(tDown + buf.duration); // let the rest of the fixture play out before the next one
    const { fired, firedAt, fireCount, partials } = w.r;
    return {
      command, fired, fireCount,
      firedAfterSpeechEnd: firedAt === null ? null : firedAt - speechEndAt,
      firedAfterRelease: firedAt === null ? null : firedAt - releaseAt,
      endResolveSec: resolvedAt - releaseAt,
      partials: partials.map((p) => ({ t: p.t - tDown, text: p.text })),
      trace: w.trace(),
    };
  }

  async function holdFast(o: HoldOptions): Promise<HoldReport> {
    const feed = fake!;
    const { x, speechEnd } = await timeline(o);
    feed.reset();
    let replies = 0;
    const w = watch(() => replies++);
    const sr = ctx.sampleRate;
    const beginAt = Math.round(o.holdDelaySec * sr);
    const endAt = Math.min(x.length, Math.round((speechEnd + o.releaseAfterSec) * sr));
    const t0 = performance.now();
    /** keep the worker from falling behind: at most FAST_SPEEDUP × real time */
    const pace = async (frame: number) => {
      const ahead = (frame / sr / FAST_SPEEDUP) * 1000 - (performance.now() - t0);
      if (ahead > POLL_MS) await sleep(ahead);
    };
    let i = 0;
    for (; i + BLOCK_SAMPLES <= beginAt; i += BLOCK_SAMPLES) feed.push(x.slice(i, i + BLOCK_SAMPLES));
    recognizer.begin(0);
    for (; i < endAt; i += BLOCK_SAMPLES) {
      await pace(i);
      feed.push(x.slice(i, Math.min(endAt, i + BLOCK_SAMPLES)));
    }
    const ended = recognizer.end();
    // the mic keeps delivering after the release (end() feeds a short tail)
    for (; i < x.length; i += BLOCK_SAMPLES) {
      await pace(i);
      feed.push(x.slice(i, i + BLOCK_SAMPLES));
    }
    const command = await ended;
    w.off();
    const { fired, fireCount, partials } = w.r;
    return { command, fired, fireCount, firedAfterSpeechEnd: null, firedAfterRelease: null, endResolveSec: null, partials, trace: w.trace() };
  }

  page.status = () => recognizer.status;
  page.load = async () => {
    const t0 = performance.now();
    const progress: [number, number][] = [];
    let error: string | null = null;
    try {
      await recognizer.load((f) => progress.push([Math.round(performance.now() - t0), Number(f.toFixed(3))]));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return { ms: Math.round(performance.now() - t0), status: recognizer.status, progress, error };
  };
  page.hold = (o) => (FAST ? holdFast(o) : holdReal(o));
  page.jsHeap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
  page.booted = true;
  out.textContent = `booted (${page.mode}, ${ctx.sampleRate} Hz)`;
}
