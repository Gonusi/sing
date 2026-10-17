// [engine] dev page driver: boots the REAL engine modules (test mic, fake analysis, real instrument stubs/voices)
// and exposes window.__eng for dev/engine/check.ts. Times are context seconds; "stamp" = mic stamp time.
import { del, set } from 'idb-keyval';
import type { Command, Gesture, LogEvent, Sec, Session, Voice } from '../../src/types.ts';
import { LIMITER_DELAY_SEC, MASTER_GAIN, createAudioEngine, type AudioEngine } from '../../src/audio/context.ts';
import { createMic, type Mic } from '../../src/audio/mic.ts';
import { calibrate, playClick, type CalibrationResult } from '../../src/audio/latency.ts';
import { createCapture } from '../../src/audio/capture.ts';
import { startProbe } from '../../src/audio/probe.ts';
import { DEVICE_KEY, SESSION_KEY, loadDevice } from '../../src/app/session.ts';
import { createController, type EngineController } from '../../src/app/controller.ts';
import { createScheduler, type SchedEvent } from '../../src/loop/clock.ts';
import { preloadInstruments } from '../../src/instruments/index.ts';
import { fakeAnalysis } from './fake-analysis.ts';

export interface Eng {
  booted: boolean;
  error: string | null;
  engine: AudioEngine;
  mic: Mic;
  c: EngineController;
  /** every log event since boot (uncapped) */
  events: LogEvent[];
  now(): Sec;
  outLat(): Sec;
  sampleRate: number;
  waitUntil(t: Sec): Promise<void>;
  sleep(sec: Sec): Promise<void>;
  /** inject a sine (amp 0.3) into the mic path so its first sample has stamp `at` */
  tone(at: Sec, midi: number, dur: Sec, amp?: number): void;
  /** inject a short sine burst (drum stand-in) */
  burst(at: Sec, hz: number, dur?: Sec): void;
  gesture(g: Gesture): void;
  command(c: Command, tDown?: Sec): boolean;
  calibrateLoopback(delaySec: Sec): Promise<{ result: CalibrationResult; outLat: Sec; limiterDelay: Sec }>;
  writeSession(s: Session | null): Promise<void>;
  clearStore(): Promise<void>;
  /** scheduler alone, fake voice, any loop length: counts plays vs. the expected occurrences */
  tinyLoop(L: Sec, runSec: Sec): Promise<{ events: SchedEvent[]; plays: number; from: Sec; until: Sec; positions: number[] }>;
  /** probe tone looped back into the mic: measured level */
  probeLevel(): Promise<{ level: number; expected: number }>;
  /** capture master while a click plays at a known time: onset frame vs. expected */
  captureClick(): Promise<{ onsetFrame: number; expectedFrame: number; frames: number }>;
  /** a click through master → limiter: onset frames on both sides (the limiter's look-ahead delay) */
  limiterDelay(): Promise<{ masterFrame: number; limiterFrame: number; sampleRate: number }>;
  /** ?analysis=real: the controller uses src/analysis (dsp), not dev/engine/fake-analysis.ts */
  realAnalysis: boolean;
  /** fetch + decode dev/fixtures/out/<name>.wav and its ground-truth .json */
  loadFixture(name: string): Promise<FixtureTruth>;
  /** inject fixture seconds [from, to) so that fixture time `from` has mic stamp `at` (5 ms fade at the cut) */
  injectFixture(name: string, from: Sec, to: Sec, at: Sec): void;
  /** onChange calls since boot */
  changes: number;
  /** ?real: the mic is getUserMedia (Chromium fake-capture WAV), not the test mic */
  realMic: boolean;
  /** RMS of the last `sec` seconds in the mic ring */
  ringRms(sec: Sec): number;
  /** suspend the context (like an iOS interruption); the engine resumes it itself */
  suspendBriefly(): Promise<void>;
}

export interface FixtureTruth {
  name: string;
  durationSec: number;
  notes: { t: Sec; dur: Sec; midi: number }[];
  hits: { t: Sec; kind: 'kick' | 'snare' | 'hat' }[];
}

declare global {
  interface Window {
    __eng: Eng;
  }
}

