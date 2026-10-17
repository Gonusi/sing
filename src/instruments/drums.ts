// [instruments] Drums: kick (MembraneSynth), snare (band-limited NoiseSynth + a short tonal body), hat (MetalSynth).
// Tone sources throw "Start time must be strictly greater than previous start time" on same-time re-triggers, so a
// hit closer than MIN_SPACING to the previous hit of the same kind is dropped (it is the same hit), and every
// trigger is wrapped in try/catch. Spectral centroids rise kick < snare < hat (checked in dev/instruments).
//
// Graph: kick ──────────────────────────────┬→ gate → output
//        snare noise → highpass → lowpass ──┤
//        snare body ────────────────────────┤
//        hat ───────────────────────────────┘
import { Filter, MembraneSynth, MetalSynth, NoiseSynth, Synth } from 'tone';
import type { DrumKind, Sec, Voice } from '../types.ts';
import { createGate, createOutput, earliestStart, isNote, velGain, type Ctx } from './shared.ts';
import { silenceEnvelope, toneContext } from './tone-util.ts';

/** two hits of one kind closer than this are one hit */
const MIN_SPACING: Sec = 0.01;

/** kick: a 50 Hz membrane with a fast pitch drop from 6 octaves up (the click carries on phone speakers) */
const KICK_HZ = 50;
const KICK = {
  pitchDecay: 0.04,
  octaves: 6,
  oscillator: { type: 'sine' as const },
  envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.05 },
};
const KICK_DUR: Sec = 0.1;
const KICK_GAIN = 0.9;

/** snare: white noise band-limited to SNARE_HIGHPASS_HZ..SNARE_LOWPASS_HZ, plus a 185 Hz triangle body */
const SNARE_NOISE = { noise: { type: 'white' as const }, envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.03 } };
const SNARE_HIGHPASS_HZ = 500;
const SNARE_LOWPASS_HZ = 6000;
const SNARE_BODY_HZ = 185;
const SNARE_BODY = {
  oscillator: { type: 'triangle' as const },
  envelope: { attack: 0.001, decay: 0.08, sustain: 0, release: 0.02 },
};
const SNARE_DUR: Sec = 0.08;
const SNARE_NOISE_GAIN = 0.5;
const SNARE_BODY_GAIN = 0.35;

/** hat: metallic FM cluster through a 5 kHz resonant highpass */
const HAT_HZ = 320;
const HAT = {
  envelope: { attack: 0.001, decay: 0.07, release: 0.02 },
  harmonicity: 5.1,
  modulationIndex: 32,
  resonance: 5000,
  octaves: 1.5,
};
const HAT_DUR: Sec = 0.03;
const HAT_GAIN = 0.12;

/** fixed output trim: a vel-0.8 kick peaks at about −6 dBFS */
const OUTPUT_LEVEL = 0.65;

export function createDrumVoice(ctx: Ctx): Voice {
  const tone = toneContext(ctx);
  const output = createOutput(ctx, OUTPUT_LEVEL);
  const gate = createGate(ctx);
  gate.node.connect(output);

  const kick = new MembraneSynth({ ...KICK, context: tone }).connect(gate.node);
  const snareHighpass = new Filter({ frequency: SNARE_HIGHPASS_HZ, type: 'highpass', context: tone });
  const snareLowpass = new Filter({ frequency: SNARE_LOWPASS_HZ, type: 'lowpass', context: tone });
  const snareNoise = new NoiseSynth({ ...SNARE_NOISE, context: tone }).chain(snareHighpass, snareLowpass);
  snareLowpass.connect(gate.node);
  const snareBody = new Synth({ ...SNARE_BODY, context: tone }).connect(gate.node);
  const hat = new MetalSynth({ ...HAT, context: tone }).connect(gate.node);
  const lastHit: Record<DrumKind, Sec> = { kick: -Infinity, snare: -Infinity, hat: -Infinity };

  function trigger(kind: DrumKind, t: Sec, v: number): void {
    switch (kind) {
      case 'kick':
        kick.triggerAttackRelease(KICK_HZ, KICK_DUR, t, v * KICK_GAIN);
        break;
      case 'snare':
        snareNoise.triggerAttackRelease(SNARE_DUR, t, v * SNARE_NOISE_GAIN);
        snareBody.triggerAttackRelease(SNARE_BODY_HZ, SNARE_DUR, t, v * SNARE_BODY_GAIN);
        break;
      case 'hat':
        hat.triggerAttackRelease(HAT_HZ, HAT_DUR, t, v * HAT_GAIN);
        break;
    }
  }

  return {
    kind: 'drums',
    output,
    play(ev, when) {
      if (isNote(ev)) return;
      const t = earliestStart(ctx, when);
      if (t < lastHit[ev.kind] + MIN_SPACING) return;
      lastHit[ev.kind] = t;
      gate.open(t);
      try {
        trigger(ev.kind, t, velGain(ev.vel));
      } catch (e) {
        console.warn('[instruments] drum hit dropped', e);
      }
    },
    stopAll(at) {
      const t = Math.max(at, ctx.currentTime);
      gate.close(t);
      for (const env of [kick.envelope, snareNoise.envelope, snareBody.envelope, hat.envelope]) silenceEnvelope(env, t);
    },
    dispose() {
      for (const node of [kick, snareNoise, snareHighpass, snareLowpass, snareBody, hat]) node.dispose();
      gate.node.disconnect();
      output.disconnect();
    },
  };
}
