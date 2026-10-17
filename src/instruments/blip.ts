// [instruments] Short confirmation sounds: 'ok' (command understood), 'err' (not understood / not allowed),
// 'click' (calibration / count). Plain Web Audio, no Tone, so it works before instruments preload.
import type { Sec } from '../types.ts';

export type BlipKind = 'ok' | 'err' | 'click';

export function playBlip(_ctx: AudioContext, _kind: BlipKind, _when?: Sec, _destination?: AudioNode): void {
  // STUB (instruments replaces)
}
