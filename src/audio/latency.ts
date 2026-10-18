// [engine] Input-latency default and the clap-along calibration (v2).
//
// Calibration: LISTEN_CLICKS higher clicks to tune in (not measured), then MEASURE_CLICKS lower clicks every
// CLICK_PERIOD_SEC (≈ 92 bpm). Click k is meant to be HEARD at heard[k]; it is scheduled at heard[k] − outLat.
// The user claps (or says "ta") on each click. Every onset gets a PHASE relative to the measured click grid,
//   phase = onset − heard[k],  k = the grid click it follows, phase ∈ [−EARLY_SEC, period − EARLY_SEC)
// (so round trips up to ≈ 0.6 s work: Bluetooth). The densest CLUSTER_SEC window of phases is the latency:
//   inLat = median(phases in the cluster), spread = their IQR, heard = how many clicks contributed;
//   ok when heard ≥ MIN_HEARD and IQR < MAX_IQR_SEC.
// A wrong outputLatency report cancels out: any error in outLat lands in inLat, and the overdub correction
// (tc = stamp − inLat, scheduling at heard − outLat) uses the same two numbers.
//
// Loopback test (mic.loopback(d): limiter output → DelayNode(d) → mic input, i.e. the speaker feed): the click is
// rendered into master at heard − outLat, leaves the limiter LIMITER_DELAY_SEC later and reaches the mic tap d after
// that, so stamp = heard − outLat + LIMITER_DELAY_SEC + d and
//   expected inLat = d − (baseLatency + outputLatency)  = d − outLat + LIMITER_DELAY_SEC   (outLat at calibrate() start).
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
  /** spread (IQR) of the phases in the cluster */
  spread: Sec;
  /** measured clicks that contributed to the cluster ("heard 9/12") */
  heard: number;
  /** measured clicks played (MEASURE_CLICKS) */
  measured: number;
  // ---- engine extensions ----
  /** = heard (kept for older callers) */
  matched: number;
  /** phase of every onset (one per measured click at most) */
  offsets: Sec[];
}

export type ClickPhase = 'listen' | 'measure';

export const LISTEN_CLICKS = 4;
export const MEASURE_CLICKS = 12;
/** ≈ 92 bpm */
export const CLICK_PERIOD_SEC = 0.65;
/** first click is heard this long after calibrate() starts */
const LEAD_SEC = 0.5;
/** a clap may come this much before its click */
const EARLY_SEC = 0.05;
/** width of the phase cluster */
const CLUSTER_SEC = 0.12;
const MIN_HEARD = 6;
const MAX_IQR_SEC = 0.06;
/** resolve this long after the last phase window closed, if the mic stops delivering blocks */
const FALLBACK_SLACK_SEC = 2;
const LISTEN_HZ = 2400;
const MEASURE_HZ = 1400;
/** before the master gain (0.5): ≈ −7 dBFS at the output, clearly above a playing loop */
const CLICK_PEAK = 0.9;
const CLICK_DECAY_SEC = 0.03;

/**
 * Plays LISTEN_CLICKS + MEASURE_CLICKS clicks; the user claps along. onClick(i, n, phase) fires when a click is
 * heard: i = 1..n within its phase (n = LISTEN_CLICKS or MEASURE_CLICKS).
 */
export async function calibrate(
  engine: AudioEngine,
  mic: Mic,
  opts: { onClick?: (i: number, n: number, phase: ClickPhase) => void } = {},
): Promise<CalibrationResult> {
  const { ctx } = engine;
  const outLat = engine.outLat();
  const first = ctx.currentTime + LEAD_SEC + outLat;
  const total = LISTEN_CLICKS + MEASURE_CLICKS;
  const heard = Array.from({ length: total }, (_, i) => first + i * CLICK_PERIOD_SEC);
  heard.forEach((h, i) => {
    const listen = i < LISTEN_CLICKS;
    playClick(ctx, engine.master, h - outLat, listen ? LISTEN_HZ : MEASURE_HZ);
    if (opts.onClick) {
      const phase: ClickPhase = listen ? 'listen' : 'measure';
      const k = listen ? i + 1 : i - LISTEN_CLICKS + 1;
      const n = listen ? LISTEN_CLICKS : MEASURE_CLICKS;
      setTimeout(() => opts.onClick?.(k, n, phase), Math.max(0, (h - ctx.currentTime) * 1000));
    }
  });
  const grid = heard.slice(LISTEN_CLICKS);

  const onsets: Sec[] = [];
  const detector = createOnsetDetector(mic.sampleRate);
  const doneAt = grid[grid.length - 1] + CLICK_PERIOD_SEC - EARLY_SEC + 0.05;
  await new Promise<void>((resolve) => {
    const unsubscribe = mic.subscribe((b) => {
      onsets.push(...detector.push(b.frame, b.samples));
      if ((b.frame + b.samples.length) / mic.sampleRate >= doneAt) finish();
    });
    const timer = setTimeout(() => finish(), (doneAt - ctx.currentTime + FALLBACK_SLACK_SEC) * 1000);
    function finish() {
      unsubscribe();
      clearTimeout(timer);
      resolve();
    }
  });
  return evaluate(phasesOf(grid, onsets, CLICK_PERIOD_SEC));
}

