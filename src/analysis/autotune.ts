// [dsp] Hz/MIDI conversion, semitone snap, and the per-take register fit (octave shift). Pure.
import type { InstrumentKind } from '../types.ts';

// ---------- constants ----------
/** inclusive MIDI range each instrument sounds best in; the take's median note is moved into it by octaves */
export const VIOLIN_SWEET_RANGE = { lo: 69, hi: 76 } as const; // A4–E5
export const BASS_SWEET_RANGE = { lo: 45, hi: 52 } as const; // A2–E3: low enough to be bass, high enough for phone speakers
/** null = no register fit (synth plays as sung, drums have no pitch) */
export const SWEET_RANGES: Record<InstrumentKind, { lo: number; hi: number } | null> = {
  violin: VIOLIN_SWEET_RANGE,
  bass: BASS_SWEET_RANGE,
  synth: null,
  drums: null,
};
const MAX_OCTAVE_SHIFT = 6;

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** nearest semitone */
export function snapMidi(midi: number): number {
  return Math.round(midi);
}

/** distance (semitones) from `midi` to the inclusive range; 0 inside */
export function distanceToRange(midi: number, range: { lo: number; hi: number }): number {
  return midi < range.lo ? range.lo - midi : midi > range.hi ? midi - range.hi : 0;
}

/**
 * Octave shift in semitones (multiple of 12) that moves the take's median note closest into the instrument's
 * sweet range (violin A4–E5, bass E2–A2; synth and drums: 0). Ties go to the smaller shift. Empty take → 0.
 */
export function registerShift(midis: number[], kind: InstrumentKind): number {
  const range = SWEET_RANGES[kind];
  if (!range || midis.length === 0) return 0;
  const sorted = midis.slice().sort((a, b) => a - b);
  const m = sorted.length >> 1;
  const median = sorted.length & 1 ? sorted[m] : 0.5 * (sorted[m - 1] + sorted[m]);
  let best = 0;
  let bestDist = distanceToRange(median, range);
  for (let k = 1; k <= MAX_OCTAVE_SHIFT; k++) {
    for (const shift of [-12 * k, 12 * k]) {
      const d = distanceToRange(median + shift, range);
      if (d < bestDist - 1e-9) {
        best = shift;
        bestDist = d;
      }
    }
  }
  return best;
}
