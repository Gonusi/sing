// [engine] Test/debug tap: records any AudioNode with frame stamps (via the 'capture-tap' processor in mic-worklet).
// start(node): node → capture-tap → engine.sink. stop(): resolves the mono mix with the frame of pcm[0].
import type { AudioEngine } from './context.ts';

export interface CaptureResult {
  /** context frame of pcm[0] */
  frame: number;
  sampleRate: number;
  pcm: Float32Array;
}

export interface Capture {
  start(node: AudioNode): void;
  stop(): Promise<CaptureResult>;
}

interface ChunkMsg {
  type: 'chunk' | 'end';
  frame?: number;
  samples?: Float32Array;
}

export function createCapture(engine: AudioEngine): Capture {
  const { ctx } = engine;
  let tap: AudioWorkletNode | null = null;
  let source: AudioNode | null = null;
  let chunks: { frame: number; samples: Float32Array }[] = [];
  let ended: Promise<void> = Promise.resolve();

  const detach = () => {
    if (source && tap) source.disconnect(tap);
    tap?.disconnect();
    if (tap) tap.port.onmessage = null;
    tap = null;
    source = null;
  };

  return {
    start(node) {
      detach();
      chunks = [];
      const t = new AudioWorkletNode(ctx, 'capture-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      ended = new Promise<void>((resolve) => {
        t.port.onmessage = (e: MessageEvent<ChunkMsg>) => {
          const m = e.data;
          if (m.type === 'chunk' && m.samples && m.frame !== undefined) chunks.push({ frame: m.frame, samples: m.samples });
          if (m.type === 'end') resolve();
        };
      });
      node.connect(t);
      t.connect(engine.sink);
      tap = t;
      source = node;
    },
    async stop() {
      if (!tap) return { frame: 0, sampleRate: ctx.sampleRate, pcm: new Float32Array(0) };
      tap.port.postMessage({ type: 'stop' });
      await ended;
      detach();
      return joinChunks(chunks, ctx.sampleRate);
    },
  };
}

/** chunks are contiguous (one per CAPTURE_CHUNK frames); place each by its frame anyway */
function joinChunks(chunks: { frame: number; samples: Float32Array }[], sampleRate: number): CaptureResult {
  if (chunks.length === 0) return { frame: 0, sampleRate, pcm: new Float32Array(0) };
  const first = chunks[0].frame;
  const last = chunks[chunks.length - 1];
  const pcm = new Float32Array(last.frame + last.samples.length - first);
  for (const c of chunks) pcm.set(c.samples, c.frame - first);
  return { frame: first, sampleRate, pcm };
}