/** short decaying sine burst on `dest`, starting at context time `when` */
export function playClick(ctx: BaseAudioContext, dest: AudioNode, when: Sec, hz = MEASURE_HZ): void {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(hz, when);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(CLICK_PEAK, when + 0.0005);
  g.gain.exponentialRampToValueAtTime(0.001, when + CLICK_DECAY_SEC);
  g.gain.setValueAtTime(0, when + CLICK_DECAY_SEC + 0.001);
  osc.connect(g).connect(dest);
  osc.start(when);
  osc.stop(when + CLICK_DECAY_SEC + 0.01);
  osc.onended = () => g.disconnect();
}

/** per grid click, the phases of every onset in its window [heard − EARLY, heard + period − EARLY) */
export function phasesOf(grid: Sec[], onsets: Sec[], period: Sec): Sec[][] {
  return grid.map((h) => onsets.filter((x) => x >= h - EARLY_SEC && x < h + period - EARLY_SEC).map((x) => x - h));
}

/**
 * Pass 1: the densest CLUSTER_SEC window over all phases gives the centre. Pass 2: per click, the phase nearest
 * the centre inside the window (a cough before the clap can't replace it) → median, IQR, count.
 */
export function evaluate(perClick: Sec[][]): CalibrationResult {
  const all = perClick.flat().sort((a, b) => a - b);
  let lo = 0;
  let hi = -1;
  for (let i = 0, j = 0; i < all.length; i++) {
    while (all[i] - all[j] > CLUSTER_SEC) j++;
    if (i - j > hi - lo) [lo, hi] = [j, i];
  }
  const centre = hi >= lo ? (all[lo] + all[hi]) / 2 : 0;
  const picked: Sec[] = [];
  for (const phases of perClick) {
    const inside = phases.filter((p) => hi >= lo && p >= all[lo] && p <= all[hi]);
    if (inside.length) picked.push(inside.reduce((a, b) => (Math.abs(b - centre) < Math.abs(a - centre) ? b : a)));
  }
  const best = picked.sort((a, b) => a - b);
  const spread = best.length ? quantile(best, 0.75) - quantile(best, 0.25) : 0;
  return {
    ok: best.length >= MIN_HEARD && spread < MAX_IQR_SEC,
    inLat: best.length ? quantile(best, 0.5) : 0.01,
    spread,
    heard: best.length,
    measured: MEASURE_CLICKS,
    matched: best.length,
    offsets: perClick.map((p) => p[0] ?? NaN),
  };
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- energy-rise onset detector (claps, a spoken "ta", clicks; also through a suppressed headset mic) ----------

/** samples per peak chunk for the noise floor */
const ONSET_CHUNK = 32;
/** absolute minimum trigger level (low: HFP headset mics with noise suppression flatten claps) */
const ONSET_ABS_MIN = 0.004;
/** trigger at this multiple of the noise floor (adaptive) */
const ONSET_RISE = 5;
/** one-pole smoothing of the noise floor per chunk */
const FLOOR_SMOOTHING = 0.02;
/** ignore new onsets for this long after one */
const ONSET_REFRACTORY_SEC = 0.15;
/** learn the floor for this long before any onset counts (the listen clicks give the time) */
const ONSET_WARMUP_SEC = 0.3;

export function createOnsetDetector(sampleRate: number): { push(frame: number, x: Float32Array): Sec[] } {
  let floor = 0;
  let lastOnsetFrame = -Infinity;
  let startFrame: number | null = null;
  const refractory = ONSET_REFRACTORY_SEC * sampleRate;
  const warmup = ONSET_WARMUP_SEC * sampleRate;
  return {
    push(frame, x) {
      startFrame ??= frame;
      const found: Sec[] = [];
      for (let c = 0; c < x.length; c += ONSET_CHUNK) {
        const end = Math.min(x.length, c + ONSET_CHUNK);
        const thr = Math.max(ONSET_ABS_MIN, floor * ONSET_RISE);
        let peak = 0;
        let firstOver = -1;
        for (let i = c; i < end; i++) {
          const a = Math.abs(x[i]);
          if (a > peak) peak = a;
          if (firstOver < 0 && a > thr) firstOver = i;
        }
        const f = frame + c;
        const quiet = f - lastOnsetFrame >= refractory;
        const warm = f - startFrame >= warmup;
        if (warm && firstOver >= 0 && quiet) {
          lastOnsetFrame = frame + firstOver;
          found.push(lastOnsetFrame / sampleRate);
        } else if (quiet) {
          floor += (peak - floor) * (warm ? FLOOR_SMOOTHING : 0.2);
        }
      }
      return found;
    },
  };
}
