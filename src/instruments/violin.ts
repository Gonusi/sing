// [instruments] Violin: a legato phrase voice on the VSCO 2 sustain samples (native Web Audio, no Tone).
// One attack per phrase; inside a phrase the pitch glides by ramping playbackRate, and a jump of more than
// SWITCH_SEMITONES from the playing sample's root crossfades to the nearest sample. Sources loop a pre-crossfaded
// sustain region (violin-assets.ts), so a note of any length never runs out. Lifecycle and release: phrase.ts.
//
// Graph: per phrase [layer source → layer gain]… → phrase env → lowpass ─┬→ dry ─┬→ gate → output
//                                                                        └→ room (convolver) → wet ─┘
import type { Note, Sec, Voice } from '../types.ts';
import { createPhraseVoice, type PhraseSound } from './phrase.ts';
import { createGate, createOutput, isNote, type Ctx, type NoteSpan } from './shared.ts';
import { violinAssets, type ViolinSample } from './violin-assets.ts';

/** ≈ 95 % of the level after 40 ms */
const ATTACK_TAU: Sec = 0.013;
/** ≈ −26 dB 0.3 s after the phrase end; sources stop after 7 τ = 0.7 s */
const RELEASE_TAU: Sec = 0.1;
/** level change at a legato note (follows each note's vel) */
const VEL_TAU: Sec = 0.05;
/** portato dip before a repeated pitch inside a phrase (phrase.ts): −6 dB at the envelope, ≈ −3.5 dB heard (room) */
const REPEAT_DIP = 0.5;
/** pitch glide between legato notes (exponential playbackRate ramp from the note's start) */
const GLIDE: Sec = 0.05;
/** within this many semitones of the playing sample's root the sample is only re-pitched */
const SWITCH_SEMITONES = 2;
/** a switched-to sample starts this far in, past its bow attack */
const SWITCH_ENTRY: Sec = 0.3;
/** equal-power crossfade between the old and the new sample */
const XFADE: Sec = 0.07;
const XFADE_POINTS = 32;
/** after its crossfade the old layer plays on this long (silent) before it is stopped */
const RETIRE_MARGIN: Sec = 0.005;
/** a new value curve starts at least this long after the previous one ends (curves may not overlap) */
const CURVE_GAP: Sec = 0.001;
const LOWPASS_HZ = 7000;
const DRY_LEVEL = 1;
/** room level after the convolver's own normalisation */
const ROOM_WET = 0.18;
/** fixed output trim (sample RMS 0.12 × velGain → about −20 dBFS RMS per note) */
const OUTPUT_LEVEL = 1;

const FADE_OUT = equalPowerCurve(false);
const FADE_IN = equalPowerCurve(true);

export function createViolinVoice(ctx: Ctx): Voice {
  const assets = violinAssets(ctx.sampleRate);
  const output = createOutput(ctx, OUTPUT_LEVEL);
  const gate = createGate(ctx);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = LOWPASS_HZ;
  const dry = ctx.createGain();
  dry.gain.value = DRY_LEVEL;
  const room = ctx.createConvolver();
  room.buffer = assets.room;
  const wet = ctx.createGain();
  wet.gain.value = ROOM_WET;
  lowpass.connect(dry).connect(gate.node);
  lowpass.connect(room).connect(wet).connect(gate.node);
  gate.node.connect(output);

  const phrases = createPhraseVoice({
    ctx,
    destination: lowpass,
    gate,
    envelope: {
      attackTau: ATTACK_TAU,
      sustain: 1,
      decayDelay: 0,
      decayTau: 1,
      velTau: VEL_TAU,
      releaseTau: RELEASE_TAU,
      repeatDip: REPEAT_DIP,
    },
    start: (note, span, env) => startViolinSound(ctx, assets.samples, note, span, env),
  });

  return {
    kind: 'violin',
    output,
    play(ev, when, offset) {
      if (isNote(ev)) phrases.play(ev, when, offset);
    },
    stopAll: (at) => phrases.stopAll(at),
    dispose() {
      phrases.dispose();
      for (const node of [lowpass, dry, room, wet, gate.node, output]) node.disconnect();
    },
  };
}

/** One looping sample source with its own crossfade gain, playing `midi`. */
interface Layer {
  src: AudioBufferSourceNode;
  gain: GainNode;
  sample: ViolinSample;
  /** the pitch this layer plays (after its pending glide) */
  midi: number;
  /** crossfaded out and stopped for good: phrase-level stops no longer touch it */
  retired: boolean;
  /** end of the last glide / crossfade curve on it (automation never overlaps) */
  glideEnd: Sec;
  curveEnd: Sec;
}

