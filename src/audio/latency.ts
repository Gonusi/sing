// [engine] Input-latency default and the clap-along calibration.
import type { Sec } from '../types.ts';
import type { AudioEngine } from './context.ts';
import type { Mic } from './mic.ts';

export function defaultInLat(mic: Mic): Sec {
  return mic.reportedLatency() ?? 0.01;
}

export interface CalibrationResult {
  ok: boolean;
  /** corrected time = mic stamp − inLat */
  inLat: Sec;
  /** spread (IQR) of the measured offsets */
  spread: Sec;
}

/** Plays `clicks` clicks (scheduled with the outLat correction); the user claps along; median offset → inLat. */
export async function calibrate(
  _engine: AudioEngine,
  _mic: Mic,
  _opts: { clicks?: number; onClick?: (i: number, n: number) => void } = {},
): Promise<CalibrationResult> {
  // STUB (engine replaces)
  return { ok: false, inLat: 0.01, spread: 0 };
}
