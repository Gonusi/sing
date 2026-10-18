// [dsp] The singer's voice from short wizard recordings: pitch offset against a reference note, a held note. Pure.
import type { PitchFrame } from '../types.ts';

/** how far the voiced frames sit from `targetMidi` (semitones, octave-folded), and their spread; ok when enough voiced */
export function pitchOffset(_frames: PitchFrame[], _targetMidi: number): { ok: boolean; offset: number; spread: number } {
  // STUB (dsp replaces)
  return { ok: false, offset: 0, spread: 0 };
}

/** the note held most steadily in the frames (integer midi), or null */
export function heldNote(_frames: PitchFrame[]): number | null {
  // STUB (dsp replaces)
  return null;
}
