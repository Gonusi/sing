// [tester] window.__sing: the SingTestApi contract plus e2e extras (SingE2eApi). Loaded by main.ts with a dynamic
// import, only with ?test, so nothing here reaches the main chunk.
//
// Time: every Sec is AudioContext.currentTime seconds (= the scheduler's and the mic stamps' clock).
// Rules the e2e specs rely on:
// - log() is UNCAPPED: controller.logs() at install (boot events) + every onLog event after it.
// - command() / voice.inject() go through deps.run (blip + toast + controller.command), exactly like a voice
//   command; they return `accepted`, read from the controller's 'command' log event.
// - Captured PCM stays in the page (named captures); specs get summaries and re-detections back, never raw arrays.
// - analyze() runs the REAL dsp (pitch tracker + segmenter, onset detector) on captured audio; frame = context frame
//   of pcm[0], so detections come out in context time (the time the app PLAYED them).
import type {
  AppState, Command, DeviceSettings, Gesture, LogEvent, PitchFrame, RawHit, RawNote, Recognizer, Sec, Session, SingTestApi, View,
  VoiceStatus,
} from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';
import type { EngineController } from './controller.ts';
import { createCapture, type Capture, type CaptureResult } from '../audio/capture.ts';
import { calibrate as runCalibration, type CalibrationResult } from '../audio/latency.ts';
import { createPitchTracker } from '../analysis/pitch.ts';
import { createSegmenter } from '../analysis/segment.ts';
import { createOnsetDetector } from '../analysis/drums.ts';
import { parseCommand } from '../voice/grammar.ts';
import { playBlip } from '../instruments/blip.ts';

export interface TestHookDeps {
  engine: AudioEngine;
  mic: Mic;
  /** main.ts passes the EngineController (logs, flush) */
  controller: EngineController;
  recognizer: Recognizer;
  /** run a command exactly like a recognised voice command (blip + toast + controller.command) */
  run(c: Command, tDown: Sec): void;
}

/** analysis block size fed to the dsp (any size gives identical results, see notes/dsp.md) */
const ANALYZE_BLOCK = 512;
/** default lead for mic.play when no time is given */
const PLAY_LEAD_SEC = 0.1;
/** waitUntil poll period */
const POLL_MS = 5;
/** noise bed: chunk length, how far ahead chunks are queued, refill period */
const NOISE_CHUNK_SEC = 2;
const NOISE_AHEAD_SEC = 1;
const NOISE_REFILL_MS = 200;
const NOISE_LOWPASS_HZ = 9000;
const SALIENCE_HARMONICS = 6;
/** capture.begin(key, OUT_KEY) taps the limiter output (what the speakers get) instead of a track */
export const OUT_KEY = '__out';

export interface PlayOptions {
  /** start this far into the file (seconds) */
  from?: Sec;
  /** play only this long (seconds); the rest of the file is never injected */
  dur?: Sec;
  /** linear gain applied to the samples */
  gain?: number;
}

export interface Analysed {
  /** pitch tracker + segmenter output (melodic), context time */
  notes: RawNote[];
  /** onset detector output (drums), context time */
  hits: RawHit[];
  /** context time of pcm[0] and just after the last sample */
  t0: Sec;
  t1: Sec;
  rms: number;
  peak: number;
}

export interface CaptureSummary {
  frame: number;
  sampleRate: number;
  length: number;
  t0: Sec;
  t1: Sec;
  rms: number;
  peak: number;
}

export interface CalibrationRun extends CalibrationResult {
  /** engine.outLat() read just before calibrate() started (expected inLat = loopback delay − this) */
  outLatAtStart: Sec;
}

export interface VoiceInjection {
  text: string;
  command: Command | null;
  tDown: Sec;
  accepted: boolean | null;
}

