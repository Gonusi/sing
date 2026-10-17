// [engine] The one native AudioContext, Tone.setContext, worklet module, master bus, iOS lifecycle.
//
// Rules this file enforces:
// - createAudioEngine() runs its synchronous part inside the user gesture: the context is created and
//   resume() is called before the first await (iOS unlock).
// - Tone wraps OUR native context (Tone.setContext). Never use Tone.getContext().rawContext as a native context.
// - Our worklet is loaded with ctx.audioWorklet.addModule directly (Tone's helper remembers only one URL).
// - Lifecycle: iOS suspends/interrupts the context in the background; we resume on visibility/statechange,
//   kick a frozen clock with suspend()+resume(), and emit 'interrupted' / 'resumed'.
// - Output path: voices → master (MASTER_GAIN, ≈ 6 dB headroom: four tracks can exceed 0 dBFS) → limiter → destination.
//   The limiter delays everything by its fixed look-ahead; outLat() includes that delay so `heard` stays exact.
import * as Tone from 'tone';
import micWorkletUrl from './mic-worklet.ts?worker&url';
import type { Sec } from '../types.ts';

export interface AudioEngine {
  readonly ctx: AudioContext;
  /** master bus (MASTER_GAIN net, after the limiter's makeup) → limiter → destination; every voice output connects here */
  readonly master: GainNode;
  /** output latency estimate, read live: baseLatency + outputLatency + the limiter's look-ahead delay */
  outLat(): Sec;
  /** 'interrupted' when iOS suspends audio (background, call), 'resumed' when it is running again */
  onLifecycle(cb: (e: 'interrupted' | 'resumed') => void): () => void;
  // ---- engine extensions (not in the shared contract) ----
  /** zero-gain node → destination: worklet taps connect their output here so they keep being pulled */
  readonly sink: GainNode;
  /** master → limiter → destination (tests capture it to see what reaches the speakers) */
  readonly limiter: DynamicsCompressorNode;
  /** Tone's worker-based ticker (every 15 ms); each callback is isolated by try/catch */
  onTick(cb: () => void): () => void;
}

/** Tone lookAhead; also sets Tone's ticker updateInterval to lookAhead / 2 = 15 ms */
const TONE_LOOKAHEAD_SEC = 0.03;
/** watchdog period for the frozen-clock check (iOS: state 'running' but currentTime stuck) */
const FROZEN_CHECK_MS = 1000;
/** don't wait forever for resume() (iOS may keep the promise pending until audio can start) */
const RESUME_WAIT_MS = 1500;
/** net gain master → speaker for signals below the limiter threshold: ≈ −6 dB headroom for four tracks */
export const MASTER_GAIN = 0.5;
/** gentle brick-wall-ish limiter after the master gain */
export const LIMITER = { thresholdDb: -3, kneeDb: 0, ratio: 20, attackSec: 0.003, releaseSec: 0.15 } as const;
/**
 * DynamicsCompressorNode adds automatic makeup gain (Web Audio spec): (1 / gain at 0 dBFS)^0.6. Hard knee:
 * gain at 0 dBFS = threshold·(1 − 1/ratio) dB = −2.85 dB → makeup +1.71 dB (×1.217, measured ×1.215).
 * The master gain divides it out so MASTER_GAIN is the real net gain.
 */
export const LIMITER_MAKEUP = 10 ** ((-0.6 * LIMITER.thresholdDb * (1 - 1 / LIMITER.ratio)) / 20);
/** DynamicsCompressorNode's fixed look-ahead (pre-delay) in Chromium and WebKit, measured by dev/engine/check.ts i2 */
export const LIMITER_DELAY_SEC = 0.006;

type LifecycleEvent = 'interrupted' | 'resumed';

/**
 * Must be CALLED synchronously inside the first user gesture (iOS unlock): the context is created and
 * resume() is called before the first await. Then Tone.setContext(ctx) and audioWorklet.addModule run.
 */
