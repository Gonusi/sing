// [dsp] Deterministic synthetic fixtures for the analysis pipeline (and later the e2e tester).
// Writes dev/fixtures/out/<name>.wav (mono 16-bit, 48 kHz unless the name says otherwise) and
// <name>.json ground truth: { name, description, sampleRate, durationSec, notes: [{t, dur, midi}], hits: [{t, kind}] }.
//   notes[].t   = onset in seconds from the file start (attack start after a gap; boundary centre for a slur or a dip)
//   notes[].midi = the intended integer MIDI note (the "voice" sings it detuned by up to ±30 cents)
//   hits[].t    = sample-exact start of the drum sound
// Usage: node dev/make-fixtures.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeWav } from './wav.ts';

// ---------- constants ----------
export const FIXTURE_SAMPLE_RATE_HZ = 48000;
export const FIXTURE_OUT_DIR = join(import.meta.dirname, 'fixtures', 'out');

const LEAD_IN_SEC = 0.5;
const TAIL_SEC = 0.6;
const BACKGROUND_NOISE_DBFS = -45;

// voice
const VOICE_ATTACK_SEC = 0.03;
const VOICE_RELEASE_SEC = 0.04;
const VIBRATO_RATE_HZ = 5.5;
const VIBRATO_DEPTH_CENTS = 30;
const VIBRATO_DELAY_SEC = 0.15;
const VIBRATO_FADE_IN_SEC = 0.1;
const DETUNE_MAX_CENTS = 30;
const SLUR_GLIDE_SEC = 0.04;
const PITCH_JITTER_CENTS = 4;
const SHIMMER_FRACTION = 0.03;
const ASPIRATION_REL_DB = -26;
const BREATH_IN_GAP_DBFS = -40;
const BREATH_MIN_GAP_SEC = 0.09;
const HARMONIC_MAX_HZ = 9000;
const CONTROL_BLOCK_SAMPLES = 32;
interface Formant {
  hz: number;
  bwHz: number;
}
/** "ah" vowel: cascade of 2nd-order resonators (Hz, bandwidth Hz) */
const FORMANTS_AH: Formant[] = [
  { hz: 700, bwHz: 130 },
  { hz: 1220, bwHz: 140 },
  { hz: 2600, bwHz: 220 },
];
/** "oo": strong fundamental, weak upper harmonics */
const FORMANTS_OO: Formant[] = [
  { hz: 300, bwHz: 80 },
  { hz: 870, bwHz: 100 },
  { hz: 2240, bwHz: 200 },
];
/** "ee": low F1, high F2 (weak fundamental region for low voices) */
const FORMANTS_EE: Formant[] = [
  { hz: 270, bwHz: 70 },
  { hz: 2290, bwHz: 150 },
  { hz: 3010, bwHz: 250 },
];

/** how the synthetic singer sings; DEFAULT_VOICE is what the spec's sung fixtures use */
interface VoiceStyle {
  vibratoCents: number;
  vibratoHz: number;
  vibratoDelaySec: number;
  /** gap-started notes begin this many cents flat and rise over scoopSec */
  scoopCents: number;
  scoopSec: number;
  attackSec: number;
  aspirationRelDb: number;
  /** cycled per note */
  vowels: Formant[][];
}

const DEFAULT_VOICE: VoiceStyle = {
  vibratoCents: VIBRATO_DEPTH_CENTS,
  vibratoHz: VIBRATO_RATE_HZ,
  vibratoDelaySec: VIBRATO_DELAY_SEC,
  scoopCents: 0,
  scoopSec: 0.08,
  attackSec: VOICE_ATTACK_SEC,
  aspirationRelDb: ASPIRATION_REL_DB,
  vowels: [FORMANTS_AH],
};

// drums
const BPM_BEATBOX = 100;
const KICK_SWEEP_START_HZ = 120;
const KICK_SWEEP_END_HZ = 50;
const KICK_SWEEP_SEC = 0.12;
const KICK_LEN_SEC = 0.16;
const SNARE_LEN_SEC = 0.12;
const SNARE_BODY_HZ = 200;
const HAT_LEN_SEC = 0.04;
const HAT_HIGHPASS_HZ = 7000;
const PHONE_HIGHPASS_HZ = 120;
const PHONE_LOWPASS_HZ = 8000;
const PHONE_LEVEL_VARIATION_DB = 6;
const PHONE_BASE_GAIN_DB = -6;
const PHONE_TIMING_JITTER_SEC = 0.012;

