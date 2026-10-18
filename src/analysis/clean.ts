// [dsp] Note smoothing for a finished take: absorbs scoops/tails into neighbouring notes, merges wobble across a
// semitone boundary (hysteresis), and drops what is left too short. Pure. Input and output are in loop positions with
// fractional midi; snapping, register fit and phrases happen after this (engine).
import type { RawLoopNote, Sec } from '../types.ts';

/** default slider position */
export const DEFAULT_SMOOTHING = 0.5;

/** smoothing 0 = as detected, 1 = strongest; returns notes sorted by pos */
export function cleanNotes(raw: RawLoopNote[], _smoothing: number, _loopLength: Sec): RawLoopNote[] {
  // STUB (dsp replaces): as detected
  return [...raw].sort((a, b) => a.pos - b.pos);
}
