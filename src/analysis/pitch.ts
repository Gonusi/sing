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
import { PitchDetector } from 'pitchy';
import type { MicBlock, PitchFrame, PitchTracker } from '../types.ts';

// ---------- constants ----------
export const PITCH_WINDOW_SAMPLES = 2048;
export const PITCH_HOP_SEC = 0.01;
/** whole-window RMS below this → unvoiced (≈ -42 dBFS; room noise in the fixtures sits at -45 dBFS) */
export const PITCH_MIN_RMS = 0.008;
/** pitchy clarity below this → unvoiced (pitchy's own clarityThreshold only steers peak picking) */
export const PITCH_MIN_CLARITY = 0.85;
export const PITCH_MIN_HZ = 70;
export const PITCH_MAX_HZ = 1100;
/** span around the window centre that PitchFrame.rms measures */
export const FRAME_RMS_SEC = 0.02;
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
      out.push(analyseWindow(win, streamStartFrame + nextWindowOffset, sampleRate, rmsHalfSpan, detector));
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
): PitchFrame {
  const centre = win.length >> 1;
  const t = (startFrame + centre) / sampleRate;
  const rms = rmsOfRange(win, centre - rmsHalfSpan, centre + rmsHalfSpan);
  const [hz, clarity] = detector.findPitch(win, sampleRate);
  const voiced = Number.isFinite(hz) && clarity >= PITCH_MIN_CLARITY && hz >= PITCH_MIN_HZ && hz <= PITCH_MAX_HZ;
  return { t, hz: voiced ? hz : null, clarity: Number.isFinite(clarity) ? clarity : 0, rms };
}

export function rmsOfRange(x: Float32Array, from: number, to: number): number {
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}