export interface SingE2eApi extends SingTestApi {
  /** accepted (true) or refused/ignored (false); null when no command log event appeared */
  command(c: Command, tDown?: Sec): boolean | null;
  logSince(t: Sec): LogEvent[];
  outLat(): Sec;
  sampleRate(): number;
  /** resolves with currentTime once currentTime >= t */
  waitUntil(t: Sec): Promise<Sec>;
  mic: {
    /** fetch + decode `url` into the cache (call before timing-critical code) */
    load(url: string): Promise<{ duration: Sec; sampleRate: number }>;
    /**
     * decode base64 file bytes into the cache under `url` (no network). WebKit's service worker takes fetches away from
     * Playwright's page.route once it controls the page, so specs hand fixtures over this way.
     */
    put(url: string, base64: string): Promise<{ duration: Sec; sampleRate: number }>;
    /** true when `url` is in the decode cache (loaded or put) */
    cached(url: string): boolean;
    /**
     * continuous room-noise bed into the mic from now (white noise low-passed at 9 kHz, RMS `dbfs`), like the fixtures'
     * own room noise; null stops it. The test mic is otherwise digital silence, and a fixture starting out of
     * digital silence is a sharp onset a real mic never produces.
     */
    noise(dbfs: number | null): void;
    /** like the contract's play, plus slicing; throws if `at` already passed after decoding */
    play(url: string, at?: Sec, opts?: PlayOptions): Promise<Sec>;
  };
  capture: SingTestApi['capture'] & {
    /** named capture of a track's strip output (after on/off), the master bus (trackId null/undefined) or the limiter output ('__out') */
    begin(key: string, trackId?: string | null): void;
    end(key: string): Promise<CaptureSummary>;
    /** real-dsp re-detection on a finished named capture, optionally only [from, to) context time */
    analyze(key: string, kind: 'notes' | 'drums', from?: Sec, to?: Sec): Analysed;
    /** real pitch-tracker frames (t = window centre, context time) of a finished named capture inside [from, to) */
    frames(key: string, from?: Sec, to?: Sec): PitchFrame[];
    /** RMS / peak of a finished named capture inside [from, to) */
    level(key: string, from?: Sec, to?: Sec): { rms: number; peak: number };
    /**
     * harmonic salience of each candidate MIDI note in [from, to): sum of Hann-windowed Goertzel power at harmonics
     * 1..SALIENCE_HARMONICS. For pitches below the tracker's 70 Hz floor (low bass).
     */
    salience(key: string, from: Sec, to: Sec, midis: number[]): number[];
  };
  analyze(pcm: Float32Array, sampleRate: number, frame: number, kind: 'notes' | 'drums'): Analysed;
  /** route master → DelayNode(delaySec) → mic input; replaces an earlier loopback */
  loopback(delaySec: Sec): void;
  loopbackOff(): void;
  calibrate(): Promise<CalibrationRun>;
  flush(): Promise<void>;
  voice: {
    /** parsed command → deps.run; unparsable text → err blip, no command. Default tDown: the open hold's, else now */
    inject(text: string, tDown?: Sec): boolean | null;
    status(): VoiceStatus;
    injections(): VoiceInjection[];
  };
  /** what the UI shows (DOM): command overlay on, its text, toast text, pill class */
  ui(): { holding: boolean; partial: string; toast: string; pill: string };
}

declare global {
  interface Window {
    __sing?: SingE2eApi;
  }
}