// ---------- types ----------
export type DrumKindName = 'kick' | 'snare' | 'hat';

export interface FixtureTruth {
  name: string;
  description: string;
  /** false for stress-* fixtures: reported by dev/analyze.ts but not part of its pass/fail thresholds */
  gated: boolean;
  sampleRate: number;
  durationSec: number;
  notes: { t: number; dur: number; midi: number }[];
  hits: { t: number; kind: DrumKindName }[];
}

/** How a sung note joins the previous one. */
type Join = { kind: 'gap'; sec: number } | { kind: 'slur' } | { kind: 'dip'; depthDb: number; sec: number };

interface SungNote {
  midi: number;
  dur: number;
  join: Join;
}

// ---------- PRNG ----------
/** mulberry32: deterministic 32-bit PRNG, returns floats in [0, 1) */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uniform = (rng: () => number, lo: number, hi: number) => lo + (hi - lo) * rng();
const dbToGain = (db: number) => 10 ** (db / 20);
const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const raisedCos = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

// ---------- filters (RBJ biquads, one-pole) ----------
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function biquad(type: 'lowpass' | 'highpass' | 'bandpass', hz: number, q: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  let b0: number, b1: number, b2: number;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function applyBiquad(x: Float64Array, f: Biquad): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

function whiteNoise(n: number, rng: () => number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() * 2 - 1;
  return out;
}

function rmsOf(x: Float64Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/** background room noise at BACKGROUND_NOISE_DBFS, lightly low-passed */
function backgroundNoise(n: number, sampleRate: number, rng: () => number, dbfs = BACKGROUND_NOISE_DBFS): Float64Array {
  const x = whiteNoise(n, rng);
  applyBiquad(x, biquad('lowpass', 9000, 0.707, sampleRate));
  const g = dbToGain(dbfs) / rmsOf(x);
  for (let i = 0; i < n; i++) x[i] *= g;
  return x;
}

// ---------- voice ----------
/** cascade formant magnitude (normalised to 1 at DC) times a -6 dB/octave source tilt */
function harmonicAmplitude(k: number, f0: number, formants: Formant[]): number {
  const f = k * f0;
  let mag = 1;
  for (const fm of formants) {
    const r = f / fm.hz;
    const d = (f * fm.bwHz) / (fm.hz * fm.hz);
    mag /= Math.sqrt((1 - r * r) ** 2 + d * d);
  }
  return mag / k;
}

interface PlacedNote extends SungNote {
  start: number;
  end: number;
  detuneSemis: number;
  levelRms: number;
  vibPhase: number;
  vibRateHz: number;
  style: VoiceStyle;
  formants: Formant[];
}

function placeNotes(notes: SungNote[], rng: () => number, baseDbfs: number, style: VoiceStyle): PlacedNote[] {
  const placed: PlacedNote[] = [];
  let cursor = 0;
  for (const [i, n] of notes.entries()) {
    const start = n.join.kind === 'gap' ? cursor + n.join.sec : cursor;
    placed.push({
      ...n,
      start,
      end: start + n.dur,
      detuneSemis: uniform(rng, -DETUNE_MAX_CENTS, DETUNE_MAX_CENTS) / 100,
      levelRms: dbToGain(baseDbfs + uniform(rng, -3, 3)),
      vibPhase: uniform(rng, 0, 2 * Math.PI),
      vibRateHz: style.vibratoHz * uniform(rng, 0.95, 1.05),
      style,
      formants: style.vowels[i % style.vowels.length],
    });
    cursor = start + n.dur;
  }
  return placed;
}

/** pitch (fractional MIDI) of note `n` at absolute time t, including detune and delayed vibrato */
function notePitch(n: PlacedNote, t: number): number {
  const age = t - n.start;
  const st = n.style;
  const vibDepth = (st.vibratoCents / 100) * raisedCos((age - st.vibratoDelaySec) / VIBRATO_FADE_IN_SEC);
  const scoop = n.join.kind === 'gap' && st.scoopCents > 0 ? (-st.scoopCents / 100) * (1 - smoothstep(age / st.scoopSec)) : 0;
  return n.midi + n.detuneSemis + scoop + vibDepth * Math.sin(n.vibPhase + 2 * Math.PI * n.vibRateHz * age);
}

/** Render a sung line into `out` (added). Returns ground-truth notes. */
function renderVoice(out: Float64Array, sampleRate: number, notes: PlacedNote[], rng: () => number): FixtureTruth['notes'] {
  const n = out.length;
  const pitch = new Float64Array(n).fill(NaN);
  const amp = new Float64Array(n);
  const noteOf = new Int32Array(n).fill(-1);

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const prev = i > 0 ? notes[i - 1] : null;
    const next = i + 1 < notes.length ? notes[i + 1] : null;
    const joinedBefore = note.join.kind !== 'gap';
    const joinedAfter = next !== null && next.join.kind !== 'gap';
    const s0 = Math.round(note.start * sampleRate);
    const s1 = Math.min(n, Math.round(note.end * sampleRate));
    for (let s = s0; s < s1; s++) {
      const t = s / sampleRate;
      let p = notePitch(note, t);
      let level = note.levelRms;
      // slur: pitch and level glide across the boundary (centred on it)
      if (note.join.kind === 'slur' && prev && t < note.start + SLUR_GLIDE_SEC / 2) {
        const w = smoothstep((t - (note.start - SLUR_GLIDE_SEC / 2)) / SLUR_GLIDE_SEC);
        p = (1 - w) * notePitch(prev, t) + w * p;
        level = (1 - w) * prev.levelRms + w * level;
      }
      if (next && next.join.kind === 'slur' && t >= note.end - SLUR_GLIDE_SEC / 2) {
        const w = smoothstep((t - (note.end - SLUR_GLIDE_SEC / 2)) / SLUR_GLIDE_SEC);
        p = (1 - w) * p + w * notePitch(next, t);
        level = (1 - w) * level + w * next.levelRms;
      }
      let env = 1;
      if (!joinedBefore) env *= raisedCos((t - note.start) / note.style.attackSec);
      if (!joinedAfter) env *= raisedCos((note.end - t) / VOICE_RELEASE_SEC);
      // dip: amplitude notch centred on the boundary
      if (note.join.kind === 'dip' && t < note.start + note.join.sec / 2) env *= dipGain(t - note.start, note.join);
      if (next && next.join.kind === 'dip' && t >= note.end - next.join.sec / 2) env *= dipGain(t - note.end, next.join);
      pitch[s] = p;
      amp[s] = level * env;
      noteOf[s] = i;
    }
  }

  // slow random pitch jitter and amplitude shimmer (one-pole smoothed noise)
  let jitter = 0;
  let shimmer = 0;
  const smooth = Math.exp((-2 * Math.PI * 12) / sampleRate);
  const unitStdGain = Math.sqrt(3) * Math.sqrt((1 + smooth) / (1 - smooth)); // one-pole output std ≈ 1
  // additive synthesis via the sin(k·φ) Chebyshev recurrence
  let phase = 0;
  const amps = new Float64Array(Math.ceil(HARMONIC_MAX_HZ / 60) + 2);
  let harmonicCount = 0;
  let lastNote = -1;
  for (let s = 0; s < n; s++) {
    jitter = smooth * jitter + (1 - smooth) * (rng() * 2 - 1) * unitStdGain;
    shimmer = smooth * shimmer + (1 - smooth) * (rng() * 2 - 1) * unitStdGain;
    if (Number.isNaN(pitch[s])) continue;
    const f0 = midiToHz(pitch[s] + (jitter * PITCH_JITTER_CENTS) / 100);
    if (s % CONTROL_BLOCK_SAMPLES === 0 || harmonicCount === 0 || noteOf[s] !== lastNote) {
      lastNote = noteOf[s];
      const formants = notes[lastNote].formants;
      harmonicCount = Math.max(1, Math.floor(HARMONIC_MAX_HZ / f0));
      let power = 0;
      for (let k = 1; k <= harmonicCount; k++) {
        amps[k] = harmonicAmplitude(k, f0, formants);
        power += (amps[k] * amps[k]) / 2;
      }
      const norm = 1 / Math.sqrt(power);
      for (let k = 1; k <= harmonicCount; k++) amps[k] *= norm;
    }
    phase += (2 * Math.PI * f0) / sampleRate;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    const sin1 = Math.sin(phase);
    const twoCos = 2 * Math.cos(phase);
    let sPrev = 0;
    let sCur = sin1;
    let acc = 0;
    for (let k = 1; k <= harmonicCount; k++) {
      acc += amps[k] * sCur;
      const sNext = twoCos * sCur - sPrev;
      sPrev = sCur;
      sCur = sNext;
    }
    out[s] += amp[s] * (1 + SHIMMER_FRACTION * shimmer) * acc;
  }

  // aspiration noise riding on the voice envelope (band 1–6 kHz)
  const asp = whiteNoise(n, rng);
  applyBiquad(asp, biquad('highpass', 1000, 0.707, sampleRate));
  applyBiquad(asp, biquad('lowpass', 6000, 0.707, sampleRate));
  const aspNorm = dbToGain(notes.length ? notes[0].style.aspirationRelDb : ASPIRATION_REL_DB) / rmsOf(asp);
  for (let s = 0; s < n; s++) out[s] += asp[s] * aspNorm * amp[s];

  // breath noise in gaps
  for (let i = 1; i < notes.length; i++) {
    const j = notes[i].join;
    if (j.kind !== 'gap' || j.sec < BREATH_MIN_GAP_SEC) continue;
    addBreath(out, sampleRate, notes[i - 1].end + j.sec * 0.15, j.sec * 0.6, BREATH_IN_GAP_DBFS, rng);
  }

  return notes.map((nt) => ({ t: round4(nt.start), dur: round4(nt.dur), midi: nt.midi }));
}

function dipGain(dt: number, join: { depthDb: number; sec: number }): number {
  const x = dt / join.sec + 0.5; // 0..1 across the dip
  if (x <= 0 || x >= 1) return 1;
  const floor = dbToGain(-join.depthDb);
  return 1 - (1 - floor) * (0.5 - 0.5 * Math.cos(2 * Math.PI * x));
}

/** a soft breath: band noise 300–3000 Hz with a raised-cosine envelope */
function addBreath(out: Float64Array, sampleRate: number, start: number, dur: number, dbfs: number, rng: () => number): void {
  const len = Math.round(dur * sampleRate);
  const s0 = Math.round(start * sampleRate);
  if (len <= 0) return;
  const x = whiteNoise(len, rng);
  applyBiquad(x, biquad('highpass', 300, 0.707, sampleRate));
  applyBiquad(x, biquad('lowpass', 3000, 0.707, sampleRate));
  const g = dbToGain(dbfs) / rmsOf(x);
  for (let i = 0; i < len && s0 + i < out.length; i++) {
    const env = Math.sin((Math.PI * i) / len) ** 2;
    out[s0 + i] += x[i] * g * env * 1.63; // 1.63 ≈ 1/rms(sin²) keeps the burst RMS near dbfs
  }
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

// ---------- drums ----------
interface PlacedHit {
  t: number;
  kind: DrumKindName;
  gainDb: number;
}

function renderDrums(out: Float64Array, sampleRate: number, hits: PlacedHit[], rng: () => number): void {
  for (const h of hits) {
    const s0 = Math.round(h.t * sampleRate);
    const g = dbToGain(h.gainDb);
    if (h.kind === 'kick') addKick(out, s0, sampleRate, g, rng);
    else if (h.kind === 'snare') addSnare(out, s0, sampleRate, g, rng);
    else addHat(out, s0, sampleRate, g, rng);
  }
}

/** sine sweep 120→50 Hz over ~120 ms plus a short click */
function addKick(out: Float64Array, s0: number, sampleRate: number, gain: number, rng: () => number): void {
  const len = Math.round(KICK_LEN_SEC * sampleRate);
  let phase = 0;
  for (let i = 0; i < len && s0 + i < out.length; i++) {
    const t = i / sampleRate;
    const x = Math.min(1, t / KICK_SWEEP_SEC);
    const f = KICK_SWEEP_START_HZ * (KICK_SWEEP_END_HZ / KICK_SWEEP_START_HZ) ** x;
    phase += (2 * Math.PI * f) / sampleRate;
    const env = (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.05);
    const click = t < 0.004 ? (rng() * 2 - 1) * 0.3 * Math.exp(-t / 0.0012) : 0;
    out[s0 + i] += gain * (0.5 * env * Math.sin(phase) + click);
  }
}

/** band noise 1–5 kHz ~120 ms plus a 200 Hz body */
function addSnare(out: Float64Array, s0: number, sampleRate: number, gain: number, rng: () => number): void {
  const len = Math.round(SNARE_LEN_SEC * sampleRate);
  const noise = whiteNoise(len, rng);
  applyBiquad(noise, biquad('highpass', 1000, 0.707, sampleRate));
  applyBiquad(noise, biquad('lowpass', 5000, 0.707, sampleRate));
  const nNorm = 1 / rmsOf(noise);
  for (let i = 0; i < len && s0 + i < out.length; i++) {
    const t = i / sampleRate;
    const attack = 1 - Math.exp(-t / 0.001);
    const fade = raisedCos((SNARE_LEN_SEC - t) / 0.01);
    const body = 0.25 * Math.exp(-t / 0.03) * Math.sin(2 * Math.PI * SNARE_BODY_HZ * t);
    out[s0 + i] += gain * attack * fade * (0.15 * nNorm * noise[i] * Math.exp(-t / 0.04) + body);
  }
}

/** noise above 7 kHz, ~40 ms */
function addHat(out: Float64Array, s0: number, sampleRate: number, gain: number, rng: () => number): void {
  const len = Math.round(HAT_LEN_SEC * sampleRate);
  const noise = whiteNoise(len, rng);
  applyBiquad(noise, biquad('highpass', HAT_HIGHPASS_HZ, 0.707, sampleRate));
  applyBiquad(noise, biquad('highpass', HAT_HIGHPASS_HZ, 0.707, sampleRate));
  const nNorm = 1 / rmsOf(noise);
  for (let i = 0; i < len && s0 + i < out.length; i++) {
    const t = i / sampleRate;
    const attack = 1 - Math.exp(-t / 0.0005);
    const fade = raisedCos((HAT_LEN_SEC - t) / 0.005);
    out[s0 + i] += gain * 0.1 * attack * fade * nNorm * noise[i] * Math.exp(-t / 0.012);
  }
}

// ---------- fixture definitions ----------
interface FixtureDef {
  name: string;
  description: string;
  /** stress fixtures probe robustness beyond the spec; default true */
  gated?: boolean;
  sampleRate?: number;
  build(sampleRate: number, rng: () => number): { audio: Float64Array; notes: FixtureTruth['notes']; hits: FixtureTruth['hits'] };
}

/** a melody with random durations in [durLo, durHi]; each join after the first is a gap (prob pGap) or a slur */
function melody(midis: number[], rng: () => number, durLo: number, durHi: number, pGap: number, gapLo: number, gapHi: number): SungNote[] {
  return midis.map((midi, i): SungNote => ({
    midi,
    dur: uniform(rng, durLo, durHi),
    join: i === 0 || rng() < pGap ? { kind: 'gap', sec: i === 0 ? LEAD_IN_SEC : uniform(rng, gapLo, gapHi) } : { kind: 'slur' },
  }));
}

function sungFixture(sampleRate: number, rng: () => number, line: SungNote[], baseDbfs: number, style = DEFAULT_VOICE, roomDbfs = BACKGROUND_NOISE_DBFS) {
  const placed = placeNotes(line, rng, baseDbfs, style);
  const durationSec = placed[placed.length - 1].end + TAIL_SEC;
  const audio = backgroundNoise(Math.round(durationSec * sampleRate), sampleRate, rng, roomDbfs);
  const notes = renderVoice(audio, sampleRate, placed, rng);
  return { audio, notes, hits: [] };
}

const C_MAJOR_LINE = [60, 62, 64, 65, 67, 69, 67, 64];
const LOW_LINE = [45, 48, 50, 52, 55, 57, 55, 52];
const HIGH_LINE = [69, 71, 73, 76, 78, 81, 76, 73];
const LEGATO_LINE_A = [64, 65, 67, 69, 70, 69, 67, 65, 64];
const LEGATO_LINE_B = [60, 62, 64, 67, 79, 77, 76, 74, 72];
const BEATBOX_BAR: DrumKindName[] = ['kick', 'hat', 'snare', 'hat'];
/** 16ths at 100 bpm (150 ms apart), the densest pattern we expect */
const BEATBOX_FAST_BAR: DrumKindName[] = ['kick', 'hat', 'hat', 'kick', 'snare', 'hat', 'kick', 'hat'];
const FAST_LINE = [64, 66, 67, 69, 71, 69, 67, 66, 64, 62, 64, 67];

function beatboxHits(rng: () => number, bars: number, jitterSec: number, baseDb: number, levelVarDb: number, pattern = BEATBOX_BAR, stepSec = 60 / BPM_BEATBOX / 2): PlacedHit[] {
  const hits: PlacedHit[] = [];
  for (let b = 0; b < bars; b++) {
    for (let i = 0; i < pattern.length; i++) {
      const idx = b * pattern.length + i;
      hits.push({
        t: LEAD_IN_SEC + idx * stepSec + uniform(rng, -jitterSec, jitterSec),
        kind: pattern[i],
        gainDb: baseDb + uniform(rng, -levelVarDb, levelVarDb),
      });
    }
  }
  return hits;
}

function beatboxFixture(sampleRate: number, rng: () => number, hits: PlacedHit[], phone: boolean, roomDbfs = BACKGROUND_NOISE_DBFS) {
  const durationSec = hits[hits.length - 1].t + TAIL_SEC;
  const audio = backgroundNoise(Math.round(durationSec * sampleRate), sampleRate, rng, roomDbfs);
  renderDrums(audio, sampleRate, hits, rng);
  if (phone) {
    applyBiquad(audio, biquad('highpass', PHONE_HIGHPASS_HZ, 0.707, sampleRate));
    applyBiquad(audio, biquad('lowpass', PHONE_LOWPASS_HZ, 0.707, sampleRate));
  }
  const truth = hits.map((h) => ({ t: round4(Math.round(h.t * sampleRate) / sampleRate), kind: h.kind }));
  return { audio, notes: [], hits: truth };
}

export const FIXTURES: FixtureDef[] = [
  {
    name: 'sing-cmaj',
    description: 'C4 D4 E4 F4 G4 A4 G4 E4 twice; 0.25–0.8 s notes, about half joined by 100–200 ms gaps, the rest slurred',
    build: (sr, rng) => sungFixture(sr, rng, [...melody(C_MAJOR_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), ...melody(C_MAJOR_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2)], -16),
  },
  {
    name: 'sing-cmaj-44k',
    description: 'the sing-cmaj line at 44.1 kHz (checks the 441-sample hop path)',
    sampleRate: 44100,
    build: (sr, rng) => sungFixture(sr, rng, melody(C_MAJOR_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), -18),
  },
  {
    name: 'sing-low',
    description: 'A2–A3 male register: A2 C3 D3 E3 G3 A3 G3 E3 twice, mixed gaps and slurs',
    build: (sr, rng) => sungFixture(sr, rng, [...melody(LOW_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), ...melody(LOW_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2)], -16),
  },
  {
    name: 'sing-high',
    description: 'A4–A5: A4 B4 C#5 E5 F#5 A5 E5 C#5 twice, mixed gaps and slurs',
    build: (sr, rng) => sungFixture(sr, rng, [...melody(HIGH_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), ...melody(HIGH_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2)], -14),
  },
  {
    name: 'sing-legato',
    description: 'two fully slurred phrases (40 ms glides, semitone steps, one octave leap G4→G5), 0.2–0.5 s notes, one breath between',
    build: (sr, rng) => {
      const a = melody(LEGATO_LINE_A, rng, 0.2, 0.5, 0, 0, 0);
      const b = melody(LEGATO_LINE_B, rng, 0.2, 0.5, 0, 0, 0);
      b[0] = { ...b[0], join: { kind: 'gap', sec: 0.3 } };
      return sungFixture(sr, rng, [...a, ...b], -16);
    },
  },
  {
    name: 'sing-repeated',
    description: 'repeated notes: D4 ×5 split by 10–18 dB amplitude dips (40–60 ms), A3 ×4 split by 30–40 ms silences, G4 ×3 by dips',
    build: (sr, rng) => {
      const line: SungNote[] = [];
      const dip = (): Join => ({ kind: 'dip', depthDb: uniform(rng, 10, 18), sec: uniform(rng, 0.04, 0.06) });
      for (let i = 0; i < 5; i++) line.push({ midi: 62, dur: uniform(rng, 0.25, 0.4), join: i === 0 ? { kind: 'gap', sec: LEAD_IN_SEC } : dip() });
      for (let i = 0; i < 4; i++) line.push({ midi: 57, dur: uniform(rng, 0.25, 0.4), join: { kind: 'gap', sec: i === 0 ? 0.3 : uniform(rng, 0.03, 0.04) } });
      for (let i = 0; i < 3; i++) line.push({ midi: 67, dur: uniform(rng, 0.25, 0.4), join: i === 0 ? { kind: 'gap', sec: 0.3 } : dip() });
      return sungFixture(sr, rng, line, -16);
    },
  },
  {
    name: 'silence-noise',
    description: 'room noise at -45 dBFS, soft breaths at -36 dBFS, 50 Hz hum at -55 dBFS: must yield no notes and no hits',
    build: (sr, rng) => {
      const durationSec = 6;
      const audio = backgroundNoise(Math.round(durationSec * sr), sr, rng);
      for (const start of [0.8, 2.1, 3.4, 4.6]) addBreath(audio, sr, start, uniform(rng, 0.3, 0.6), -36, rng);
      const hum = dbToGain(-55) * Math.SQRT2;
      for (let i = 0; i < audio.length; i++) audio[i] += hum * Math.sin((2 * Math.PI * 50 * i) / sr);
      return { audio, notes: [], hits: [] };
    },
  },
  {
    name: 'beatbox-basic',
    description: 'kick hat snare hat ×4 at 100 bpm eighths (0.3 s apart), clean full-range mic',
    build: (sr, rng) => beatboxFixture(sr, rng, beatboxHits(rng, 4, 0, 0, 0), false),
  },
  {
    name: 'beatbox-phone',
    description: 'beatbox-basic through a phone-like mic (high-pass 120 Hz, low-pass 8 kHz), ±6 dB level and ±12 ms timing variation',
    build: (sr, rng) => beatboxFixture(sr, rng, beatboxHits(rng, 4, PHONE_TIMING_JITTER_SEC, PHONE_BASE_GAIN_DB, PHONE_LEVEL_VARIATION_DB), true),
  },
  // ----- stress fixtures (not gated): harder than the spec, to see where the settings break -----
  {
    name: 'stress-sing-quiet',
    gated: false,
    description: 'the C major line sung quietly: notes at -34 dBFS over -45 dBFS room noise (11 dB SNR)',
    build: (sr, rng) => sungFixture(sr, rng, melody(C_MAJOR_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), -34),
  },
  {
    name: 'stress-sing-vibrato',
    gated: false,
    description: 'wide vibrato (±60 cents, 6 Hz, from 120 ms) and 80-cent scoops into every note after a gap',
    build: (sr, rng) =>
      sungFixture(sr, rng, [...melody(C_MAJOR_LINE, rng, 0.3, 0.8, 0.5, 0.1, 0.2), ...melody(HIGH_LINE, rng, 0.3, 0.8, 0.5, 0.1, 0.2)], -16, {
        ...DEFAULT_VOICE,
        vibratoCents: 60,
        vibratoHz: 6,
        vibratoDelaySec: 0.12,
        scoopCents: 80,
        scoopSec: 0.08,
      }),
  },
  {
    name: 'stress-sing-vowels',
    gated: false,
    description: 'the low line with vowels cycling ah / oo / ee and a 15 ms attack',
    build: (sr, rng) =>
      sungFixture(sr, rng, melody(LOW_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), -16, {
        ...DEFAULT_VOICE,
        attackSec: 0.015,
        vowels: [FORMANTS_AH, FORMANTS_OO, FORMANTS_EE],
      }),
  },
  {
    name: 'stress-sing-fast',
    gated: false,
    description: 'a fast run: 0.10–0.20 s notes, mostly slurred, some 60–100 ms gaps',
    build: (sr, rng) => sungFixture(sr, rng, melody(FAST_LINE, rng, 0.1, 0.2, 0.3, 0.06, 0.1), -16),
  },
  {
    name: 'stress-sing-noisy',
    gated: false,
    description: 'the C major line in a loud room: -32 dBFS room noise, breathier voice (aspiration -16 dB)',
    build: (sr, rng) =>
      sungFixture(sr, rng, melody(C_MAJOR_LINE, rng, 0.25, 0.8, 0.5, 0.1, 0.2), -18, { ...DEFAULT_VOICE, aspirationRelDb: -16 }, -32),
  },
  {
    name: 'stress-beatbox-fast',
    gated: false,
    description: 'kick hat hat kick snare hat kick hat ×3 in 16ths at 100 bpm (150 ms apart), phone mic, ±6 dB',
    build: (sr, rng) =>
      beatboxFixture(sr, rng, beatboxHits(rng, 3, PHONE_TIMING_JITTER_SEC / 2, PHONE_BASE_GAIN_DB, PHONE_LEVEL_VARIATION_DB, BEATBOX_FAST_BAR, 60 / BPM_BEATBOX / 4), true),
  },
  {
    name: 'stress-beatbox-44k',
    gated: false,
    description: 'beatbox-phone at 44.1 kHz (checks the 5.8 ms hop and the bin layout at 44.1 kHz)',
    sampleRate: 44100,
    build: (sr, rng) => beatboxFixture(sr, rng, beatboxHits(rng, 4, PHONE_TIMING_JITTER_SEC, PHONE_BASE_GAIN_DB, PHONE_LEVEL_VARIATION_DB), true),
  },
  {
    name: 'stress-sing-wide-vibrato',
    gated: false,
    description: 'operatic vibrato: ±100 cents at 5.5 Hz from 150 ms, otherwise the C major line',
    build: (sr, rng) => sungFixture(sr, rng, melody(C_MAJOR_LINE, rng, 0.4, 0.9, 0.5, 0.1, 0.2), -16, { ...DEFAULT_VOICE, vibratoCents: 100 }),
  },
  {
    name: 'stress-beatbox-noisy',
    gated: false,
    description: 'beatbox-phone in a loud room (-32 dBFS room noise)',
    build: (sr, rng) => beatboxFixture(sr, rng, beatboxHits(rng, 4, PHONE_TIMING_JITTER_SEC, PHONE_BASE_GAIN_DB, PHONE_LEVEL_VARIATION_DB), true, -32),
  },
];

/** Render every fixture (or the named ones) into outDir. Returns the written WAV paths. */
export function makeFixtures(outDir = FIXTURE_OUT_DIR, names?: string[]): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  FIXTURES.forEach((def, index) => {
    if (names && !names.includes(def.name)) return;
    const sampleRate = def.sampleRate ?? FIXTURE_SAMPLE_RATE_HZ;
    const rng = createRng(0x51a9 + index * 7919);
    const { audio, notes, hits } = def.build(sampleRate, rng);
    const wavPath = join(outDir, `${def.name}.wav`);
    writeWav(wavPath, Float32Array.from(audio), sampleRate, 'pcm16');
    const truth: FixtureTruth = {
      name: def.name,
      description: def.description,
      gated: def.gated ?? true,
      sampleRate,
      durationSec: round4(audio.length / sampleRate),
      notes,
      hits,
    };
    writeFileSync(join(outDir, `${def.name}.json`), JSON.stringify(truth, null, 1) + '\n');
    written.push(wavPath);
  });
  return written;
}

if (import.meta.main) {
  const outDir = process.argv[2] ?? FIXTURE_OUT_DIR;
  const t0 = performance.now();
  const files = makeFixtures(outDir);
  console.log(`wrote ${files.length} fixtures to ${outDir} in ${Math.round(performance.now() - t0)} ms`);
}
