// [engine] Voice for 'vocals' tracks: plays the recorded loop audio (raw, not analysed).
// Buffer layout (built by loop/take.ts): Ls loop samples (sample 0 = loop pos 0) + a VOCAL_TAIL_SEC tail that is a
// copy of the loop's first samples. The scheduler hands over one event per cycle (pos 0, dur L).
// Each cycle: AudioBufferSourceNode.start(when, offset) through its own gain:
//   cycle start (offset < tail): fade in over the tail length from buffer time 0;
//   catch-up start (offset ≥ tail): 10 ms fade-in;
//   buffer time [Ls, end): fade out over the tail — overlapping the next cycle's fade-in on identical samples, so the
//   seam sums to exactly the loop audio (no click, no level bump).
import type { InstrumentKind, Note, Sec, Voice } from '../types.ts';
import { VOCAL_TAIL_SEC } from '../loop/take.ts';

const CATCHUP_FADE_SEC = 0.01;
const STOP_FADE_SEC = 0.015;

export function createVocalVoice(ctx: BaseAudioContext, buffer: () => AudioBuffer | null): Voice {
  const output = ctx.createGain();
  const playing = new Set<{ src: AudioBufferSourceNode; g: GainNode }>();
  const kind: InstrumentKind = 'vocals';

  const play = (_ev: Note | unknown, when: Sec, offset = 0) => {
    const buf = buffer();
    if (!buf) return;
    const tail = Math.round(VOCAL_TAIL_SEC * buf.sampleRate) / buf.sampleRate;
    const loopDur = buf.duration - tail;
    if (offset >= buf.duration - 0.001) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const p = g.gain;
    // a source started at a fractional `when` renders its first sample in the frame before the automation begins:
    // the gain must already be 0 there (default 1 doubled that one sample against the previous cycle's tail)
    p.value = 0;
    if (offset < tail) {
      p.setValueAtTime(offset / tail, when);
      p.linearRampToValueAtTime(1, when + (tail - offset));
    } else {
      p.setValueAtTime(0, when);
      p.linearRampToValueAtTime(1, when + CATCHUP_FADE_SEC);
    }
    const fadeFrom = when + (loopDur - offset);
    const end = when + (buf.duration - offset);
    if (fadeFrom > when + CATCHUP_FADE_SEC) p.setValueAtTime(1, fadeFrom);
    p.linearRampToValueAtTime(0, end);
    src.connect(g).connect(output);
    src.start(when, offset);
    src.stop(end + 0.005);
    const entry = { src, g };
    playing.add(entry);
    src.onended = () => {
      playing.delete(entry);
      g.disconnect();
    };
  };

  const stopAll = (at: Sec) => {
    const t = Math.max(at, ctx.currentTime);
    for (const { src, g } of playing) {
      const p = g.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
      if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
      else {
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
      }
      p.linearRampToValueAtTime(0, t + STOP_FADE_SEC);
      try {
        src.stop(t + STOP_FADE_SEC + 0.005);
      } catch {
        /* already stopped */
      }
    }
  };

  return {
    kind,
    output,
    play: (ev, when, offset) => play(ev, when, offset ?? 0),
    stopAll,
    dispose() {
      stopAll(ctx.currentTime);
      setTimeout(() => output.disconnect(), 100);
    },
  };
}
