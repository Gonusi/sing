// [dsp] Beatbox → RawHit: spectral-flux onsets (FFT 512, hop 256, Hann, fft.js) + kick/snare/hat classifier. Pure.
//
// Onsets: flux = Σ positive rises of log1p(FLUX_LOG_GAIN·|X|) between consecutive frames (|X| scaled so a
//   full-scale sine bin ≈ 1). A frame is an onset when its flux > median + FLUX_SPREAD_FACTOR·σ̂ + FLUX_OFFSET of the
//   previous FLUX_HISTORY_FRAMES frames (σ̂ = 1.4826·MAD: one loud hit in the history must not hide the next soft
//   one, which mean + 2·std did at 16ths), it is the maximum within ±PEAK_HALF_WIDTH_FRAMES, it comes at least
//   MIN_ONSET_GAP_SEC after the previous onset, the RMS of the HIT_GATE_SEC after it reaches HIT_GATE_RMS, and it is
//   a sharp attack: in at least one band (low < KICK_LOW_HZ, mid, high > HAT_HIGH_HZ) the mean power of the FFT
//   frames centred in [onset, onset + ATTACK_SEC] is ATTACK_MIN_RISE_DB above that of the frames centred in
//   [onset − PRE_FROM_SEC, onset − PRE_TO_SEC]. Breaths and decaying tails rise slowly or not at all; per band, so a
//   quiet hat over louder low room noise still counts.
//   Onset time = centre of the peak frame + ONSET_TIME_OFFSET_SEC.
// Classification: band powers summed over the FFT frames inside [onset + CLASSIFY_FROM_SEC, onset + CLASSIFY_TO_SEC],
//   minus the room-noise floor (the quietest NOISE_AVG_FRAMES-frame stretch of the last NOISE_LOOKBACK_SEC); frames
//   below ACTIVE_FRAME_NOISE_RATIO × the floor are skipped (a 40 ms hat leaves most of the span to room noise). Then:
//   kick  if energy < KICK_LOW_HZ is > KICK_LOW_RATIO of the total, or the centroid < KICK_MAX_CENTROID_HZ
//   hat   if the centroid > HAT_MIN_CENTROID_HZ, or energy > HAT_HIGH_HZ is > HAT_HIGH_RATIO of the total
//   snare otherwise
// A hit is returned by the push() whose block reaches the end of its classification span. vel from the peak 10 ms RMS.
import FFT from 'fft.js';
import type { DrumKind, MicBlock, OnsetDetector, RawHit, Sec } from '../types.ts';

// ---------- constants ----------
export const ONSET_FFT_SIZE = 512;
export const ONSET_HOP_SAMPLES = 256;
export const FLUX_LOG_GAIN = 10;
export const FLUX_HISTORY_FRAMES = 40;
/** no onsets until this many frames of history exist (≈ 43 ms; the engine feeds a 0.2 s pre-roll anyway) */
export const FLUX_MIN_HISTORY_FRAMES = 8;
export const FLUX_SPREAD_FACTOR = 2.0;
export const FLUX_OFFSET = 0.55;
/** MAD → standard deviation for normal data */
const MAD_TO_SIGMA = 1.4826;
export const PEAK_HALF_WIDTH_FRAMES = 3;
export const MIN_ONSET_GAP_SEC = 0.06;
export const HIT_GATE_RMS = 0.004;
export const HIT_GATE_SEC = 0.03;
export const ATTACK_SEC = 0.03;
export const ATTACK_MIN_RISE_DB = 6;
export const PRE_FROM_SEC = 0.04;
export const PRE_TO_SEC = 0.01;
export const ONSET_TIME_OFFSET_SEC = 0;
export const CLASSIFY_FROM_SEC = 0.01;
export const CLASSIFY_TO_SEC = 0.07;
export const NOISE_LOOKBACK_SEC = 1.0;
export const NOISE_AVG_FRAMES = 4;
/** the quietest stretch underestimates the mean noise power (it is a minimum); scale it back up */
export const NOISE_FLOOR_BIAS = 1.1;
/** frames of the classification span quieter than this × the noise floor carry no hit and are skipped */
export const ACTIVE_FRAME_NOISE_RATIO = 2;
export const KICK_LOW_HZ = 300;
export const KICK_LOW_RATIO = 0.6;
export const KICK_MAX_CENTROID_HZ = 900;
export const HAT_MIN_CENTROID_HZ = 5000;
export const HAT_HIGH_HZ = 6000;
export const HAT_HIGH_RATIO = 0.45;
export const VEL_WINDOW_SEC = 0.01;
export const DRUM_VEL_FLOOR_DBFS = -46;
export const DRUM_VEL_CEIL_DBFS = -6;

