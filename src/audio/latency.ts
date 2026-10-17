// [engine] Input-latency default and the clap-along calibration.
//
// Calibration: click i is meant to be HEARD at heard[i]; it is scheduled at heard[i] − outLat on the master bus.
// The user claps on each click; we find clap onsets (mic stamps) and set
//   inLat = median(onsetStamp − heard)       over clicks matched within [heard − 0.05, heard + 0.4]
// ok when ≥ MIN_MATCHED clicks matched and the IQR of the offsets < MAX_IQR_SEC.
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
  /** spread (IQR) of the measured offsets */
  spread: Sec;
  // ---- engine extensions ----
  matched: number;
  /** onsetStamp − heard per matched click */
  offsets: Sec[];
}

const DEFAULT_CLICKS = 8;
const CLICK_INTERVAL_SEC = 0.6;
/** first click is heard this long after calibrate() starts */
const LEAD_SEC = 0.5;
const MATCH_EARLY_SEC = 0.05;
const MATCH_LATE_SEC = 0.4;
const MIN_MATCHED = 5;
const MAX_IQR_SEC = 0.04;
/** resolve this long after the last match window closed, if the mic stops delivering blocks */
const FALLBACK_SLACK_SEC = 2;
const CLICK_HZ = 2000;
/** before the master gain (0.5): ≈ −7 dBFS at the output, clearly above a playing loop */
const CLICK_PEAK = 0.9;
const CLICK_DECAY_SEC = 0.03;

/** Plays `clicks` clicks (scheduled with the outLat correction); the user claps along; median offset → inLat. */
export async function calibrate(
  engine: AudioEngine,
  mic: Mic,
  /** onClick(i, n): click i of n is being heard now, i = 1..n */
  opts: { clicks?: number; onClick?: (i: number, n: number) => void } = {},
): Promise<CalibrationResult> {
  const { ctx } = engine;
  const n = opts.clicks ?? DEFAULT_CLICKS;
  const outLat = engine.outLat();
  const first = ctx.currentTime + LEAD_SEC + outLat;
  const heard = Array.from({ length: n }, (_, i) => first + i * CLICK_INTERVAL_SEC);
  heard.forEach((h, i) => {
    playClick(ctx, engine.master, h - outLat);
    // 1-based for the sheet's "i/n"
    if (opts.onClick) setTimeout(() => opts.onClick?.(i + 1, n), Math.max(0, (h - ctx.currentTime) * 1000));
  });

  const onsets: Sec[] = [];
  const detector = createOnsetDetector(mic.sampleRate);
  const doneAt = heard[n - 1] + MATCH_LATE_SEC + 0.05;
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
  return evaluate(matchOnsets(heard, onsets));
}

/** short decaying sine burst on `dest`, starting at context time `when` */
export function playClick(ctx: BaseAudioContext, dest: AudioNode, when: Sec): void {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(CLICK_HZ, when);
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

/** offsets (onset − heard) of the first onset inside each click's match window; each onset used once */
export function matchOnsets(heard: Sec[], onsets: Sec[]): Sec[] {
  const used = new Set<number>();
  const offsets: Sec[] = [];
  for (const h of heard) {
    const j = onsets.findIndex((o, k) => !used.has(k) && o >= h - MATCH_EARLY_SEC && o <= h + MATCH_LATE_SEC);
    if (j < 0) continue;
    used.add(j);
    offsets.push(onsets[j] - h);
  }
  return offsets;
}

export function evaluate(offsets: Sec[]): CalibrationResult {
  const sorted = [...offsets].sort((a, b) => a - b);
  const spread = sorted.length ? quantile(sorted, 0.75) - quantile(sorted, 0.25) : 0;
  return {
    ok: sorted.length >= MIN_MATCHED && spread < MAX_IQR_SEC,
    inLat: sorted.length ? quantile(sorted, 0.5) : 0.01,
    spread,
    matched: sorted.length,
    offsets,
  };
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- energy-rise onset detector (claps and clicks) ----------

/** samples per peak chunk for the noise floor */
const ONSET_CHUNK = 32;
/** absolute minimum trigger level */
const ONSET_ABS_MIN = 0.02;
/** trigger at this multiple of the noise floor */
const ONSET_RISE = 6;
/** one-pole smoothing of the noise floor per chunk */
const FLOOR_SMOOTHING = 0.02;
/** ignore new onsets for this long after one */
const ONSET_REFRACTORY_SEC = 0.15;

export function createOnsetDetector(sampleRate: number): { push(frame: number, x: Float32Array): Sec[] } {
  let floor = 0;
  let lastOnsetFrame = -Infinity;
  const refractory = ONSET_REFRACTORY_SEC * sampleRate;
  return {
    push(frame, x) {
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
        if (firstOver >= 0 && quiet) {
          lastOnsetFrame = frame + firstOver;
          found.push(lastOnsetFrame / sampleRate);
        } else if (quiet) {
          floor += (peak - floor) * FLOOR_SMOOTHING;
        }
      }
      return found;
    },
  };
}
