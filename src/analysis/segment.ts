// [dsp] PitchFrame stream → RawNote stream (median filter, octave fold, min length, gap merge). Pure.
import type { NoteSegmenter } from '../types.ts';

export function createSegmenter(): NoteSegmenter {
  // STUB (dsp replaces)
  return { push: () => [], open: () => null, close: () => [], reset: () => {} };
}