export function createAudioEngine(): Promise<AudioEngine> {
  // ---- synchronous part (inside the gesture) ----
  setPlayAndRecordSession();
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const resumed = ctx.resume().catch(() => {});
  const master = ctx.createGain();
  master.gain.value = MASTER_GAIN / LIMITER_MAKEUP;
  const limiter = createLimiter(ctx);
  master.connect(limiter).connect(ctx.destination);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);
  // ---- asynchronous part ----
  return finishEngine(ctx, master, limiter, sink, resumed);
}

function createLimiter(ctx: AudioContext): DynamicsCompressorNode {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = LIMITER.thresholdDb;
  c.knee.value = LIMITER.kneeDb;
  c.ratio.value = LIMITER.ratio;
  c.attack.value = LIMITER.attackSec;
  c.release.value = LIMITER.releaseSec;
  return c;
}

async function finishEngine(
  ctx: AudioContext, master: GainNode, limiter: DynamicsCompressorNode, sink: GainNode, resumed: Promise<void>,
): Promise<AudioEngine> {
  installToneContext(ctx);
  await ctx.audioWorklet.addModule(micWorkletUrl);
  await Promise.race([resumed, delay(RESUME_WAIT_MS)]);
  const lifecycle = watchLifecycle(ctx);
  const toneCtx = Tone.getContext();
  return {
    ctx,
    master,
    sink,
    limiter,
    outLat: () => (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + LIMITER_DELAY_SEC,
    onLifecycle: lifecycle.on,
    onTick(cb) {
      const safe = () => {
        try {
          cb();
        } catch (e) {
          console.error('tick callback failed', e);
        }
      };
      toneCtx.on('tick', safe);
      return () => void toneCtx.off('tick', safe);
    },
  };
}

/**
 * Tone wraps our native context. Importing 'tone' already created a stray (suspended) context at module load
 * (tone's index.js evaluates getContext() for its deprecated Transport/Destination consts) — dispose it.
 */
function installToneContext(ctx: AudioContext): void {
  try {
    Tone.setContext(ctx, true);
  } catch {
    Tone.setContext(ctx);
  }
  Tone.getContext().lookAhead = TONE_LOOKAHEAD_SEC;
}

/** iOS 17+: keep play-and-record so output does not drop to the earpiece-only route when the mic opens */
function setPlayAndRecordSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) nav.audioSession.type = 'play-and-record';
  } catch {
    /* not supported */
  }
}

/** resume on visibility/statechange, kick a frozen clock, emit interrupted/resumed transitions */
function watchLifecycle(ctx: AudioContext): { on: (cb: (e: LifecycleEvent) => void) => () => void } {
  const subs = new Set<(e: LifecycleEvent) => void>();
  let interrupted = ctx.state !== 'running';
  const emit = (e: LifecycleEvent) => {
    for (const cb of [...subs]) {
      try {
        cb(e);
      } catch (err) {
        console.error('lifecycle callback failed', err);
      }
    }
  };
  const setInterrupted = (v: boolean) => {
    if (v === interrupted) return;
    interrupted = v;
    emit(v ? 'interrupted' : 'resumed');
  };
  const tryResume = () => {
    if (ctx.state === 'closed' || document.visibilityState !== 'visible') return;
    if ((ctx.state as string) !== 'running') void ctx.resume().catch(() => {});
  };
  // addEventListener, not onstatechange: Tone assigns ctx.onstatechange itself
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'closed') return;
    setInterrupted((ctx.state as string) !== 'running');
    tryResume();
  });
  document.addEventListener('visibilitychange', tryResume);
  let lastTime = ctx.currentTime;
  setInterval(() => {
    const frozen = (ctx.state as string) === 'running' && ctx.currentTime === lastTime;
    lastTime = ctx.currentTime;
    if (!frozen || document.visibilityState !== 'visible') return;
    setInterrupted(true);
    void ctx
      .suspend()
      .then(() => ctx.resume())
      .catch(() => {});
  }, FROZEN_CHECK_MS);
  return {
    on(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
