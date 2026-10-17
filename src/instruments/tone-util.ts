// [instruments] Helpers for the Tone-based voices (synth, drums). Rules (engine contract):
// - Tone is touched only inside functions called after the engine's Tone.setContext(nativeCtx), never at module scope.
// - No Tone globals (Transport, Destination, Draw, context, getDestination/toDestination): every Tone node is built
//   with an explicit `context` (toneContext) and connects to the voice's own native nodes.
// - Instruments never call Tone.setContext themselves (the engine owns Tone's global context).
import { getContext, type BaseContext, type Envelope } from 'tone';
import type { Sec } from '../types.ts';
import type { Ctx } from './shared.ts';

/** release used to silence an envelope on stopAll (the voice gate fades in parallel) */
const SILENCE_RELEASE: Sec = 0.015;

/**
 * The Tone context wrapping `ctx`, to pass as `context` to every Tone constructor. Throws when the engine has not
 * pointed Tone at `ctx` (Tone nodes on another context could not connect to the voice output).
 */
export function toneContext(ctx: Ctx): BaseContext {
  const tone = getContext();
  if ((tone.rawContext as unknown) !== ctx) {
    throw new Error('[instruments] Tone.setContext(ctx) must run before createVoice("synth" | "drums")');
  }
  return tone;
}

/**
 * Bring a Tone envelope to 0 from `t` and drop anything it had scheduled after `t` (a note handed over
 * ahead of time). Uses Tone's own release (its cancel-and-hold keeps the curve continuous); a silent envelope
 * only needs its future events cancelled.
 */
export function silenceEnvelope(env: Envelope, t: Sec): void {
  if (env.getValueAtTime(t) > 0) {
    const release = env.release;
    env.release = SILENCE_RELEASE;
    env.triggerRelease(t);
    env.release = release;
  } else {
    env.cancel(t);
  }
}