export function installTestHooks(deps: TestHookDeps): void {
  const { engine, mic, controller, recognizer, run } = deps;
  const { ctx } = engine;

  // ---- uncapped log ----
  const events: LogEvent[] = [...controller.logs()];
  /** tDown of the hold that is open right now (from the controller's gesture log) */
  let openHold: Sec | null = null;
  controller.onLog((e) => {
    events.push(e);
    if (e.type !== 'gesture') return;
    const g = e.data as unknown as Gesture;
    if (g.type === 'holdStart') openHold = g.tDown;
    if (g.type === 'holdEnd' && openHold === g.tDown) openHold = null;
  });

  /** run through deps.run and read `accepted` from the command event it logged */
  const runCommand = (c: Command, tDown: Sec): boolean | null => {
    const before = events.length;
    run(c, tDown);
    for (let i = events.length - 1; i >= before; i--) {
      if (events[i].type === 'command') return Boolean(events[i].data?.accepted);
    }
    return null;
  };

  // ---- fixtures into the mic ----
  const decoded = new Map<string, Promise<AudioBuffer>>();
  const load = (url: string): Promise<AudioBuffer> => {
    let p = decoded.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`fixture ${url}: HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((b) => ctx.decodeAudioData(b));
      p.catch(() => decoded.delete(url));
      decoded.set(url, p);
    }
    return p;
  };
  const slice = (buf: AudioBuffer, o: PlayOptions): AudioBuffer => {
    const sr = buf.sampleRate;
    const a = Math.max(0, Math.round((o.from ?? 0) * sr));
    const b = Math.min(buf.length, o.dur === undefined ? buf.length : a + Math.round(o.dur * sr));
    const gain = o.gain ?? 1;
    if (a === 0 && b === buf.length && gain === 1) return buf;
    const out = ctx.createBuffer(1, Math.max(1, b - a), sr);
    const src = buf.getChannelData(0).subarray(a, b);
    const dst = out.getChannelData(0);
    for (let i = 0; i < src.length; i++) dst[i] = src[i] * gain;
    return out;
  };

  // ---- noise bed: contiguous chunks scheduled at exact frames ----
  let noiseTimer: ReturnType<typeof setInterval> | null = null;
  const noiseBed = (dbfs: number | null) => {
    if (noiseTimer !== null) clearInterval(noiseTimer);
    noiseTimer = null;
    if (dbfs === null) return;
    const sr = ctx.sampleRate;
    const n = Math.round(NOISE_CHUNK_SEC * sr);
    let rng = 0x5eed;
    const chunks = Array.from({ length: 3 }, () => {
      const buf = ctx.createBuffer(1, n, sr);
      const x = buf.getChannelData(0);
      lowpassNoise(x, sr, () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1, 10 ** (dbfs / 20));
      return buf;
    });
    let nextFrame = Math.ceil((ctx.currentTime + 0.05) * sr);
    let i = 0;
    const refill = () => {
      while (nextFrame / sr < ctx.currentTime + NOISE_AHEAD_SEC) {
        mic.inject(chunks[i++ % chunks.length], nextFrame / sr);
        nextFrame += n;
      }
    };
    refill();
    noiseTimer = setInterval(refill, NOISE_REFILL_MS);
  };

  // ---- captures ----
  const nodeFor = (trackId?: string | null): AudioNode => {
    if (!trackId) return engine.master;
    if (trackId === OUT_KEY) return engine.limiter;
    const n = controller.voiceOutput(trackId);
    if (!n) throw new Error(`no output for track ${trackId}`);
    return n;
  };
  const named = new Map<string, { cap: Capture; result: CaptureResult | null }>();
  let contractCapture: Capture | null = null;
  const sliceResult = (r: CaptureResult, from?: Sec, to?: Sec) => {
    const a = from === undefined ? 0 : Math.max(0, Math.round(from * r.sampleRate) - r.frame);
    const b = to === undefined ? r.pcm.length : Math.min(r.pcm.length, Math.round(to * r.sampleRate) - r.frame);
    return { frame: r.frame + a, pcm: r.pcm.subarray(a, Math.max(a, b)) };
  };
  const finished = (key: string): CaptureResult => {
    const c = named.get(key);
    if (!c?.result) throw new Error(`capture ${key} not finished`);
    return c.result;
  };

  // ---- loopback ----
  let undoLoopback: (() => void) | null = null;

  const injections: VoiceInjection[] = [];

  const api: SingE2eApi = {
    state: (): AppState => controller.state,
    session: (): Session => controller.session,
    view: (): View => controller.view(),
    log: () => [...events],
    logSince: (t) => events.filter((e) => e.t >= t),
    now: () => ctx.currentTime,
    outLat: () => engine.outLat(),
    sampleRate: () => ctx.sampleRate,
    device: (): DeviceSettings => controller.device,
    setDevice: (patch) => controller.setDevice(patch),
    gesture: (g) => controller.gesture(g),
    command: (c, tDown) => runCommand(c, tDown ?? ctx.currentTime),
    waitUntil: (t) =>
      new Promise<Sec>((resolve) => {
        const poll = () => (ctx.currentTime >= t ? resolve(ctx.currentTime) : setTimeout(poll, POLL_MS));
        poll();
      }),
    mic: {
      async load(url) {
        const b = await load(url);
        return { duration: b.duration, sampleRate: b.sampleRate };
      },
      cached: (url) => decoded.has(url),
      noise: noiseBed,
      async put(url, base64) {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const p = ctx.decodeAudioData(bytes.buffer);
        decoded.set(url, p);
        const b = await p;
        return { duration: b.duration, sampleRate: b.sampleRate };
      },
      async play(url, at, opts = {}) {
        const buf = slice(await load(url), opts);
        const t = at ?? ctx.currentTime + PLAY_LEAD_SEC;
        if (t < ctx.currentTime) {
          throw new Error(`mic.play(${url}) at ${t.toFixed(3)} already passed (now ${ctx.currentTime.toFixed(3)}); mic.load() it first`);
        }
        mic.inject(buf, t);
        return t;
      },
    },
    capture: {
      start(trackId) {
        contractCapture = createCapture(engine);
        contractCapture.start(nodeFor(trackId));
      },
      async stop() {
        const c = contractCapture;
        contractCapture = null;
        return c ? c.stop() : { frame: 0, sampleRate: ctx.sampleRate, pcm: new Float32Array(0) };
      },
      begin(key, trackId) {
        const cap = createCapture(engine);
        cap.start(nodeFor(trackId));
        named.set(key, { cap, result: null });
      },
      async end(key) {
        const c = named.get(key);
        if (!c) throw new Error(`no capture ${key}`);
        c.result = await c.cap.stop();
        const r = c.result;
        return {
          frame: r.frame, sampleRate: r.sampleRate, length: r.pcm.length,
          t0: r.frame / r.sampleRate, t1: (r.frame + r.pcm.length) / r.sampleRate, ...levels(r.pcm),
        };
      },
      analyze(key, kind, from, to) {
        const r = finished(key);
        const s = sliceResult(r, from, to);
        return analyze(s.pcm, r.sampleRate, s.frame, kind);
      },
      frames(key, from, to) {
        const r = finished(key);
        const s = sliceResult(r, from, to);
        const tracker = createPitchTracker();
        const out: PitchFrame[] = [];
        for (let i = 0; i < s.pcm.length; i += ANALYZE_BLOCK) {
          out.push(...tracker.push({ frame: s.frame + i, samples: s.pcm.subarray(i, i + ANALYZE_BLOCK) }, r.sampleRate));
        }
        return out;
      },
      level(key, from, to) {
        return levels(sliceResult(finished(key), from, to).pcm);
      },
      salience(key, from, to, midis) {
        const r = finished(key);
        const x = sliceResult(r, from, to).pcm;
        return midis.map((m) => {
          const f0 = 440 * 2 ** ((m - 69) / 12);
          let sum = 0;
          for (let k = 1; k <= SALIENCE_HARMONICS; k++) sum += goertzelPower(x, (k * f0) / r.sampleRate);
          return sum;
        });
      },
    },
    analyze,
    loopback(delaySec) {
      undoLoopback?.();
      undoLoopback = mic.loopback(delaySec);
    },
    loopbackOff() {
      undoLoopback?.();
      undoLoopback = null;
    },
    async calibrate() {
      const outLatAtStart = engine.outLat();
      const r = await runCalibration(engine, mic);
      return { ...r, outLatAtStart };
    },
    flush: () => controller.flush(),
    voice: {
      inject(text, tDown) {
        const t = tDown ?? openHold ?? ctx.currentTime;
        const cmd = parseCommand(text);
        let accepted: boolean | null = null;
        if (cmd) accepted = runCommand(cmd, t);
        else playBlip(ctx, 'err', undefined, engine.master); // "didn't catch that": no command
        injections.push({ text, command: cmd, tDown: t, accepted });
        return accepted;
      },
      status: () => recognizer.status,
      injections: () => [...injections],
    },
    ui: () => ({
      holding: document.querySelector('.cmd-overlay.on') !== null,
      partial: document.querySelector('.cmd-overlay')?.textContent ?? '',
      toast: document.querySelector('.toast')?.textContent ?? '',
      pill: document.querySelector('.pill')?.className ?? '',
    }),
  };
  window.__sing = api;
}

/** real dsp on PCM whose first sample is context frame `frame`; results in context seconds */
export function analyze(pcm: Float32Array, sampleRate: number, frame: number, kind: 'notes' | 'drums'): Analysed {
  const notes: RawNote[] = [];
  const hits: RawHit[] = [];
  const end = (frame + pcm.length) / sampleRate;
  if (kind === 'notes') {
    const tracker = createPitchTracker();
    const seg = createSegmenter();
    for (let i = 0; i < pcm.length; i += ANALYZE_BLOCK) {
      for (const f of tracker.push({ frame: frame + i, samples: pcm.subarray(i, i + ANALYZE_BLOCK) }, sampleRate)) {
        notes.push(...seg.push(f));
      }
    }
    notes.push(...seg.close(end));
  } else {
    const det = createOnsetDetector();
    for (let i = 0; i < pcm.length; i += ANALYZE_BLOCK) {
      hits.push(...det.push({ frame: frame + i, samples: pcm.subarray(i, i + ANALYZE_BLOCK) }, sampleRate));
    }
    hits.push(...det.close(end));
  }
  return { notes, hits, t0: frame / sampleRate, t1: end, ...levels(pcm) };
}

/** power of the Hann-windowed signal at normalised frequency `f` (cycles per sample) */
function goertzelPower(x: Float32Array, f: number): number {
  const n = x.length;
  const coeff = 2 * Math.cos(2 * Math.PI * f);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    const s0 = x[i] * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** white noise through an RBJ 2nd-order low-pass, scaled to RMS `rms` */
function lowpassNoise(x: Float32Array, sampleRate: number, rand: () => number, rms: number): void {
  const w = (2 * Math.PI * NOISE_LOWPASS_HZ) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = rand();
    const y0 = b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
  const g = rms / Math.max(1e-12, levels(x).rms);
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

function levels(pcm: Float32Array): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    sum += a * a;
    if (a > peak) peak = a;
  }
  return { rms: pcm.length ? Math.sqrt(sum / pcm.length) : 0, peak };
}