const REAL_MIC = new URLSearchParams(location.search).has('real');
const REAL_ANALYSIS = new URLSearchParams(location.search).get('analysis') === 'real';
const eng = { booted: false, error: null, events: [], changes: 0, realMic: REAL_MIC, realAnalysis: REAL_ANALYSIS } as unknown as Eng;
const fixtures = new Map<string, AudioBuffer>();
window.__eng = eng;
const out = document.getElementById('out')!;
const btn = document.getElementById('start') as HTMLButtonElement;

btn.addEventListener('click', () => {
  // synchronous inside the gesture, like main.ts
  const engineP = createAudioEngine();
  boot(engineP).catch((e: unknown) => {
    eng.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    out.textContent = eng.error;
  });
});

async function boot(engineP: Promise<AudioEngine>): Promise<void> {
  const engine = await engineP;
  const { ctx } = engine;
  const mic = await createMic(engine, { test: !REAL_MIC, ec: false });
  const device = await loadDevice();
  await preloadInstruments(ctx);
  const c = await createController({ engine, mic, device, test: true, analysis: REAL_ANALYSIS ? undefined : fakeAnalysis() });
  eng.events.push(...c.logs());
  c.onLog((e) => eng.events.push(e));
  c.onChange(() => void eng.changes++);
  Object.assign(eng, {
    engine, mic, c,
    sampleRate: ctx.sampleRate,
    now: () => ctx.currentTime,
    outLat: () => engine.outLat(),
    waitUntil: (t: Sec) => new Promise<void>((resolve) => {
      const poll = () => (ctx.currentTime >= t ? resolve() : setTimeout(poll, 4));
      poll();
    }),
    sleep: (sec: Sec) => eng.waitUntil(ctx.currentTime + sec),
    tone(at: Sec, midi: number, dur: Sec, amp = 0.3) {
      mic.inject(sineBuffer(ctx, 440 * 2 ** ((midi - 69) / 12), dur, amp), at);
    },
    burst(at: Sec, hz: number, dur = 0.03) {
      mic.inject(sineBuffer(ctx, hz, dur, 0.4), at);
    },
    gesture: (g: Gesture) => c.gesture(g),
    command: (cmd: Command, tDown?: Sec) => c.command(cmd, tDown ?? ctx.currentTime),
    async calibrateLoopback(delaySec: Sec) {
      const undo = mic.loopback(delaySec);
      const outLat = engine.outLat();
      try {
        return { result: await calibrate(engine, mic, {}), outLat, limiterDelay: LIMITER_DELAY_SEC };
      } finally {
        undo();
      }
    },
    async writeSession(s: Session | null) {
      if (s) await set(SESSION_KEY, s);
      else await del(SESSION_KEY);
    },
    async clearStore() {
      await del(SESSION_KEY);
      await del(DEVICE_KEY);
    },
    tinyLoop: (L: Sec, runSec: Sec) => tinyLoop(engine, L, runSec),
    async probeLevel() {
      const undo = mic.loopback(0);
      const p = startProbe(engine, mic);
      await eng.sleep(0.5);
      const level = p.level();
      p.stop();
      undo();
      return { level, expected: (MASTER_GAIN * 10 ** (-24 / 20)) / Math.SQRT2 };
    },
    ringRms(sec: Sec) {
      const r = mic.read(mic.latest() - sec, mic.latest());
      let sum = 0;
      for (const v of r.samples) sum += v * v;
      return r.samples.length ? Math.sqrt(sum / r.samples.length) : 0;
    },
    async suspendBriefly() {
      await ctx.suspend();
      await new Promise<void>((resolve) => {
        const poll = () => (ctx.state === 'running' ? resolve() : setTimeout(poll, 5));
        poll();
      });
    },
    async loadFixture(name: string) {
      // (not new URL(`…${name}`, import.meta.url): Vite rewrites that pattern into a glob import)
      const base = `${import.meta.env.BASE_URL}dev/fixtures/out/${name}`;
      const [wav, truth] = await Promise.all([
        fetch(`${base}.wav`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${name}.wav: ${r.status} (run node dev/make-fixtures.ts)`)))),
        fetch(`${base}.json`).then((r) => r.json() as Promise<FixtureTruth>),
      ]);
      fixtures.set(name, await ctx.decodeAudioData(wav));
      return truth;
    },
    injectFixture(name: string, from: Sec, to: Sec, at: Sec) {
      const src = fixtures.get(name);
      if (!src) throw new Error(`fixture ${name} not loaded`);
      mic.inject(sliceBuffer(ctx, src, from, to), at);
    },
    async limiterDelay() {
      const a = createCapture(engine);
      const b = createCapture(engine);
      a.start(engine.master);
      b.start(engine.limiter);
      const at = ctx.currentTime + 0.2;
      playClick(ctx, engine.master, at);
      await eng.sleep(0.4);
      const [ra, rb] = await Promise.all([a.stop(), b.stop()]);
      const onset = (r: { frame: number; pcm: Float32Array }) => {
        const from = Math.max(0, Math.round((at - 0.05) * ctx.sampleRate) - r.frame);
        for (let i = from; i < r.pcm.length; i++) if (Math.abs(r.pcm[i]) > 0.01) return r.frame + i;
        return -1;
      };
      return { masterFrame: onset(ra), limiterFrame: onset(rb), sampleRate: ctx.sampleRate };
    },
    async captureClick() {
      const cap = createCapture(engine);
      cap.start(engine.master);
      const at = ctx.currentTime + 0.2;
      playClick(ctx, engine.master, at);
      await eng.sleep(0.4);
      const r = await cap.stop();
      // search from 50 ms before the click: whatever else was on the master bus before is not the click
      const from = Math.max(0, Math.round((at - 0.05) * ctx.sampleRate) - r.frame);
      let onset = -1;
      for (let i = from; i < r.pcm.length; i++) if (Math.abs(r.pcm[i]) > 0.01) { onset = i; break; }
      return { onsetFrame: r.frame + onset, expectedFrame: Math.round(at * ctx.sampleRate), frames: r.pcm.length };
    },
  });
  eng.booted = true;
  out.textContent = `booted: ${ctx.sampleRate} Hz, outLat ${(engine.outLat() * 1000).toFixed(1)} ms`;
}

function sliceBuffer(ctx: BaseAudioContext, src: AudioBuffer, from: Sec, to: Sec): AudioBuffer {
  const a = Math.max(0, Math.round(from * src.sampleRate));
  const b = Math.min(src.length, Math.round(to * src.sampleRate));
  const out = ctx.createBuffer(1, b - a, src.sampleRate);
  const x = out.getChannelData(0);
  x.set(src.getChannelData(0).subarray(a, b));
  const fade = Math.round(0.005 * src.sampleRate);
  for (let i = 0; i < fade && i < x.length; i++) x[x.length - 1 - i] *= i / fade;
  return out;
}

function sineBuffer(ctx: BaseAudioContext, hz: number, dur: Sec, amp: number): AudioBuffer {
  const n = Math.round(dur * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const x = buf.getChannelData(0);
  const fade = Math.round(0.003 * ctx.sampleRate);
  for (let i = 0; i < n; i++) {
    const env = i > n - fade ? (n - i) / fade : 1;
    x[i] = amp * env * Math.sin((2 * Math.PI * hz * i) / ctx.sampleRate);
  }
  return buf;
}

/** the scheduler on its own with a tiny loop (L may be shorter than the lookahead window) */
async function tinyLoop(engine: AudioEngine, L: Sec, runSec: Sec) {
  const { ctx } = engine;
  const events: SchedEvent[] = [];
  let plays = 0;
  const output = ctx.createGain();
  const voice: Voice = { kind: 'drums', output, play: () => void plays++, stopAll: () => {}, dispose: () => output.disconnect() };
  const positions = [0, L * 0.25, L * 0.5, L * 0.9];
  let until = 0;
  const sched = createScheduler(engine, {
    onEvent: (e) => events.push(e),
    onTransport: (e) => {
      if (e.action === 'stop') until = e.scheduledUntil?.tiny ?? 0;
    },
  });
  sched.setTracks([{
    track: { id: 'tiny', kind: 'drums', on: true, take: { id: 'k', notes: [], hits: positions.map((pos) => ({ pos, kind: 'kick' as const, vel: 1 })) } },
    voice,
  }]);
  const from = ctx.currentTime + engine.outLat() + 0.03;
  sched.start(from, L, from);
  await eng.sleep(runSec);
  sched.stop(ctx.currentTime);
  sched.dispose();
  return { events, plays, from, until, positions };
}
