// [instruments] Bass: a legato phrase voice (native Web Audio, no Tone), sharing the violin's phrase lifecycle
// (phrase.ts): one pluck per phrase, portamento between legato notes, release only when the phrase ends.
// Sound: one oscillator with a soft-saw harmonic series → resonant lowpass (pitch-tracked, brighter at the pluck)
// → phrase envelope. Harmonics 2–6 carry the pitch on phone speakers, which cannot play an 82 Hz fundamental.
//
// Graph: per phrase [oscillator → lowpass → phrase env] → gate → output
import type { Note, Sec, Voice } from '../types.ts';
import { createPhraseVoice, type PhraseSound } from './phrase.ts';
import { createGate, createOutput, isNote, midiToHz, type Ctx, type NoteSpan } from './shared.ts';

/** amplitude of harmonic n+1 (a soft saw: brighter than a sine, rounder than a saw) */
const HARMONICS = [1, 0.6, 0.42, 0.3, 0.22, 0.16, 0.11, 0.08, 0.055, 0.04];
/** pitch glide between legato notes */
const PORTAMENTO: Sec = 0.03;
/** lowpass cutoff while sustaining = f0 × this, clamped to [CUTOFF_MIN_HZ, CUTOFF_MAX_HZ] */
const CUTOFF_HARMONIC = 6;
const CUTOFF_MIN_HZ = 350;
const CUTOFF_MAX_HZ = 1600;
/** at the pluck the cutoff starts this many times higher and falls back with FILTER_DECAY_TAU */
const PLUCK_BRIGHTNESS = 2.5;
const FILTER_DECAY_TAU: Sec = 0.07;
/** lowpass resonance, dB (Web Audio lowpass Q is in dB) */
const FILTER_Q_DB = 2;
/** pluck: fast attack, then a decay to SUSTAIN of the velocity level */
const ATTACK_TAU: Sec = 0.003;
const SUSTAIN = 0.7;
const DECAY_DELAY: Sec = 0.015;
const DECAY_TAU: Sec = 0.18;
const VEL_TAU: Sec = 0.03;
/** portato dip before a repeated pitch inside a phrase (phrase.ts), ≈ −3 dB */
const REPEAT_DIP = 0.7;
/** ≈ −20 dB 0.1 s after the phrase end; oscillators stop after 7 τ ≈ 0.3 s */
const RELEASE_TAU: Sec = 0.045;
/** fixed output trim: the normalised wave peaks at 1; this brings a note to about −20 dBFS RMS */
const OUTPUT_LEVEL = 0.32;

export function createBassVoice(ctx: Ctx): Voice {
  const output = createOutput(ctx, OUTPUT_LEVEL);
  const gate = createGate(ctx);
  gate.node.connect(output);
  const wave = createSoftSaw(ctx);

  const phrases = createPhraseVoice({
    ctx,
    destination: gate.node,
    gate,
    envelope: {
      attackTau: ATTACK_TAU,
      sustain: SUSTAIN,
      decayDelay: DECAY_DELAY,
      decayTau: DECAY_TAU,
      velTau: VEL_TAU,
      releaseTau: RELEASE_TAU,
      repeatDip: REPEAT_DIP,
    },
    start: (note, span, env) => startBassSound(ctx, wave, note, span, env),
  });

  return {
    kind: 'bass',
    output,
    play(ev, when, offset) {
      if (isNote(ev)) phrases.play(ev, when, offset);
    },
    stopAll: (at) => phrases.stopAll(at),
    dispose() {
      phrases.dispose();
      gate.node.disconnect();
      output.disconnect();
    },
  };
}

function startBassSound(ctx: Ctx, wave: PeriodicWave, note: Note, span: NoteSpan, env: GainNode): PhraseSound {
  let hz = midiToHz(note.midi);
  let glideEnd = -Infinity;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = hz;
  osc.frequency.setValueAtTime(hz, span.start);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = FILTER_Q_DB;
  filter.frequency.value = cutoff(hz);
  filter.frequency.setValueAtTime(cutoff(hz) * PLUCK_BRIGHTNESS, span.start);
  filter.frequency.setTargetAtTime(cutoff(hz), span.start, FILTER_DECAY_TAU);
  osc.connect(filter).connect(env);
  osc.start(span.start);

  return {
    legato(next, s) {
      const to = midiToHz(next.midi);
      if (to === hz) return;
      const t = Math.max(s.start, glideEnd);
      osc.frequency.setValueAtTime(hz, t);
      osc.frequency.exponentialRampToValueAtTime(to, t + PORTAMENTO);
      filter.frequency.setTargetAtTime(cutoff(to), t, PORTAMENTO);
      hz = to;
      glideEnd = t + PORTAMENTO;
    },
    stopAt(at) {
      osc.stop(at);
    },
    disconnect() {
      osc.disconnect();
      filter.disconnect();
    },
  };
}

function cutoff(hz: number): number {
  return Math.min(CUTOFF_MAX_HZ, Math.max(CUTOFF_MIN_HZ, hz * CUTOFF_HARMONIC));
}

function createSoftSaw(ctx: Ctx): PeriodicWave {
  const real = new Float32Array(HARMONICS.length + 1);
  const imag = new Float32Array(HARMONICS.length + 1);
  HARMONICS.forEach((a, i) => (imag[i + 1] = a));
  return ctx.createPeriodicWave(real, imag);
}
