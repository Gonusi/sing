// [instruments] Signal measurements for the instruments check (pure functions on Float32Array PCM, no DOM).
// Envelope: 20 ms RMS windows every 5 ms, in dBFS (floored at FLOOR_DB).
import type { Sec } from '../../src/types.ts';

export const FLOOR_DB = -100;
export const ENV_WIN: Sec = 0.02;
export const ENV_HOP: Sec = 0.005;

export interface Envelope {
  sr: number;
  /** dBFS per frame; frame i covers [i·hop, i·hop + win) */
  db: Float32Array;
}

export function db(x: number): number {
  return x > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(x)) : FLOOR_DB;
}

export function rmsDb(x: Float32Array, sr: number, t0: Sec, t1: Sec): number {
  const a = Math.max(0, Math.floor(t0 * sr));
  const b = Math.min(x.length, Math.floor(t1 * sr));
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return db(Math.sqrt(s / Math.max(1, b - a)));
}

export function envelope(x: Float32Array, sr: number): Envelope {
  const win = Math.round(ENV_WIN * sr);
  const hop = Math.round(ENV_HOP * sr);
  const n = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop; i < f * hop + win; i++) s += x[i] * x[i];
    out[f] = db(Math.sqrt(s / win));
  }
  return { sr, db: out };
}

/** frame index whose window starts at or just after t */
function frame(t: Sec): number {
  return Math.max(0, Math.round(t / ENV_HOP));
}

/** frame start time → time of the window centre */
function centre(f: number): Sec {
  return f * ENV_HOP + ENV_WIN / 2;
}

function slice(env: Envelope, t0: Sec, t1: Sec): Float32Array {
  return env.db.subarray(frame(t0), Math.max(frame(t0), Math.min(env.db.length, frame(t1 - ENV_WIN) + 1)));
}

function median(v: ArrayLike<number>): number {
  const s = Array.from(v).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
}

/** how far (dB) the envelope falls below its own median inside [t0, t1] */
export function maxDip(env: Envelope, t0: Sec, t1: Sec): number {
  const s = slice(env, t0, t1);
  const m = median(s);
  let min = Infinity;
  for (const v of s) min = Math.min(min, v);
  return m - min;
}

export function medianDb(env: Envelope, t0: Sec, t1: Sec): number {
  return median(slice(env, t0, t1));
}

export function minDb(env: Envelope, t0: Sec, t1: Sec): number {
  let min = Infinity;
  for (const v of slice(env, t0, t1)) min = Math.min(min, v);
  return min;
}

export function maxDb(env: Envelope, t0: Sec, t1: Sec): number {
  let max = -Infinity;
  for (const v of slice(env, t0, t1)) max = Math.max(max, v);
  return max;
}

/**
 * Level rise at a note boundary (dB): the loudest 20 ms window in [tb, tb + 100 ms] against the loudest in the
 * 200 ms before tb. Peak against peak over one vibrato period (~5 Hz): the samples' natural ±2.5 dB tremolo cancels
 * out, while a new attack or a crossfade bump still stands above the previous peaks.
 */
export function boundaryRise(env: Envelope, tb: Sec): number {
  return maxDb(env, tb, tb + 0.1) - maxDb(env, tb - 0.2, tb - 0.01);
}

/** attacks: the envelope rises ≥ RISE_DB within 80 ms to above −45 dBFS; attacks closer than 150 ms merge */
export function attacks(env: Envelope): Sec[] {
  const RISE_DB = 10;
  const LOOKBACK = Math.round(0.08 / ENV_HOP);
  const MERGE: Sec = 0.15;
  const out: Sec[] = [];
  for (let f = LOOKBACK; f < env.db.length; f++) {
    if (env.db[f] < -45) continue;
    let min = Infinity;
    for (let k = f - LOOKBACK; k < f; k++) min = Math.min(min, env.db[k]);
    if (env.db[f] - min < RISE_DB) continue;
    const t = centre(f);
    if (out.length && t - out[out.length - 1] < MERGE) continue;
    out.push(t);
  }
  return out;
}

/** first time (window centre) the envelope reaches (its max over [t0, t1] − dropDb) after t0 */
export function onsetTime(env: Envelope, t0: Sec, t1: Sec, dropDb = 20): Sec | null {
  const s = slice(env, t0, t1);
  let top = -Infinity;
  for (const v of s) top = Math.max(top, v);
  for (let i = 0; i < s.length; i++) if (s[i] >= top - dropDb) return centre(frame(t0) + i);
  return null;
}

/** length of the stretch where the envelope is within dropDb of its max */
export function soundLength(env: Envelope, dropDb = 20): Sec {
  let peak = -Infinity;
  for (const v of env.db) peak = Math.max(peak, v);
  let first = -1;
  let last = -1;
  env.db.forEach((v, f) => {
    if (v < peak - dropDb) return;
    if (first < 0) first = f;
    last = f;
  });
  return first < 0 ? 0 : (last - first) * ENV_HOP;
}

/** largest sample-to-sample jump in [t0, t1] relative to the 99.9th percentile jump (a click stands out ≫ 3) */
export function jumpRatio(x: Float32Array, sr: number, t0: Sec, t1: Sec): { ratio: number; at: Sec } {
  const a = Math.max(1, Math.floor(t0 * sr));
  const b = Math.min(x.length, Math.floor(t1 * sr));
  const d = new Float32Array(b - a);
  let max = 0;
  let at = 0;
  for (let i = a; i < b; i++) {
    const v = Math.abs(x[i] - x[i - 1]);
    d[i - a] = v;
    if (v > max) {
      max = v;
      at = i / sr;
    }
  }
  const sorted = d.sort();
  const p999 = sorted[Math.floor(sorted.length * 0.999)] || 1e-12;
  return { ratio: max / p999, at };
}

