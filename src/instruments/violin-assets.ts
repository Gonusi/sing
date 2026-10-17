// [instruments] Violin assets, prepared once per sample rate and cached at module level (AudioBuffers can be used
// by any context): 8 VSCO 2 violin sustain samples (public/samples/violin, credits in CREDITS.txt) and the room
// impulse response. Preparation per sample: mono, leading silence trimmed, cut at its loop end, level-normalised,
// and a crossfade baked into the end so the region [loopStart, loopEnd) loops without a click (a note can sustain
// for any length without refreshing its source).
import type { Sec } from '../types.ts';
import type { Ctx } from './shared.ts';

export interface ViolinSample {
  name: string;
  /** the pitch the sample really plays, in fractional MIDI (note + measured tuning) */
  root: number;
  /** mono, starts at the bow onset, loop crossfade baked in, length = loopEnd */
  buffer: AudioBuffer;
  loopStart: Sec;
  loopEnd: Sec;
}

export interface ViolinAssets {
  /** sorted by root, low to high */
  samples: ViolinSample[];
  /** mono impulse response of the small room */
  room: AudioBuffer;
}

/**
 * The samples, their tuning and their loop regions (measured 2026-10-17, see notes/instruments.md):
 * - cents: the median pitch over 0.5–7.6 s (YIN). The recordings carry natural vibrato of ±15–20 cents at ~5 Hz,
 *   so no synthetic vibrato is added.
 * - loop: [start, end) in seconds after the onset. The 12–17 s recordings contain bow changes (periodicity breaks
 *   of 0.4–1.1 at G3 3.69 s, E4 3.19/6.28 s, G4 3.21/6.36 s, G5 6.10 s); a note plays from 0 to the loop end and then
 *   loops, so the end sits before the first one. Only [0, end) is kept: 45 s × 48 kHz × 4 B ≈ 8.7 MB in all.
 */
const SAMPLE_TABLE = [
  { name: 'G3', midi: 55, cents: -2, loop: [1.0, 3.5] },
  { name: 'C4', midi: 60, cents: 0, loop: [1.5, 7.5] },
  { name: 'E4', midi: 64, cents: 0, loop: [1.0, 3.0] },
  { name: 'G4', midi: 67, cents: 2, loop: [1.0, 3.0] },
  { name: 'C5', midi: 72, cents: 6, loop: [1.5, 7.5] },
  { name: 'E5', midi: 76, cents: 11, loop: [1.5, 7.5] },
  { name: 'G5', midi: 79, cents: 5, loop: [1.5, 5.9] },
  { name: 'C6', midi: 84, cents: -9, loop: [1.5, 7.5] },
] as const satisfies readonly { name: string; midi: number; cents: number; loop: readonly [Sec, Sec] }[];

/** Equal-power crossfade baked into the end of the loop region (needs loop start ≥ this + 0.4 s of sustain). */
const LOOP_XFADE: Sec = 0.3;
/** Onset = first sample above this fraction of the peak (−40 dB); the mp3s start with ~27 ms of encoder delay. */
const ONSET_FRACTION = 0.01;
/** Keep this much before the detected onset. */
const ONSET_PREROLL: Sec = 0.002;
/** Every sample is scaled to this RMS over [NORM_FROM, loopEnd), so crossfades between samples keep the level. */
const TARGET_RMS = 0.12;
const NORM_FROM: Sec = 0.5;
/**
 * Slow level drift inside a recording (bow pressure, ±2–3 dB over seconds) is flattened by this fraction
 * (0 = untouched, 1 = constant level), measured in LEVEL_WINDOW windows (long enough to ignore the ~5 Hz vibrato).
 * Without it, a legato crossfade into another sample, or a loop wrap, can jump by 3 dB.
 */
const FLATTEN = 0.8;
const LEVEL_WINDOW: Sec = 0.25;
const LEVEL_HOP: Sec = 0.05;
/** the bow attack before this keeps its natural shape (the gain there is the gain at this time) */
const ATTACK_KEEP: Sec = 0.25;

/** Small warm room: length, pre-delay, amplitude decay time constant (RT60 ≈ 6.9 τ ≈ 1.1 s), noise colour. */
const ROOM_SECONDS: Sec = 0.9;
const ROOM_PREDELAY: Sec = 0.008;
const ROOM_DECAY_TAU: Sec = 0.16;
const ROOM_TONE_HZ = 4000;
/** fixed seed: the same impulse response, so renders are reproducible */
const ROOM_SEED = 0x5157;

const cache = new Map<number, Promise<ViolinAssets>>();
const ready = new Map<number, ViolinAssets>();

/** Fetch, decode and prepare everything for `ctx.sampleRate` (cached). Progress 0..1. */
export function loadViolinAssets(ctx: Ctx, onProgress?: (fraction: number) => void): Promise<ViolinAssets> {
  const rate = ctx.sampleRate;
  let pending = cache.get(rate);
  if (!pending) {
    pending = prepare(ctx, onProgress).then((assets) => {
      ready.set(rate, assets);
      return assets;
    });
    pending.catch(() => cache.delete(rate));
    cache.set(rate, pending);
  } else {
    void pending.then(() => onProgress?.(1));
  }
  return pending;
}