/** sample history (power of two; holds the classification span plus a block) */
const RING_SAMPLES = 16384;
const BINS = ONSET_FFT_SIZE / 2 + 1;
/** magnitude scale: a full-scale sine on a bin centre → |X|·MAG_SCALE ≈ 1 (Hann sum / 2) */
const MAG_SCALE = 4 / ONSET_FFT_SIZE;
const FLUX_RING = 64;
/** per-frame band sums kept for the noise floor (power of two, > NOISE_LOOKBACK_SEC at 96 kHz / hop + span) */
const BAND_RING = 512;

// ---------- features ----------
/** power sums over bins 1..N/2 of one or more FFT frames (unscaled |X|²) */
export interface BandSums {
  total: number;
  low: number;
  high: number;
  /** Σ hz·power, for the centroid */
  weighted: number;
}

export interface HitFeatures {
  lowRatio: number;
  highRatio: number;
  centroidHz: number;
}

export interface HitMeasure extends HitFeatures {
  /** RMS over HIT_GATE_SEC from the onset */
  gateRms: number;
  /** largest per-band power ratio, attack frames / pre-onset frames */
  attackRise: number;
  /** highest VEL_WINDOW_SEC RMS within the classification span */
  peakRms: number;
}

/** kick / hat / snare from spectral features (the rule in the header) */
export function classifyHit(f: HitFeatures): DrumKind {
  if (f.lowRatio > KICK_LOW_RATIO || f.centroidHz < KICK_MAX_CENTROID_HZ) return 'kick';
  if (f.centroidHz > HAT_MIN_CENTROID_HZ || f.highRatio > HAT_HIGH_RATIO) return 'hat';
  return 'snare';
}

export function drumVelocityFromRms(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  return Math.min(1, Math.max(0, (db - DRUM_VEL_FLOOR_DBFS) / (DRUM_VEL_CEIL_DBFS - DRUM_VEL_FLOOR_DBFS)));
}

export function emptyBands(): BandSums {
  return { total: 0, low: 0, high: 0, weighted: 0 };
}

/**
 * Features of the hit band sums after removing `frames` × the noise floor per frame.
 * Falls back to the raw sums when the hit is not clearly above the floor.
 */
export function featuresOf(hit: BandSums, frames: number, noisePerFrame: BandSums | null): HitFeatures {
  let { total, low, high, weighted } = hit;
  if (noisePerFrame) {
    const t = total - frames * noisePerFrame.total;
    if (t > 0.05 * total) {
      total = t;
      low = Math.max(0, low - frames * noisePerFrame.low);
      high = Math.max(0, high - frames * noisePerFrame.high);
      weighted = Math.max(0, weighted - frames * noisePerFrame.weighted);
    }
  }
  if (!(total > 0)) return { lowRatio: 0, highRatio: 0, centroidHz: 0 };
  return { lowRatio: Math.min(1, low / total), highRatio: Math.min(1, high / total), centroidHz: weighted / total };
}

/** One Hann-windowed FFT frame → band sums; shared by the detector and dev tools. */
export interface FrameAnalyser {
  /** frame of ONSET_FFT_SIZE samples starting at samples[offset] (missing samples = 0); adds its band sums to `into` */
  addFrameBands(samples: ArrayLike<number>, offset: number, sampleRate: number, into: BandSums): void;
  /** band sums of the frame most recently analysed, per bin power in `power` */
  readonly power: Float64Array;
}

export function createFrameAnalyser(): FrameAnalyser {
  const fft = new FFT(ONSET_FFT_SIZE);
  const spectrum = fft.createComplexArray();
  const frame = new Float64Array(ONSET_FFT_SIZE);
  const hann = hannWindow(ONSET_FFT_SIZE);
  const power = new Float64Array(BINS);
  return {
    power,
    addFrameBands(samples, offset, sampleRate, into) {
      const n = samples.length;
      for (let i = 0; i < ONSET_FFT_SIZE; i++) {
        const j = offset + i;
        frame[i] = j >= 0 && j < n ? samples[j] * hann[i] : 0;
      }
      fft.realTransform(spectrum, frame);
      const binHz = sampleRate / ONSET_FFT_SIZE;
      for (let k = 0; k < BINS; k++) {
        const p = spectrum[2 * k] * spectrum[2 * k] + spectrum[2 * k + 1] * spectrum[2 * k + 1];
        power[k] = p;
        if (k === 0) continue;
        const hz = k * binHz;
        into.total += p;
        into.weighted += p * hz;
        if (hz < KICK_LOW_HZ) into.low += p;
        if (hz > HAT_HIGH_HZ) into.high += p;
      }
    },
  };
}

