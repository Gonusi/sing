// [engine] The one native AudioContext, Tone.setContext, worklet module, master bus, iOS lifecycle.
import type { Sec } from '../types.ts';

export interface AudioEngine {
  readonly ctx: AudioContext;
  /** master bus → destination; every voice output connects here */
  readonly master: GainNode;
  /** output latency estimate, read live: baseLatency + outputLatency */
  outLat(): Sec;
  /** 'interrupted' when iOS suspends audio (background, call), 'resumed' when it is running again */
  onLifecycle(cb: (e: 'interrupted' | 'resumed') => void): () => void;
}

/**
 * Must be CALLED synchronously inside the first user gesture (iOS unlock): the context is created and
 * resume() is called before the first await. Then Tone.setContext(ctx) and audioWorklet.addModule run.
 */
export function createAudioEngine(): Promise<AudioEngine> {
  // STUB (engine replaces): minimal context so the app boots.
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  void ctx.resume();
  const master = ctx.createGain();
  master.connect(ctx.destination);
  return Promise.resolve({
    ctx,
    master,
    outLat: () => (ctx.baseLatency || 0) + (ctx.outputLatency || 0),
    onLifecycle: () => () => {},
  });
}
