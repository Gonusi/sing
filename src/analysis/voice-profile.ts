// [dsp] The singer's voice from short wizard recordings: pitch offset against a reference note, a held note. Pure.
//
// pitchOffset: voiced frames from OFFSET_SETTLE_SEC after the first voiced frame (the singer finds the note first);
//   deviation = midi − target folded by octaves into −6..6 (humming an octave down is fine); offset = median,
//   spread = interquartile range; ok when at least OFFSET_MIN_VOICED_SEC of voiced frames were used.
// heldNote: voiced frames grouped into runs that stay within HELD_TOLERANCE_ST of the run's running median (a gap of up
//   to HELD_MAX_GAP_SEC unvoiced is bridged); the longest run of at least HELD_MIN_SEC wins (ties: smaller spread); the
//   result is that run's median rounded to an integer note. Null when nothing was held long enough.
import type { PitchFrame } from '../types.ts';
import { hzToMidi } from './autotune.ts';

// ---------- constants ----------
export const OFFSET_SETTLE_SEC = 0.3;
export const OFFSET_MIN_VOICED_SEC = 1.0;
export const HELD_TOLERANCE_ST = 0.6;
export const HELD_MAX_GAP_SEC = 0.05;
export const HELD_MIN_SEC = 0.3;
const DEFAULT_HOP_SEC = 0.01;

const median = (xs: number[]) => quantile(xs, 0.5);

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** typical frame spacing (median Δt), for converting frame counts to seconds */
function hopOf(frames: PitchFrame[]): number {
  const dts: number[] = [];
  for (let i = 1; i < frames.length && dts.length < 200; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt > 0) dts.push(dt);
  }
  return dts.length ? median(dts) : DEFAULT_HOP_SEC;
}

/** deviation folded by octaves into [−6, 6) */
export function foldOctaves(d: number): number {
  return d - 12 * Math.round(d / 12);
}

/** how far the voiced frames sit from `targetMidi` (semitones, octave-folded), and their spread; ok when enough voiced */
export function pitchOffset(frames: PitchFrame[], targetMidi: number): { ok: boolean; offset: number; spread: number } {
  const voiced = frames.filter((f) => f.hz !== null);
  if (voiced.length === 0) return { ok: false, offset: 0, spread: 0 };
  const from = voiced[0].t + OFFSET_SETTLE_SEC;
  const devs = voiced.filter((f) => f.t >= from).map((f) => foldOctaves(hzToMidi(f.hz as number) - targetMidi));
  if (devs.length === 0) return { ok: false, offset: 0, spread: 0 };
  const offset = median(devs);
  const spread = quantile(devs, 0.75) - quantile(devs, 0.25);
  return { ok: devs.length * hopOf(frames) >= OFFSET_MIN_VOICED_SEC - 1e-9, offset, spread };
}

/** the note held most steadily in the frames (integer midi), or null */
export function heldNote(frames: PitchFrame[]): number | null {
  const hop = hopOf(frames);
  let best: { len: number; spread: number; midi: number } | null = null;
  let run: number[] = [];
  let lastT = -Infinity;
  const finish = () => {
    if (run.length * hop >= HELD_MIN_SEC - 1e-9) {
      const m = median(run);
      const spread = quantile(run, 0.75) - quantile(run, 0.25);
      if (!best || run.length > best.len || (run.length === best.len && spread < best.spread)) best = { len: run.length, spread, midi: Math.round(m) };
    }
    run = [];
  };
  for (const f of frames) {
    if (f.hz === null) continue;
    const m = hzToMidi(f.hz);
    if (run.length > 0 && (f.t - lastT > HELD_MAX_GAP_SEC + hop || Math.abs(m - median(run)) > HELD_TOLERANCE_ST)) finish();
    run.push(m);
    lastT = f.t;
  }
  finish();
  return (best as { midi: number } | null)?.midi ?? null;
}