/** samples needed before the onset to measure a hit (the earliest pre-onset frame starts half an FFT earlier) */
export function hitPreSamples(sampleRate: number): number {
  return Math.round(PRE_FROM_SEC * sampleRate) + ONSET_FFT_SIZE / 2;
}

const ATTACK_MIN_RISE_POWER = 10 ** (ATTACK_MIN_RISE_DB / 10);

/** true when the hit passes the level gate and the sharp-attack test */
export function isHit(m: HitMeasure): boolean {
  return m.gateRms >= HIT_GATE_RMS && m.attackRise >= ATTACK_MIN_RISE_POWER;
}

/** mean band sums of the FFT frames centred every hop in [fromIndex, toIndex] (at least one frame) */
function meanBands(fa: FrameAnalyser, samples: ArrayLike<number>, fromIndex: number, toIndex: number, sampleRate: number, into: BandSums): void {
  into.total = into.low = into.high = into.weighted = 0;
  let n = 0;
  for (let centre = fromIndex; centre <= toIndex || n === 0; centre += ONSET_HOP_SAMPLES) {
    fa.addFrameBands(samples, centre - ONSET_FFT_SIZE / 2, sampleRate, into);
    n++;
  }
  into.total /= n;
  into.low /= n;
  into.high /= n;
  into.weighted /= n;
}

/** largest per-band ratio (low, mid, high) of `after` over `before` */
function bandRise(after: BandSums, before: BandSums): number {
  const tiny = 1e-12 + 1e-9 * before.total;
  const mid = (b: BandSums) => Math.max(0, b.total - b.low - b.high);
  return Math.max((after.low + tiny) / (before.low + tiny), (mid(after) + tiny) / (mid(before) + tiny), (after.high + tiny) / (before.high + tiny));
}

const attackScratch = emptyBands();
const preScratch = emptyBands();

/** samples needed after the onset before a hit can be measured */
export function hitSpanSamples(sampleRate: number): number {
  return Math.max(
    Math.round(CLASSIFY_TO_SEC * sampleRate),
    Math.round(CLASSIFY_FROM_SEC * sampleRate) + ONSET_FFT_SIZE,
    Math.round(ATTACK_SEC * sampleRate) + ONSET_FFT_SIZE / 2,
  );
}

const frameScratch = emptyBands();

/** Gate, features and peak level of the hit at samples[onsetIndex] (needs hitPreSamples before, hitSpanSamples after). */
export function measureHit(
  fa: FrameAnalyser,
  samples: ArrayLike<number>,
  onsetIndex: number,
  sampleRate: number,
  noisePerFrame: BandSums | null,
  scratch: BandSums = emptyBands(),
): HitMeasure {
  const from = onsetIndex + Math.round(CLASSIFY_FROM_SEC * sampleRate);
  const to = onsetIndex + Math.round(CLASSIFY_TO_SEC * sampleRate);
  scratch.total = scratch.low = scratch.high = scratch.weighted = 0;
  let frames = 0;
  const one = frameScratch;
  for (let off = from; off + ONSET_FFT_SIZE <= to || off === from; off += ONSET_HOP_SAMPLES) {
    one.total = one.low = one.high = one.weighted = 0;
    fa.addFrameBands(samples, off, sampleRate, one);
    if (frames > 0 && noisePerFrame && one.total < ACTIVE_FRAME_NOISE_RATIO * noisePerFrame.total) continue;
    scratch.total += one.total;
    scratch.low += one.low;
    scratch.high += one.high;
    scratch.weighted += one.weighted;
    frames++;
  }
  const velLen = Math.round(VEL_WINDOW_SEC * sampleRate);
  const velStep = Math.max(1, velLen >> 2);
  let peakRms = 0;
  for (let off = onsetIndex; off + velLen <= to; off += velStep) peakRms = Math.max(peakRms, rmsOf(samples, off, velLen));
  meanBands(fa, samples, onsetIndex, onsetIndex + Math.round(ATTACK_SEC * sampleRate), sampleRate, attackScratch);
  meanBands(fa, samples, onsetIndex - Math.round(PRE_FROM_SEC * sampleRate), onsetIndex - Math.round(PRE_TO_SEC * sampleRate), sampleRate, preScratch);
  return {
    ...featuresOf(scratch, frames, noisePerFrame),
    gateRms: rmsOf(samples, onsetIndex, Math.round(HIT_GATE_SEC * sampleRate)),
    attackRise: bandRise(attackScratch, preScratch),
    peakRms,
  };
}