/** The prepared assets, synchronously; any cached rate serves (an AudioBuffer plays at its own rate). */
export function violinAssets(sampleRate: number): ViolinAssets {
  const assets = ready.get(sampleRate) ?? ready.values().next().value;
  if (!assets) throw new Error('[instruments] preloadInstruments() must resolve before createVoice("violin")');
  return assets;
}

async function prepare(ctx: Ctx, onProgress?: (fraction: number) => void): Promise<ViolinAssets> {
  const steps = SAMPLE_TABLE.length + 1;
  let done = 0;
  const step = () => onProgress?.(++done / steps);
  const samples = await Promise.all(
    SAMPLE_TABLE.map(async (entry) => {
      const url = `${import.meta.env.BASE_URL}samples/violin/${entry.name}.mp3`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`[instruments] ${url}: HTTP ${res.status}`);
      const decoded = await ctx.decodeAudioData(await res.arrayBuffer());
      const sample = prepareSample(ctx, decoded, entry.name, entry.midi + entry.cents / 100, entry.loop);
      step();
      return sample;
    }),
  );
  const room = makeRoomImpulse(ctx);
  step();
  return { samples: samples.sort((a, b) => a.root - b.root), room };
}

function prepareSample(
  ctx: Ctx,
  decoded: AudioBuffer,
  name: string,
  root: number,
  loop: readonly [Sec, Sec],
): ViolinSample {
  const sr = decoded.sampleRate;
  const mono = toMono(decoded);
  const onset = Math.max(0, findOnset(mono) - Math.round(ONSET_PREROLL * sr));
  const length = Math.min(Math.round(loop[1] * sr), mono.length - onset);
  const buffer = ctx.createBuffer(1, length, sr);
  const x = buffer.getChannelData(0);
  x.set(mono.subarray(onset, onset + length));
  const loopStartFrame = Math.round(loop[0] * sr);
  scale(x, TARGET_RMS / rms(x, Math.round(NORM_FROM * sr), length));
  flattenLevel(x, sr);
  bakeLoopCrossfade(x, loopStartFrame, length, Math.round(LOOP_XFADE * sr));
  return { name, root, buffer, loopStart: loopStartFrame / sr, loopEnd: length / sr };
}

function toMono(b: AudioBuffer): Float32Array {
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const ch = b.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / b.numberOfChannels;
  }
  return out;
}

function findOnset(x: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  const threshold = peak * ONSET_FRACTION;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > threshold) return i;
  return 0;
}

function rms(x: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, to - from)) || 1;
}

function scale(x: Float32Array, k: number): void {
  for (let i = 0; i < x.length; i++) x[i] *= k;
}

/** pull the slow level of `x` towards TARGET_RMS by FLATTEN (gain interpolated between window centres) */
function flattenLevel(x: Float32Array, sr: number): void {
  const win = Math.round(LEVEL_WINDOW * sr);
  const hop = Math.round(LEVEL_HOP * sr);
  const keep = Math.round(ATTACK_KEEP * sr);
  const centres: number[] = [];
  const gains: number[] = [];
  for (let start = 0; start + win <= x.length; start += hop) {
    const c = start + win / 2;
    if (c < keep) continue;
    centres.push(c);
    gains.push((TARGET_RMS / rms(x, start, start + win)) ** FLATTEN);
  }
  if (!gains.length) return;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    while (k + 1 < centres.length && centres[k + 1] <= i) k++;
    const next = Math.min(k + 1, centres.length - 1);
    const span = centres[next] - centres[k];
    const w = span > 0 ? Math.min(1, Math.max(0, (i - centres[k]) / span)) : 0;
    x[i] *= gains[k] + (gains[next] - gains[k]) * w;
  }
}

/**
 * Make [a, b) loop seamlessly: the last `n` frames before b fade from the original into the frames just before a,
 * so when playback wraps from b to a the waveform continues exactly where it would have (equal power, since the two
 * stretches of a vibrato note are uncorrelated).
 */
function bakeLoopCrossfade(x: Float32Array, a: number, b: number, n: number): void {
  const len = Math.min(n, a);
  for (let i = 0; i < len; i++) {
    const w = ((i + 0.5) / len) * (Math.PI / 2);
    x[b - len + i] = x[b - len + i] * Math.cos(w) + x[a - len + i] * Math.sin(w);
  }
}

/** Exponentially decaying low-passed noise, deterministic. */
function makeRoomImpulse(ctx: Ctx): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.round(ROOM_SECONDS * sr);
  const buffer = ctx.createBuffer(1, n, sr);
  const x = buffer.getChannelData(0);
  const pre = Math.round(ROOM_PREDELAY * sr);
  const k = 1 - Math.exp((-2 * Math.PI * ROOM_TONE_HZ) / sr);
  const random = mulberry32(ROOM_SEED);
  let lp = 0;
  for (let i = pre; i < n; i++) {
    lp += k * (random() * 2 - 1 - lp);
    x[i] = lp * Math.exp(-(i - pre) / sr / ROOM_DECAY_TAU);
  }
  return buffer;
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
