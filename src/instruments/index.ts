// [instruments] Voice factory. Tone is only touched inside these functions (after Tone.setContext in audio/context.ts).
import type { InstrumentKind, Voice } from '../types.ts';

/** decode samples (violin) and warm up synths; call once after the AudioContext exists */
export async function preloadInstruments(_ctx: AudioContext, onProgress?: (fraction: number) => void): Promise<void> {
  // STUB (instruments replaces)
  onProgress?.(1);
}

/** one Voice per track; synchronous after preloadInstruments resolved */
export function createVoice(kind: InstrumentKind, ctx: AudioContext): Voice {
  // STUB (instruments replaces): silent voice.
  const output = ctx.createGain();
  return { kind, output, play: () => {}, stopAll: () => {}, dispose: () => output.disconnect() };
}