/** Noise floor per frame from a whole signal: the quietest NOISE_AVG_FRAMES-frame stretch before `beforeIndex`. */
export function estimateNoiseBands(fa: FrameAnalyser, samples: ArrayLike<number>, beforeIndex: number, sampleRate: number): BandSums | null {
  const first = Math.max(0, beforeIndex - Math.round(NOISE_LOOKBACK_SEC * sampleRate));
  const frames: BandSums[] = [];
  for (let off = first; off + ONSET_FFT_SIZE <= beforeIndex; off += ONSET_HOP_SAMPLES) {
    const b = emptyBands();
    fa.addFrameBands(samples, off, sampleRate, b);
    frames.push(b);
  }
  return quietestStretch(frames.length, (i) => frames[i]);
}

/** per-frame average band sums of the NOISE_AVG_FRAMES consecutive frames (0..count-1) with the least total power */
function quietestStretch(count: number, frameAt: (i: number) => BandSums): BandSums | null {
  if (count < NOISE_AVG_FRAMES) return null;
  let best = -1;
  let bestTotal = Infinity;
  for (let i = 0; i + NOISE_AVG_FRAMES <= count; i++) {
    let total = 0;
    for (let j = 0; j < NOISE_AVG_FRAMES; j++) total += frameAt(i + j).total;
    if (total < bestTotal) {
      bestTotal = total;
      best = i;
    }
  }
  const avg = emptyBands();
  const w = NOISE_FLOOR_BIAS / NOISE_AVG_FRAMES;
  for (let j = 0; j < NOISE_AVG_FRAMES; j++) {
    const b = frameAt(best + j);
    avg.total += b.total * w;
    avg.low += b.low * w;
    avg.high += b.high * w;
    avg.weighted += b.weighted * w;
  }
  return avg;
}

function hannWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function rmsOf(x: ArrayLike<number>, from: number, len: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < from + len && i < x.length; i++) {
    s += x[i] * x[i];
    n++;
  }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

// ---------- detector ----------
interface PendingHit {
  /** offset (samples since restart) of the onset */
  onsetOffset: number;
  /** flux-frame index of the onset peak (the noise floor is taken from frames before it) */
  frameIndex: number;
  t: Sec;
}

