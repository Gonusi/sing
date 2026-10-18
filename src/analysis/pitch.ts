// [dsp] Mic blocks → PitchFrame stream: pitchy (McLeod pitch method) on a 2048-sample window, hop 10 ms
// (480 samples at 48 kHz, 441 at 44.1 kHz). Pure: no DOM, no Node globals, no Web Audio.
//
// Each frame:
//   t       = context time of the window centre (block.frame clock, i.e. mic-stamp time)
//   hz      = null unless whole-window RMS >= PITCH_MIN_RMS, clarity >= PITCH_MIN_CLARITY and PITCH_MIN_HZ <= hz <= PITCH_MAX_HZ
//   clarity = pitchy's clarity (0 when the volume gate rejected the window)
//   rms     = RMS of the central FRAME_RMS_SEC of the window (finer in time than the 43 ms window;
//             the segmenter uses it for energy onsets and repeated-note dips)
// A block whose `frame` does not continue the previous block restarts the window grid at that block.
// Lag-limited fallback: pitchy searches every lag of the window, and during a fast glide the NSDF at a very long lag
// (few overlapping samples) can beat the real period, giving e.g. 26 Hz at clarity 0.96. When pitchy's answer is out
// of range, the McLeod peak picking is redone over lags PITCH_MIN_HZ..PITCH_MAX_HZ only (pitchy's Autocorrelator).
import { Autocorrelator, PitchDetector } from 'pitchy';
import type { MicBlock, PitchFrame, PitchTracker } from '../types.ts';

// ---------- constants ----------
export const PITCH_WINDOW_SAMPLES = 2048;
export const PITCH_HOP_SEC = 0.01;
/** whole-window RMS below this → unvoiced (≈ -54 dBFS). Was 0.008 (-42 dBFS): the owner's iPhone take played 22 dB
 *  quieter (-47 dBFS mean) kept 4 of 27 notes; at 0.002 all are kept down to -51 dBFS. Clarity >= 0.85 rejects room noise. */
export const PITCH_MIN_RMS = 0.002;
/** pitchy clarity below this → unvoiced (pitchy's own clarityThreshold only steers peak picking) */
export const PITCH_MIN_CLARITY = 0.85;
export const PITCH_MIN_HZ = 70;
export const PITCH_MAX_HZ = 1100;
/** span around the window centre that PitchFrame.rms measures */
export const FRAME_RMS_SEC = 0.02;
/** McLeod "k": first NSDF key maximum >= k · the highest one (pitchy's default clarityThreshold) */
export const MPM_PEAK_RATIO = 0.9;
/** ring capacity in samples (power of two, > window + largest chunk written at once) */
const RING_SAMPLES = 8192;
const MAX_CHUNK_SAMPLES = RING_SAMPLES - PITCH_WINDOW_SAMPLES;

/** hop in samples for a sample rate (480 at 48 kHz, 441 at 44.1 kHz) */
export function pitchHopSamples(sampleRate: number): number {
  return Math.round(PITCH_HOP_SEC * sampleRate);
}

export function createPitchTracker(): PitchTracker {
  const detector = PitchDetector.forFloat32Array(PITCH_WINDOW_SAMPLES);
  detector.minVolumeAbsolute = PITCH_MIN_RMS;
  const fallback = createLagLimitedMpm(PITCH_WINDOW_SAMPLES);
  const ring = new Float32Array(RING_SAMPLES);
  const win = new Float32Array(PITCH_WINDOW_SAMPLES);

  let sampleRate = 0;
  let hop = 0;
  let rmsHalfSpan = 0;
  /** context frame of the first sample since the last restart */
  let streamStartFrame = 0;
  /** samples written since the last restart (ring index base, independent of the absolute frame number) */
  let written = 0;
  /** offset (since restart) of the next window start */
  let nextWindowOffset = 0;
  let started = false;

  function restart(frame: number, rate: number): void {
    sampleRate = rate;
    hop = pitchHopSamples(rate);
    rmsHalfSpan = Math.round((FRAME_RMS_SEC * rate) / 2);
    streamStartFrame = frame;
    written = 0;
    nextWindowOffset = 0;
    started = true;
  }

  function writeChunk(samples: Float32Array, from: number, to: number, out: PitchFrame[]): void {
    for (let i = from; i < to; i++) ring[(written + i - from) & (RING_SAMPLES - 1)] = samples[i];
    written += to - from;
    while (written - nextWindowOffset >= PITCH_WINDOW_SAMPLES) {
      for (let i = 0; i < PITCH_WINDOW_SAMPLES; i++) win[i] = ring[(nextWindowOffset + i) & (RING_SAMPLES - 1)];
      out.push(analyseWindow(win, streamStartFrame + nextWindowOffset, sampleRate, rmsHalfSpan, detector, fallback));
      nextWindowOffset += hop;
    }
  }

  return {
    push(block: MicBlock, rate: number): PitchFrame[] {
      if (!started || rate !== sampleRate || block.frame !== streamStartFrame + written) restart(block.frame, rate);
      const out: PitchFrame[] = [];
      const n = block.samples.length;
      for (let from = 0; from < n; from += MAX_CHUNK_SAMPLES) writeChunk(block.samples, from, Math.min(n, from + MAX_CHUNK_SAMPLES), out);
      return out;
    },
    reset(): void {
      started = false;
    },
  };
}