/**
 * Median fundamental (Hz) over [t0, t1] with YIN, searching lags for expectedHz / 2.2 … expectedHz × 2.2
 * (an octave error either way would be found).
 */
export function fundamental(x: Float32Array, sr: number, t0: Sec, t1: Sec, expectedHz: number): number | null {
  const W = 2048;
  const minTau = Math.max(2, Math.floor(sr / (expectedHz * 2.2)));
  const maxTau = Math.ceil(sr / (expectedHz / 2.2));
  const hop = Math.round(0.04 * sr);
  const found: number[] = [];
  const d = new Float64Array(maxTau + 2);
  for (let start = Math.floor(t0 * sr); start + W + maxTau + 1 < Math.min(x.length, t1 * sr); start += hop) {
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const v = x[start + j] - x[start + j + tau];
        s += v * v;
      }
      d[tau] = s;
    }
    let cum = 0;
    const cmnd = new Float64Array(maxTau + 2);
    cmnd[0] = 1;
    for (let tau = 1; tau <= maxTau + 1; tau++) {
      cum += d[tau];
      cmnd[tau] = cum > 0 ? (d[tau] * tau) / cum : 1;
    }
    let best = -1;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] >= 0.15) continue;
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
    if (best < 0) continue;
    const a = cmnd[best - 1];
    const b = cmnd[best];
    const c = cmnd[best + 1];
    const den = a - 2 * b + c;
    found.push(sr / (best + (den !== 0 ? (a - c) / (2 * den) : 0)));
  }
  return found.length ? median(found) : null;
}

export function cents(hz: number, midi: number): number {
  return 1200 * Math.log2(hz / (440 * 2 ** ((midi - 69) / 12)));
}

/**
 * Energy (dB) within ±halfCents of `hz` in [t0, t1] (Hann window, zero-padded 8192-point FFT). Used to tell legato
 * from a re-attack: after a legato move the previous pitch is gone; after a re-attack the old note is still
 * releasing underneath the new one.
 */
export function bandDb(x: Float32Array, sr: number, t0: Sec, t1: Sec, hz: number, halfCents = 50): number {
  const N = 8192;
  const a = Math.floor(t0 * sr);
  const len = Math.min(N, Math.floor((t1 - t0) * sr));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < len; i++) re[i] = (x[a + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
  fft(re, im);
  const lo = Math.floor((hz * 2 ** (-halfCents / 1200) * N) / sr);
  const hi = Math.ceil((hz * 2 ** (halfCents / 1200) * N) / sr);
  let e = 0;
  for (let k = lo; k <= hi; k++) e += re[k] * re[k] + im[k] * im[k];
  return 10 * Math.log10(e + 1e-30);
}

/**
 * Click detector for sustained periodic tones (a bowed string's sawtooth edges hide clicks from a first-difference
 * test). For each 5 ms hop: e = min over lags T in [sr/hzHigh·0.97, sr/hzLow·1.03] of
 * Σ(x[n] − x[n−T])² / Σ(x[n]² + x[n−T]²) over 10 ms. A periodic signal gives a small e; a discontinuity (unfaded
 * loop seam, hard sample switch) gives a spike for the frames spanning it. Returns the max and median of e.
 */
export function periodicityBreak(
  x: Float32Array,
  sr: number,
  t0: Sec,
  t1: Sec,
  hzRange: (t: Sec) => [low: number, high: number],
  window: Sec = 0.01,
): { max: number; median: number; at: Sec } {
  const W = Math.round(window * sr);
  const hop = Math.round(0.005 * sr);
  const es: number[] = [];
  let max = 0;
  let at = t0;
  for (let n0 = Math.floor(t0 * sr); n0 + W < Math.min(x.length, t1 * sr); n0 += hop) {
    const [lo, hi] = hzRange(n0 / sr);
    if (!(lo > 0 && hi > 0)) continue; // the caller excludes this frame
    const tMin = Math.max(2, Math.floor((sr / hi) * 0.97));
    const tMax = Math.ceil((sr / lo) * 1.03);
    if (n0 - tMax < 0) continue;
    let best = Infinity;
    for (let T = tMin; T <= tMax; T++) {
      let num = 0;
      let den = 0;
      for (let n = n0; n < n0 + W; n++) {
        const d = x[n] - x[n - T];
        num += d * d;
        den += x[n] * x[n] + x[n - T] * x[n - T];
      }
      if (den > 0) best = Math.min(best, num / den);
    }
    if (!Number.isFinite(best)) continue;
    es.push(best);
    if (best > max) {
      max = best;
      at = n0 / sr;
    }
  }
  return { max, median: median(es), at };
}

/** magnitude-weighted mean frequency over [t0, t1] (Hann-windowed 2048-point FFT frames) */
export function spectralCentroid(x: Float32Array, sr: number, t0: Sec, t1: Sec): number {
  const N = 2048;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let num = 0;
  let den = 0;
  for (let start = Math.floor(t0 * sr); start + N <= Math.min(x.length, t1 * sr); start += N / 2) {
    for (let i = 0; i < N; i++) {
      re[i] = x[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      num += m * ((k * sr) / N);
      den += m;
    }
  }
  return den > 0 ? num / den : 0;
}

/** in-place iterative radix-2 FFT */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const ai = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
      }
    }
  }
}

export function peak(x: Float32Array): number {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

export function allFinite(x: Float32Array): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}

/** 16-bit PCM mono WAV, base64 */
export function wavBase64(x: Float32Array, sr: number): string {
  const bytes = new Uint8Array(44 + x.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