export function createOnsetDetector(): OnsetDetector {
  const fa = createFrameAnalyser();
  const ring = new Float32Array(RING_SAMPLES);
  const frameBuf = new Float64Array(ONSET_FFT_SIZE);
  const logMag = new Float64Array(BINS);
  const prevLogMag = new Float64Array(BINS);
  const fluxRing = new Float64Array(FLUX_RING);
  const fluxCentre = new Float64Array(FLUX_RING); // centre offset (samples since restart) of each flux frame
  const bandRing: BandSums[] = Array.from({ length: BAND_RING }, emptyBands);
  const hitBands = emptyBands();
  let span = new Float32Array(0);
  let pre = 0;
  const history = new Float64Array(FLUX_HISTORY_FRAMES);

  let sampleRate = 0;
  let started = false;
  let streamStartFrame = 0;
  let written = 0;
  let nextFrameOffset = 0;
  let frameCount = 0;
  let lastOnsetOffset = -Infinity;
  let pending: PendingHit[] = [];

  function restart(frameIndex: number, rate: number): void {
    if (rate !== sampleRate || span.length === 0) {
      pre = hitPreSamples(rate);
      span = new Float32Array(pre + hitSpanSamples(rate));
    }
    sampleRate = rate;
    started = true;
    streamStartFrame = frameIndex;
    written = 0;
    nextFrameOffset = 0;
    frameCount = 0;
    lastOnsetOffset = -Infinity;
    pending = [];
    prevLogMag.fill(0);
  }

  const at = (offset: number) => ring[offset & (RING_SAMPLES - 1)];

  /** flux of the frame starting at `offset`; also stores its band sums for the noise floor */
  function computeFlux(offset: number): number {
    for (let i = 0; i < ONSET_FFT_SIZE; i++) frameBuf[i] = at(offset + i);
    const bands = bandRing[frameCount & (BAND_RING - 1)];
    bands.total = bands.low = bands.high = bands.weighted = 0;
    fa.addFrameBands(frameBuf, 0, sampleRate, bands);
    let flux = 0;
    for (let k = 0; k < BINS; k++) {
      logMag[k] = Math.log1p(FLUX_LOG_GAIN * MAG_SCALE * Math.sqrt(fa.power[k]));
      const d = logMag[k] - prevLogMag[k];
      if (d > 0) flux += d;
      prevLogMag[k] = logMag[k];
    }
    // the first frame after a restart has no predecessor
    return frameCount === 0 ? 0 : flux;
  }

  /** peak test for the frame PEAK_HALF_WIDTH_FRAMES back from the newest one */
  function checkPeak(): void {
    const p = frameCount - 1 - PEAK_HALF_WIDTH_FRAMES;
    if (p < FLUX_MIN_HISTORY_FRAMES) return;
    const fp = fluxRing[p & (FLUX_RING - 1)];
    for (let j = p - PEAK_HALF_WIDTH_FRAMES; j <= p + PEAK_HALF_WIDTH_FRAMES; j++) {
      if (j < 0 || j === p) continue;
      const fj = fluxRing[j & (FLUX_RING - 1)];
      if (j < p ? fj >= fp : fj > fp) return;
    }
    if (fp <= fluxThreshold(p)) return;
    const onsetOffset = Math.round(fluxCentre[p & (FLUX_RING - 1)] + ONSET_TIME_OFFSET_SEC * sampleRate);
    if (onsetOffset - lastOnsetOffset < MIN_ONSET_GAP_SEC * sampleRate) return;
    lastOnsetOffset = onsetOffset;
    pending.push({ onsetOffset, frameIndex: p, t: (streamStartFrame + onsetOffset) / sampleRate });
  }

  /** median + FLUX_SPREAD_FACTOR · 1.4826 · MAD + FLUX_OFFSET of the FLUX_HISTORY_FRAMES frames before frame p */
  function fluxThreshold(p: number): number {
    const from = Math.max(0, p - FLUX_HISTORY_FRAMES);
    const n = p - from;
    const h = history.subarray(0, n);
    for (let j = 0; j < n; j++) h[j] = fluxRing[(from + j) & (FLUX_RING - 1)];
    h.sort();
    const median = h[n >> 1];
    for (let j = 0; j < n; j++) h[j] = Math.abs(h[j] - median);
    h.sort();
    return median + FLUX_SPREAD_FACTOR * MAD_TO_SIGMA * h[n >> 1] + FLUX_OFFSET;
  }

  /** room-noise floor from the stored frames that end before the onset frame */
  function noiseBefore(frameIndex: number): BandSums | null {
    const lookback = Math.min(BAND_RING - 64, Math.round((NOISE_LOOKBACK_SEC * sampleRate) / ONSET_HOP_SAMPLES));
    const last = frameIndex - 2; // frames overlapping the attack are excluded
    const first = Math.max(0, last - lookback, frameCount - BAND_RING);
    if (last < first) return null;
    return quietestStretch(last - first + 1, (i) => bandRing[(first + i) & (BAND_RING - 1)]);
  }

  /** gate + features + velocity for a pending hit whose span is in the ring; null = rejected by the gate */
  function finishHit(h: PendingHit): RawHit | null {
    const first = h.onsetOffset - pre;
    for (let i = 0; i < span.length; i++) span[i] = first + i >= 0 ? at(first + i) : 0;
    const m = measureHit(fa, span, pre, sampleRate, noiseBefore(h.frameIndex), hitBands);
    if (!isHit(m)) return null;
    return { t: h.t, kind: classifyHit(m), vel: drumVelocityFromRms(m.peakRms) };
  }

  function drainPending(out: RawHit[]): void {
    while (pending.length > 0 && written >= pending[0].onsetOffset + span.length - pre) {
      const hit = finishHit(pending.shift() as PendingHit);
      if (hit) out.push(hit);
    }
  }

  function write(samples: Float32Array, out: RawHit[]): void {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      ring[written & (RING_SAMPLES - 1)] = samples[i];
      written++;
      if (written - nextFrameOffset >= ONSET_FFT_SIZE) {
        const flux = computeFlux(nextFrameOffset);
        fluxRing[frameCount & (FLUX_RING - 1)] = flux;
        fluxCentre[frameCount & (FLUX_RING - 1)] = nextFrameOffset + ONSET_FFT_SIZE / 2;
        frameCount++;
        nextFrameOffset += ONSET_HOP_SAMPLES;
        checkPeak();
      }
      if (pending.length > 0 && (written & 63) === 0) drainPending(out);
    }
    drainPending(out);
  }

  return {
    push(block: MicBlock, rate: number): RawHit[] {
      if (!started || rate !== sampleRate || block.frame !== streamStartFrame + written) restart(block.frame, rate);
      const out: RawHit[] = [];
      write(block.samples, out);
      return out;
    },
    reset(): void {
      started = false;
    },
  };
}
