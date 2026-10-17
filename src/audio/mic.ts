// [engine] getUserMedia (or, with ?test, no device at all) → mic-worklet → 2 s ring buffer → subscribers.
import type { MicBlock, MicFeed, Sec } from '../types.ts';
import type { AudioEngine } from './context.ts';

export interface Mic extends MicFeed {
  /** re-open the device with a new echoCancellation setting */
  setEc(ec: boolean): Promise<void>;
  /** MediaStreamTrack.getSettings().latency when the browser reports it */
  reportedLatency(): Sec | null;
  dispose(): void;
}

export interface MicOptions {
  /** true: never call getUserMedia; audio only comes from inject() */
  test: boolean;
  ec: boolean;
}

export async function createMic(engine: AudioEngine, _opts: MicOptions): Promise<Mic> {
  // STUB (engine replaces): a silent feed.
  const subs = new Set<(b: MicBlock) => void>();
  return {
    sampleRate: engine.ctx.sampleRate,
    subscribe: (cb) => (subs.add(cb), () => subs.delete(cb)),
    read: (from) => ({ t: from, samples: new Float32Array(0) }),
    inject: () => {},
    setEc: async () => {},
    reportedLatency: () => null,
    dispose: () => subs.clear(),
  };
}