function startViolinSound(ctx: Ctx, samples: ViolinSample[], note: Note, span: NoteSpan, env: GainNode): PhraseSound {
  const first = nearestSample(samples, note.midi);
  const layers: Layer[] = [
    startLayer(ctx, first, note.midi, span.start, span.skipped * playbackRate(first, note.midi), env, 1),
  ];
  const active = () => layers[layers.length - 1];

  return {
    legato(next, s) {
      const cur = active();
      const target = nearestSample(samples, next.midi);
      if (target === cur.sample || Math.abs(next.midi - cur.sample.root) <= SWITCH_SEMITONES) {
        glide(cur, next.midi, s.start);
        return;
      }
      // both layers glide from the current pitch to the new one while they crossfade
      const incoming = startLayer(ctx, target, cur.midi, s.start, SWITCH_ENTRY, env, 0);
      glide(incoming, next.midi, s.start);
      glide(cur, next.midi, s.start);
      const t = Math.max(s.start, cur.curveEnd + CURVE_GAP);
      cur.gain.gain.setValueCurveAtTime(FADE_OUT, t, XFADE);
      incoming.gain.gain.setValueCurveAtTime(FADE_IN, t, XFADE);
      cur.curveEnd = incoming.curveEnd = t + XFADE;
      cur.src.stop(t + XFADE + RETIRE_MARGIN);
      cur.retired = true;
      layers.push(incoming);
    },
    stopAt(at) {
      for (const l of layers) if (!l.retired) l.src.stop(at);
    },
    disconnect() {
      for (const l of layers) {
        l.src.disconnect();
        l.gain.disconnect();
      }
    },
  };
}

function startLayer(
  ctx: Ctx,
  sample: ViolinSample,
  midi: number,
  at: Sec,
  bufferOffset: Sec,
  destination: AudioNode,
  initialGain: number,
): Layer {
  const src = ctx.createBufferSource();
  src.buffer = sample.buffer;
  src.loop = true;
  src.loopStart = sample.loopStart;
  src.loopEnd = sample.loopEnd;
  const rate = playbackRate(sample, midi);
  src.playbackRate.value = rate;
  src.playbackRate.setValueAtTime(rate, at);
  const gain = ctx.createGain();
  gain.gain.value = initialGain;
  src.connect(gain).connect(destination);
  src.start(at, wrapIntoLoop(sample, bufferOffset));
  return { src, gain, sample, midi, retired: false, glideEnd: -Infinity, curveEnd: -Infinity };
}

/** exponential playbackRate ramp to `midi` over GLIDE, from `at` (or from the end of a glide still running) */
function glide(layer: Layer, midi: number, at: Sec): void {
  if (midi === layer.midi) return;
  const t = Math.max(at, layer.glideEnd);
  layer.src.playbackRate.setValueAtTime(playbackRate(layer.sample, layer.midi), t);
  layer.src.playbackRate.exponentialRampToValueAtTime(playbackRate(layer.sample, midi), t + GLIDE);
  layer.midi = midi;
  layer.glideEnd = t + GLIDE;
}

function playbackRate(sample: ViolinSample, midi: number): number {
  return 2 ** ((midi - sample.root) / 12);
}

/** the sample whose root is nearest to `midi` (ties → the lower one) */
function nearestSample(samples: ViolinSample[], midi: number): ViolinSample {
  let best = samples[0];
  for (const s of samples) if (Math.abs(midi - s.root) < Math.abs(midi - best.root)) best = s;
  return best;
}

/** a buffer offset past loopEnd continues inside the loop region, as playback would */
function wrapIntoLoop(sample: ViolinSample, offset: Sec): Sec {
  if (offset < sample.loopEnd) return Math.max(0, offset);
  const len = sample.loopEnd - sample.loopStart;
  return sample.loopStart + ((offset - sample.loopStart) % len);
}

function equalPowerCurve(rising: boolean): Float32Array {
  const c = new Float32Array(XFADE_POINTS);
  for (let i = 0; i < XFADE_POINTS; i++) {
    const w = (i / (XFADE_POINTS - 1)) * (Math.PI / 2);
    c[i] = rising ? Math.sin(w) : Math.cos(w);
  }
  return c;
}
