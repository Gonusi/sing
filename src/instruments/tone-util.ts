// [instruments] Helpers for the Tone-based voices (synth, drums). Tone is touched only inside these functions,
// never at module scope: the engine calls Tone.setContext(nativeCtx) before any voice exists.
import { getContext, setContext, type Envelope } from 'tone';
import type { Sec } from '../types.ts';
import type { Ctx } from './shared.ts';

/** release used to silence an envelope on stopAll (the voice gate fades in parallel) */
const SILENCE_RELEASE: Sec = 0.015;

/**
 * Tone nodes are created on Tone's global context; they must live on `ctx` to connect to the voice output.
 * The engine sets this up; if it did not, set it here (with a warning) rather than fail on connect.
 */
export function ensureToneContext(ctx: Ctx): void {
  if ((getContext().rawContext as unknown) === ctx) return;
  console.warn('[instruments] Tone was on another context; calling Tone.setContext(ctx)');
  setContext(ctx as AudioContext | OfflineAudioContext);
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
