// [engine] Settings "audio probe": a quiet tone plays while the mic is open, plus a live mic level,
// so the owner can hear on the iPhone whether output goes to the earpiece/crackles (WebKit 326286).
// Tone: 440 Hz sine at PROBE_LEVEL_DBFS on the master bus. level(): smoothed mic RMS (linear, 0..1).
import type { AudioEngine } from './context.ts';
import type { Mic } from './mic.ts';

export interface Probe {
  /** mic RMS level 0..1 */
  level(): number;
  stop(): void;
}

const PROBE_HZ = 440;
const PROBE_LEVEL_DBFS = -24;
/** fade in/out of the probe tone */
const PROBE_RAMP_SEC = 0.02;
/** RMS smoothing per mic block (one-pole) */
const LEVEL_SMOOTHING = 0.3;

export function startProbe(engine: AudioEngine, mic: Mic): Probe {
  const { ctx } = engine;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(PROBE_HZ, now);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(10 ** (PROBE_LEVEL_DBFS / 20), now + PROBE_RAMP_SEC);
  osc.connect(gain).connect(engine.master);
  osc.start(now);

  let level = 0;
  const unsubscribe = mic.subscribe((b) => {
    level += (blockRms(b.samples) - level) * LEVEL_SMOOTHING;
  });
  let stopped = false;
  return {
    level: () => Math.min(1, level),
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + PROBE_RAMP_SEC);
      osc.stop(t + PROBE_RAMP_SEC + 0.01);
      osc.onended = () => gain.disconnect();
    },
  };
}

export function blockRms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}