/** Run the detector on one window that starts at context frame `startFrame`. */
export function analyseWindow(
  win: Float32Array,
  startFrame: number,
  sampleRate: number,
  rmsHalfSpan: number,
  detector: PitchDetector<Float32Array>,
  fallback: LagLimitedMpm,
): PitchFrame {
  const centre = win.length >> 1;
  const t = (startFrame + centre) / sampleRate;
  const rms = rmsOfRange(win, centre - rmsHalfSpan, centre + rmsHalfSpan);
  let [hz, clarity] = detector.findPitch(win, sampleRate);
  if (clarity > 0 && !(hz >= PITCH_MIN_HZ && hz <= PITCH_MAX_HZ)) [hz, clarity] = fallback.findPitch(win, sampleRate);
  const voiced = Number.isFinite(hz) && clarity >= PITCH_MIN_CLARITY && hz >= PITCH_MIN_HZ && hz <= PITCH_MAX_HZ;
  return { t, hz: voiced ? hz : null, clarity: Number.isFinite(clarity) ? clarity : 0, rms };
}

export interface LagLimitedMpm {
  /** McLeod pitch over lags for PITCH_MIN_HZ..PITCH_MAX_HZ only; [0, 0] when none */
  findPitch(input: Float32Array, sampleRate: number): [number, number];
}

/** McLeod peak picking restricted to the singing range, on pitchy's FFT autocorrelation. */
export function createLagLimitedMpm(inputLength: number): LagLimitedMpm {
  const ac = Autocorrelator.forFloat32Array(inputLength);
  const nsdf = new Float32Array(inputLength);
  return {
    findPitch(input, sampleRate) {
      const n = input.length;
      const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
      const maxLag = Math.min(n - 2, Math.ceil(sampleRate / PITCH_MIN_HZ));
      ac.autocorrelate(input, nsdf);
      // NSDF n(τ) = 2 r(τ) / m(τ), m(τ) = Σ x_j² + x_{j+τ}² (incremental, as in the MPM paper)
      let m = 2 * nsdf[0];
      for (let i = 0; i <= maxLag + 1; i++) {
        nsdf[i] = m > 0 ? (2 * nsdf[i]) / m : 0;
        m -= input[i] * input[i] + input[n - 1 - i] * input[n - 1 - i];
      }
      // key maxima: the highest point between a positive and the next negative zero crossing
      let best = -1;
      let nMax = 0;
      let looking = false;
      let peak = -Infinity;
      let peakIdx = -1;
      const keys: number[] = keyScratch;
      keys.length = 0;
      for (let i = 1; i <= maxLag + 1; i++) {
        if (nsdf[i - 1] <= 0 && nsdf[i] > 0) {
          looking = true;
          peak = nsdf[i];
          peakIdx = i;
        } else if (nsdf[i - 1] > 0 && nsdf[i] <= 0) {
          looking = false;
          if (peakIdx >= minLag && peakIdx <= maxLag) keys.push(peakIdx);
          peakIdx = -1;
        } else if (looking && nsdf[i] > peak) {
          peak = nsdf[i];
          peakIdx = i;
        }
      }
      if (looking && peakIdx >= minLag && peakIdx < maxLag) keys.push(peakIdx);
      for (const k of keys) nMax = Math.max(nMax, nsdf[k]);
      for (const k of keys) {
        if (nsdf[k] >= MPM_PEAK_RATIO * nMax) {
          best = k;
          break;
        }
      }
      if (best < 1) return [0, 0];
      const [lag, clarity] = parabolicPeak(nsdf, best);
      return [sampleRate / lag, Math.min(1, clarity)];
    },
  };
}
const keyScratch: number[] = [];

/** vertex of the parabola through (i-1, i, i+1) */
export function parabolicPeak(y: ArrayLike<number>, i: number): [number, number] {
  const y0 = y[i - 1];
  const y1 = y[i];
  const y2 = y[i + 1];
  const a = y0 / 2 - y1 + y2 / 2;
  if (a === 0) return [i, y1];
  const shift = (y0 - y2) / (4 * a);
  return [i + shift, y1 - (y0 - y2) * shift / 4];
}

export function rmsOfRange(x: Float32Array, from: number, to: number): number {
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}
