// [engine] Test/debug tap: records any AudioNode with frame stamps (via the capture processor in mic-worklet).
import type { AudioEngine } from './context.ts';

export interface Capture {
  start(node: AudioNode): void;
  stop(): Promise<{ frame: number; sampleRate: number; pcm: Float32Array }>;
}

export function createCapture(engine: AudioEngine): Capture {
  // STUB (engine replaces)
  return {
    start: () => {},
    stop: async () => ({ frame: 0, sampleRate: engine.ctx.sampleRate, pcm: new Float32Array(0) }),
  };
}
