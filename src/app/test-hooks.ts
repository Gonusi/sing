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
  AppState, Command, DeviceSettings, Gesture, LogEvent, RawHit, RawNote, Recognizer, Sec, Session, SingTestApi, View,
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
    /** like the contract's play, plus slicing; throws if `at` already passed after decoding */
    play(url: string, at?: Sec, opts?: PlayOptions): Promise<Sec>;
  };
  capture: SingTestApi['capture'] & {
    /** named capture of a track's strip output (after on/off) or the master bus (trackId null/undefined) */
    begin(key: string, trackId?: string | null): void;
    end(key: string): Promise<CaptureSummary>;
    /** real-dsp re-detection on a finished named capture, optionally only [from, to) context time */
    analyze(key: string, kind: 'notes' | 'drums', from?: Sec, to?: Sec): Analysed;
    /** RMS / peak of a finished named capture inside [from, to) */
    level(key: string, from?: Sec, to?: Sec): { rms: number; peak: number };
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

  // ---- captures ----
  const nodeFor = (trackId?: string | null): AudioNode => {
    if (!trackId) return engine.master;
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
      level(key, from, to) {
        return levels(sliceResult(finished(key), from, to).pcm);
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
