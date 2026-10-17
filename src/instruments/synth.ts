// [instruments] Synth: a plucky polyphonic voice from a pool of Tone.Synth (one per sounding note).
// Not Tone.PolySynth: PolySynth defers future notes through context.setTimeout, which fires on Tone's clock ticks —
// that would tie note timing to the engine's lookAhead setting, and it never fires in a raw offline render.
// Every note here is scheduled immediately at its exact time.
//
// Graph: pool of Tone.Synth → gate → output
import { Synth } from 'tone';
import type { Sec, Voice } from '../types.ts';
import { createGate, createOutput, isNote, midiToHz, noteSpan, velGain, type Ctx } from './shared.ts';
import { silenceEnvelope, toneContext } from './tone-util.ts';

/** most notes sounding at once; a further note steals the voice that frees up first */
const POOL_MAX = 8;
/** relative amplitude of each harmonic: a soft, rolled-off saw (custom PeriodicWave, one oscillator per note) */
const PARTIALS = [1, 0.5, 0.3, 0.18, 0.1, 0.06, 0.035, 0.02];
/** seconds, seconds, fraction, seconds: plucky, short release */
const ENVELOPE = { attack: 0.005, decay: 0.18, sustain: 0.5, release: 0.2 };
/** fixed output trim: brings a note to about −20 dBFS RMS */
const OUTPUT_LEVEL = 0.3;

interface PoolVoice {
  synth: Synth;
  /** context time its last note (with release) is over */
  busyUntil: Sec;
  /** start time of its last note (Tone requires strictly increasing start times per synth) */
  lastStart: Sec;
}

export function createSynthVoice(ctx: Ctx): Voice {
  const tone = toneContext(ctx);
  const output = createOutput(ctx, OUTPUT_LEVEL);
  const gate = createGate(ctx);
  gate.node.connect(output);
  const pool: PoolVoice[] = [];

  function freeVoice(t: Sec): PoolVoice | null {
    const idle = pool.find((v) => v.busyUntil <= t);
    if (idle) return idle;
    if (pool.length < POOL_MAX) {
      const synth = new Synth({ context: tone, oscillator: { type: 'custom', partials: PARTIALS }, envelope: ENVELOPE });
      synth.connect(gate.node);
      const v = { synth, busyUntil: -Infinity, lastStart: -Infinity };
      pool.push(v);
      return v;
    }
    const stealable = pool.filter((v) => v.lastStart < t);
    return stealable.sort((a, b) => a.busyUntil - b.busyUntil)[0] ?? null;
  }

  return {
    kind: 'synth',
    output,
    play(ev, when, offset) {
      if (!isNote(ev)) return;
      const span = noteSpan(ctx, ev, when, offset);
      const t = span.start;
      const dur = span.end - t;
      const v = freeVoice(t);
      if (!v) return;
      gate.open(t);
      try {
        v.synth.triggerAttackRelease(midiToHz(ev.midi), dur, t, velGain(ev.vel));
        v.busyUntil = t + dur + ENVELOPE.release;
        v.lastStart = t;
      } catch (e) {
        console.warn('[instruments] synth note dropped', e);
      }
    },
    stopAll(at) {
      const t = Math.max(at, ctx.currentTime);
      gate.close(t);
      for (const v of pool) {
        if (v.busyUntil <= t) continue;
        silenceEnvelope(v.synth.envelope, t);
        v.busyUntil = t;
      }
    },
    dispose() {
      for (const v of pool) v.synth.dispose();
      pool.length = 0;
      gate.node.disconnect();
      output.disconnect();
    },
  };
}
