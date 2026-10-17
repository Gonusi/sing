// [instruments] Public entry: preloadInstruments (violin samples + room impulse, cached per sample rate) and the
// createVoice factory. Tone is only touched inside functions, after the engine's Tone.setContext(ctx)
// (audio/context.ts); no Tone globals are used and Tone's context is never set here (tone-util.ts).
//
// Files: shared.ts (helpers, stopAll gate) · phrase.ts (legato phrase lifecycle, used by violin + bass)
//        violin.ts + violin-assets.ts · bass.ts · synth.ts + drums.ts (Tone, helpers in tone-util.ts) · blip.ts
import type { InstrumentKind, Voice } from '../types.ts';
import { createBassVoice } from './bass.ts';
import { createDrumVoice } from './drums.ts';
import { createSynthVoice } from './synth.ts';
import { createViolinVoice } from './violin.ts';
import { loadViolinAssets } from './violin-assets.ts';

/** decode the violin samples and build the room impulse for ctx.sampleRate; call once after the context exists */
export async function preloadInstruments(ctx: BaseAudioContext, onProgress?: (fraction: number) => void): Promise<void> {
  await loadViolinAssets(ctx, onProgress);
  onProgress?.(1);
}

/** one Voice per track; synchronous after preloadInstruments resolved. `output` is a fixed-level GainNode on ctx. */
export function createVoice(kind: InstrumentKind, ctx: BaseAudioContext): Voice {
  switch (kind) {
    case 'violin':
      return createViolinVoice(ctx);
    case 'bass':
      return createBassVoice(ctx);
    case 'synth':
      return createSynthVoice(ctx);
    case 'drums':
      return createDrumVoice(ctx);
    case 'vocals':
      // raw audio playback is the engine's (src/audio), it owns the recorded buffers
      throw new Error('createVoice: vocals voices are created by the engine');
  }
}
