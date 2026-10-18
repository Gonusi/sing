// [dsp] The user's own drum sounds: a feature vector per hit and nearest-template classification. Pure.
import type { DrumKind, DrumTemplate } from '../types.ts';

/** feature vector of one hit from the samples starting at its onset (≥ ~80 ms) */
export function hitFeatures(_samples: Float32Array, _sampleRate: number): number[] {
  // STUB (dsp replaces)
  return [];
}

/** nearest template's kind, or null when there are no templates or the hit is far from all of them */
export function classifyByTemplates(_features: number[], _templates: DrumTemplate[]): DrumKind | null {
  // STUB (dsp replaces)
  return null;
}
