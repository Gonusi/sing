// [dsp] pitchy (McLeod) on a 2048 window with a 480-sample hop (10 ms at 48 kHz). Pure: no DOM, no Node globals.
import type { PitchTracker } from '../types.ts';

export function createPitchTracker(): PitchTracker {
  // STUB (dsp replaces)
  return { push: () => [], reset: () => {} };
}
