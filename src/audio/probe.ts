// [engine] Settings "audio probe": a quiet tone plays while the mic is open, plus a live mic level,
// so the owner can hear on the iPhone whether output goes to the earpiece/crackles (WebKit 326286).
import type { AudioEngine } from './context.ts';
import type { Mic } from './mic.ts';

export interface Probe {
  /** mic RMS level 0..1 */
  level(): number;
  stop(): void;
}

export function startProbe(_engine: AudioEngine, _mic: Mic): Probe {
  // STUB (engine replaces)
  return { level: () => 0, stop: () => {} };
}
