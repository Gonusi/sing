// [instruments] Offline render harness for the instruments check: one native OfflineAudioContext per render, Tone
// pointed at it (as the engine does with its AudioContext), and every event handed to the voice LEAD seconds before
// its time through suspend()/resume() — the way the engine's scheduler hands notes over ~0.12 s ahead — so
// ctx.currentTime inside the voice is the real hand-over time (continuations, late notes, cancellable releases).
import { setContext } from 'tone';
import { createVoice, preloadInstruments } from '../../src/instruments/index.ts';
import type { DrumHit, InstrumentKind, Note, Sec, Voice } from '../../src/types.ts';

export const SR = 48000;
/** how early the engine hands an event to the voice */
export const LEAD: Sec = 0.12;
/** OfflineAudioContext.suspend() resolves on render-quantum boundaries */
const QUANTUM: Sec = 128 / SR;

export interface Feed {
  ev: Note | DrumHit;
  when: Sec;
  offset?: Sec;
  /** context time the voice receives it (default when − LEAD, clamped to 0) */
  arrive?: Sec;
}

/** something else done to the voice at context time `at` (e.g. stopAll) */
export interface Act {
  at: Sec;
  run(voice: Voice): void;
}

export interface Rendered {
  pcm: Float32Array;
  /** exceptions thrown out of play/stopAll/dispose */
  errors: string[];
  /** console.warn calls made while rendering */
  warnings: string[];
}

export async function renderVoice(kind: InstrumentKind, seconds: Sec, feeds: Feed[], acts: Act[] = []): Promise<Rendered> {
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  setContext(offline);
  await preloadInstruments(offline);
  const errors: string[] = [];
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
    warn(...args);
  };
  try {
    const voice = createVoice(kind, offline);
    voice.output.connect(offline.destination);
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        errors.push(String(e));
      }
    };
    const steps = [
      ...feeds.map((f) => ({ at: f.arrive ?? f.when - LEAD, run: () => voice.play(f.ev, f.when, f.offset) })),
      ...acts.map((a) => ({ at: a.at, run: () => a.run(voice) })),
    ].sort((a, b) => a.at - b.at);
    const byQuantum = new Map<number, (() => void)[]>();
    for (const s of steps) {
      const q = Math.max(0, Math.round(s.at / QUANTUM));
      if (q * QUANTUM >= seconds) continue;
      if (!byQuantum.has(q)) byQuantum.set(q, []);
      byQuantum.get(q)!.push(s.run);
    }
    for (const [q, runs] of byQuantum) {
      const runAll = () => runs.forEach(guard);
      if (q === 0) runAll();
      else
        void offline.suspend(q * QUANTUM).then(() => {
          runAll();
          void offline.resume();
        });
    }
    const buf = await offline.startRendering();
    guard(() => voice.dispose());
    return { pcm: buf.getChannelData(0).slice(), errors, warnings };
  } finally {
    console.warn = warn;
  }
}

/** render a blip into a fresh offline context at `at` */
export async function renderBlip(play: (ctx: BaseAudioContext, at: Sec) => void, seconds: Sec, at: Sec): Promise<Float32Array> {
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  play(offline, at);
  const buf = await offline.startRendering();
  return buf.getChannelData(0).slice();
}
