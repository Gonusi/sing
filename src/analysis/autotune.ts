// [dsp] Hz/MIDI conversion, semitone snap, and the per-take register fit (octave shift). Pure.
import type { InstrumentKind } from '../types.ts';

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

/** octave shift in semitones (multiple of 12) that moves the take's median note into the instrument's range */
export function registerShift(_midis: number[], _kind: InstrumentKind): number {
  // STUB (dsp replaces)
  return 0;
}
