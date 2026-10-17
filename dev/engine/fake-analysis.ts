// [engine] dev only: a trivial, sample-precise stand-in for src/analysis, so the engine check tests the ENGINE's
// timing math (not pitch detection). Works on clean synthetic input only: pure sines (notes) and short tone bursts
// (drum hits) injected with mic.inject at exact times.
//   tracker:   1 ms hop; voiced when the hop's peak > VOICED_PEAK; hz from interpolated rising zero crossings
//   segmenter: a note = a run of voiced frames; splits when the pitch moves > 0.7 semitone; ends after GAP_SEC
//   onsets:    first sample over HIT_PEAK after HIT_QUIET_SEC of quiet; classified HIT_CLASSIFY_SEC later by the
//              burst's zero-crossing frequency (< 300 Hz kick, > 4 kHz hat, else snare)
import type { DrumKind, MicBlock, NoteSegmenter, OnsetDetector, PitchFrame, PitchTracker, RawHit, RawNote, Sec } from '../../src/types.ts';
import type { Analysis } from '../../src/loop/take.ts';

const HOP_SEC = 0.001;
const VOICED_PEAK = 0.05;
const ZC_LOOKBACK = 1024;
const GAP_SEC = 0.015;
const SPLIT_SEMITONES = 0.7;
const HIT_PEAK = 0.05;
const HIT_QUIET_SEC = 0.05;
const HIT_CLASSIFY_SEC = 0.03;

export function fakeAnalysis(): Partial<Analysis> {
  return {
    createPitchTracker: fakeTracker,
    createSegmenter: fakeSegmenter,
    createOnsetDetector: fakeOnsets,
    registerShift: () => 0,
  };
}

const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);

function fakeTracker(): PitchTracker {
  let hist = new Float32Array(0);
  let histStart = 0; // frame of hist[0]
  let hopStart = -1; // frame of the current hop's first sample
  let hopPeak = 0;
  let hop = 48;
  return {
    push(block: MicBlock, sampleRate: number): PitchFrame[] {
      hop = Math.round(HOP_SEC * sampleRate);
      const out: PitchFrame[] = [];
      // history for zero crossings
      const merged = new Float32Array(Math.min(hist.length, ZC_LOOKBACK) + block.samples.length);
      const keep = hist.subarray(Math.max(0, hist.length - ZC_LOOKBACK));
      merged.set(keep, 0);
      merged.set(block.samples, keep.length);
      const mergedStart = block.frame - keep.length;
      for (let i = 0; i < block.samples.length; i++) {
        const f = block.frame + i;
        if (hopStart < 0) hopStart = f - (f % hop);
        hopPeak = Math.max(hopPeak, Math.abs(block.samples[i]));
        if (f + 1 - hopStart >= hop) {
          const voiced = hopPeak > VOICED_PEAK;
          const endIdx = f + 1 - mergedStart;
          const hz = voiced ? zeroCrossingHz(merged, Math.max(0, endIdx - ZC_LOOKBACK), endIdx, sampleRate) : null;
          out.push({ t: (hopStart + hop / 2) / sampleRate, hz, clarity: voiced ? 1 : 0, rms: hopPeak });
          hopStart = f + 1;
          hopPeak = 0;
        }
      }
      hist = merged;
      histStart = mergedStart;
      void histStart;
      return out;
    },
    reset() {
      hist = new Float32Array(0);
      hopStart = -1;
      hopPeak = 0;
    },
  };
}

/** mean period from linearly interpolated rising zero crossings in x[a, b) — only inside the trailing voiced run */
function zeroCrossingHz(x: Float32Array, a: number, b: number, sampleRate: number): number | null {
  // walk back from b while the signal is "alive" (no 3 ms of near-silence)
  const silentRun = Math.round(0.003 * sampleRate);
  let start = b;
  let quiet = 0;
  for (let i = b - 1; i >= a; i--) {
    quiet = Math.abs(x[i]) < 1e-4 ? quiet + 1 : 0;
    if (quiet >= silentRun) break;
    start = i;
  }
  const crossings: number[] = [];
  for (let i = Math.max(start, a) + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  if (crossings.length < 2) return null;
  const period = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
  return sampleRate / period;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

function fakeSegmenter(): NoteSegmenter {
  let open: { start: Sec; last: Sec; midis: number[]; peak: number } | null = null;
  let hopSec = HOP_SEC;
  const finalize = (end: Sec): RawNote[] => {
    const o = open;
    open = null;
    if (!o || o.midis.length === 0) return [];
    const dur = Math.max(0, end - o.start);
    return dur > 0.02 ? [{ t: o.start - hopSec / 2, dur, midi: median(o.midis), vel: Math.min(1, o.peak * 2) }] : [];
  };
  return {
    push(fr: PitchFrame): RawNote[] {
      const voiced = fr.rms > VOICED_PEAK;
      if (voiced) {
        const out: RawNote[] = [];
        if (open && fr.hz !== null && open.midis.length >= 5) {
          const m = hzToMidi(fr.hz);
          if (Math.abs(m - median(open.midis.slice(-5))) > SPLIT_SEMITONES) {
            out.push(...finalize(fr.t - hopSec / 2));
          }
        }
        open ??= { start: fr.t, last: fr.t, midis: [], peak: 0 };
        open.last = fr.t;
        open.peak = Math.max(open.peak, fr.rms);
        if (fr.hz !== null) open.midis.push(hzToMidi(fr.hz));
        return out;
      }
      if (open && fr.t - open.last > GAP_SEC) return finalize(open.last + hopSec / 2);
      return [];
    },
    open() {
      if (!open || open.midis.length === 0) return null;
      return { t: open.start - hopSec / 2, dur: open.last - open.start, midi: median(open.midis), vel: 0.8 };
    },
    close(at: Sec): RawNote[] {
      if (!open) return [];
      if (open.start >= at) {
        open = null;
        return [];
      }
      return finalize(Math.min(open.last + hopSec / 2, at));
    },
    reset() {
      open = null;
      hopSec = HOP_SEC;
    },
  };
}

function fakeOnsets(): OnsetDetector {
  let quietFrames = Infinity;
  let pending: { frame: number; crossings: number; samples: number; peak: number; prev: number } | null = null;
  return {
    push(block: MicBlock, sampleRate: number): RawHit[] {
      const out: RawHit[] = [];
      const classifyFrames = Math.round(HIT_CLASSIFY_SEC * sampleRate);
      for (let i = 0; i < block.samples.length; i++) {
        const x = block.samples[i];
        const f = block.frame + i;
        if (pending) {
          if (pending.prev < 0 && x >= 0) pending.crossings++;
          pending.prev = x;
          pending.samples++;
          pending.peak = Math.max(pending.peak, Math.abs(x));
          if (f - pending.frame >= classifyFrames) {
            const hz = (pending.crossings * sampleRate) / pending.samples;
            const kind: DrumKind = hz < 300 ? 'kick' : hz > 4000 ? 'hat' : 'snare';
            out.push({ t: pending.frame / sampleRate, kind, vel: Math.min(1, pending.peak * 2) });
            pending = null;
          }
        }
        if (Math.abs(x) > HIT_PEAK) {
          if (!pending && quietFrames >= HIT_QUIET_SEC * sampleRate) pending = { frame: f, crossings: 0, samples: 0, peak: 0, prev: x };
          quietFrames = 0;
        } else {
          quietFrames++;
        }
      }
      return out;
    },
    close(): RawHit[] {
      pending = null;
      return [];
    },
    reset() {
      quietFrames = Infinity;
      pending = null;
    },
  };
}
