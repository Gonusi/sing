// [dsp] The user's own drum sounds: a feature vector per hit and nearest-template classification. Pure.
//
// hitFeatures(samples from the onset, sampleRate) — level-independent, HIT_FEATURE_SEC (80 ms) of audio:
//   [0..6]  log10 share of the power in 7 octave bands 100–200 … 6.4–12.8 kHz (power summed over 512-sample Hann frames,
//           hop 256; < 100 Hz is ignored: phone mics cut it anyway)
//   [7]     log2(spectral centroid / 1 kHz)
//   [8]     log10 spectral flatness over 200 Hz–8 kHz (noise ≈ 0, a hum ≪ 0)
//   [9]     log2(zero-crossing rate / 1 kHz)
//   [10]    decay: dB(first 25 ms / last 40 ms) / 20
// classifyByTemplates: each feature is scaled by its pooled within-kind spread across the templates (floored at
// MIN_FEATURE_SPREAD, so one tight kind cannot dominate); the distance to a kind is the distance to its nearest
// template (RMS over features of the scaled differences). Null when there are no templates or the best distance is
// above MAX_TEMPLATE_DISTANCE (then the fixed rules decide).
import FFT from 'fft.js';
import type { DrumKind, DrumTemplate } from '../types.ts';

// ---------- constants ----------
/** audio needed after the onset (the detector holds a hit this long before classifying it) */
export const HIT_FEATURE_SEC = 0.08;
export const FEATURE_FFT_SIZE = 512;
export const FEATURE_HOP = 256;
export const FEATURE_BANDS_HZ: readonly (readonly [number, number])[] = [
  [100, 200],
  [200, 400],
  [400, 800],
  [800, 1600],
  [1600, 3200],
  [3200, 6400],
  [6400, 12800],
];
export const FLATNESS_BAND_HZ = [200, 8000] as const;
export const DECAY_HEAD_SEC = 0.025;
export const DECAY_TAIL_SEC = 0.04;
export const FEATURE_COUNT = FEATURE_BANDS_HZ.length + 4;
/** a feature's spread never counts as smaller than this (feature units: log10 / log2 / dB/20) */
export const MIN_FEATURE_SPREAD = 0.15;
/** farther than this (RMS of spread-scaled differences) from every template = unknown → rules */
export const MAX_TEMPLATE_DISTANCE = 4;
const TINY = 1e-12;

let fft: FFT | null = null;
let spectrum: number[] = [];
const frame = new Float64Array(FEATURE_FFT_SIZE);
const hann = new Float64Array(FEATURE_FFT_SIZE).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FEATURE_FFT_SIZE));
const power = new Float64Array(FEATURE_FFT_SIZE / 2 + 1);

/** feature vector of one hit from the samples starting at its onset (≥ HIT_FEATURE_SEC; missing samples count as 0) */
export function hitFeatures(samples: Float32Array, sampleRate: number): number[] {
  if (!fft) {
    fft = new FFT(FEATURE_FFT_SIZE);
    spectrum = fft.createComplexArray();
  }
  const f = fft;
  const n = Math.round(HIT_FEATURE_SEC * sampleRate);
  const at = (i: number) => (i < samples.length ? samples[i] : 0);
  power.fill(0);
  for (let off = 0; off + FEATURE_FFT_SIZE <= n || off === 0; off += FEATURE_HOP) {
    for (let i = 0; i < FEATURE_FFT_SIZE; i++) frame[i] = at(off + i) * hann[i];
    f.realTransform(spectrum, frame);
    for (let k = 0; k < power.length; k++) power[k] += spectrum[2 * k] ** 2 + spectrum[2 * k + 1] ** 2;
  }
  const binHz = sampleRate / FEATURE_FFT_SIZE;
  const bands = FEATURE_BANDS_HZ.map(() => 0);
  let total = 0;
  let weighted = 0;
  let logSum = 0;
  let linSum = 0;
  let flatBins = 0;
  for (let k = 1; k < power.length; k++) {
    const hz = k * binHz;
    if (hz < FEATURE_BANDS_HZ[0][0]) continue;
    const p = power[k];
    total += p;
    weighted += p * hz;
    FEATURE_BANDS_HZ.forEach(([lo, hi], b) => {
      if (hz >= lo && hz < hi) bands[b] += p;
    });
    if (hz >= FLATNESS_BAND_HZ[0] && hz < FLATNESS_BAND_HZ[1]) {
      logSum += Math.log(p + TINY);
      linSum += p;
      flatBins++;
    }
  }
  const out = bands.map((b) => Math.log10(b / (total + TINY) + 1e-4));
  out.push(Math.log2(Math.max(weighted / (total + TINY), 50) / 1000));
  out.push(flatBins > 0 ? Math.log10(Math.exp(logSum / flatBins) / (linSum / flatBins + TINY) + 1e-6) : -6);
  let crossings = 0;
  for (let i = 1; i < n; i++) if (at(i - 1) >= 0 !== at(i) >= 0) crossings++;
  out.push(Math.log2(Math.max((crossings / n) * sampleRate, 20) / 1000));
  const energy = (from: number, to: number) => {
    let e = 0;
    for (let i = from; i < to; i++) e += at(i) * at(i);
    return e / Math.max(1, to - from);
  };
  const head = energy(0, Math.round(DECAY_HEAD_SEC * sampleRate));
  const tail = energy(n - Math.round(DECAY_TAIL_SEC * sampleRate), n);
  out.push((10 * Math.log10((head + TINY) / (tail + TINY))) / 20);
  return out;
}

/** per-feature spread: pooled within-kind standard deviation over the templates, floored */
export function featureSpreads(templates: DrumTemplate[]): number[] {
  const d = templates[0]?.features.length ?? 0;
  const sum = new Array<number>(d).fill(0);
  let dof = 0;
  for (const kind of new Set(templates.map((t) => t.kind))) {
    const group = templates.filter((t) => t.kind === kind);
    if (group.length < 2) continue;
    for (let j = 0; j < d; j++) {
      const mean = group.reduce((a, t) => a + t.features[j], 0) / group.length;
      for (const t of group) sum[j] += (t.features[j] - mean) ** 2;
    }
    dof += group.length - 1;
  }
  return sum.map((s) => Math.max(MIN_FEATURE_SPREAD, dof > 0 ? Math.sqrt(s / dof) : 0));
}

/** RMS of the spread-scaled differences */
export function templateDistance(a: number[], b: number[], spreads: number[]): number {
  let s = 0;
  for (let j = 0; j < spreads.length; j++) s += ((a[j] - b[j]) / spreads[j]) ** 2;
  return Math.sqrt(s / Math.max(1, spreads.length));
}

/** the kind of the nearest template and its distance (Infinity without usable templates) */
export function nearestTemplate(features: number[], templates: DrumTemplate[]): { kind: DrumKind | null; distance: number } {
  const usable = templates.filter((t) => t.features.length === features.length && features.length > 0);
  if (usable.length === 0) return { kind: null, distance: Infinity };
  const spreads = featureSpreads(usable);
  let kind: DrumKind | null = null;
  let distance = Infinity;
  for (const t of usable) {
    const dist = templateDistance(features, t.features, spreads);
    if (dist < distance) {
      distance = dist;
      kind = t.kind;
    }
  }
  return { kind, distance };
}

/** nearest template's kind, or null when there are no templates or the hit is far from all of them */
export function classifyByTemplates(features: number[], templates: DrumTemplate[]): DrumKind | null {
  const best = nearestTemplate(features, templates);
  return best.distance <= MAX_TEMPLATE_DISTANCE ? best.kind : null;
}
