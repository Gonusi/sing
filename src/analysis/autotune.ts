// [dsp] Hz/MIDI conversion, semitone snap, and the per-take register fit (octave shift). Pure.
import type { InstrumentKind } from '../types.ts';

// ---------- constants ----------
/** inclusive MIDI range each instrument sounds best in; the take's median note is moved into it by octaves */
export const VIOLIN_SWEET_RANGE = { lo: 69, hi: 76 } as const; // A4–E5
export const BASS_SWEET_RANGE = { lo: 45, hi: 52 } as const; // A2–E3: low enough to be bass, high enough for phone speakers
/** null = no register fit (synth plays as sung, drums have no pitch) */
export const SWEET_RANGES: Record<InstrumentKind, { lo: number; hi: number } | null> = {
  violin: VIOLIN_SWEET_RANGE,
  bass: BASS_SWEET_RANGE,
  synth: null,
  drums: null,
  vocals: null,
};
const MAX_OCTAVE_SHIFT = 6;

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** nearest semitone */
export function snapMidi(midi: number): number {
  return Math.round(midi);
}

/** distance (semitones) from `midi` to the inclusive range; 0 inside */
export function distanceToRange(midi: number, range: { lo: number; hi: number }): number {
  return midi < range.lo ? range.lo - midi : midi > range.hi ? midi - range.hi : 0;
}

/**
 * Octave shift in semitones (multiple of 12) that moves the take's median note closest into the instrument's
 * sweet range (violin A4–E5, bass E2–A2; synth and drums: 0). Ties go to the smaller shift. Empty take → 0.
 */
export function registerShift(midis: number[], kind: InstrumentKind): number {
  const range = SWEET_RANGES[kind];
  if (!range || midis.length === 0) return 0;
  const sorted = midis.slice().sort((a, b) => a - b);
  const m = sorted.length >> 1;
  const median = sorted.length & 1 ? sorted[m] : 0.5 * (sorted[m - 1] + sorted[m]);
  let best = 0;
  let bestDist = distanceToRange(median, range);
  for (let k = 1; k <= MAX_OCTAVE_SHIFT; k++) {
    for (const shift of [-12 * k, 12 * k]) {
      const d = distanceToRange(median + shift, range);
      if (d < bestDist - 1e-9) {
        best = shift;
        bestDist = d;
      }
    }
  }
  return best;
}

// ---------- key snap (proposal, not wired: the coordinator decides) ----------
/** semitone steps of the major scale from its tonic; natural minor is the same set from the 6th degree */
export const MAJOR_SCALE_STEPS = [0, 2, 4, 5, 7, 9, 11] as const;
const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface MusicalKey {
  /** pitch class 0..11 of the major tonic (the relative minor tonic is tonic + 9) */
  tonic: number;
  /** which of the two readings the durations favour (tonic + fifth weight); snapping is the same for both */
  mode: 'major' | 'minor';
  /** e.g. "G# major" */
  name: string;
  /** duration-weighted mean squared distance (st²) of the notes to the scale; lower = better fit */
  cost: number;
  /** the singer's tuning: semitones (−0.5..0.5) subtracted before snapping (a take sung a third of a semitone flat) */
  offset: number;
}

/**
 * The take's tuning offset: duration-weighted circular mean of the notes' distance to the nearest semitone, in
 * −0.5..0.5. Someone singing in tune with themselves but 40 cents off the piano sits near the same fraction on every
 * note; removing it stops one sung degree from snapping to two semitones.
 */
export function estimateTuningOffset(notes: { midi: number; dur: number }[]): number {
  let x = 0;
  let y = 0;
  for (const n of notes) {
    const a = 2 * Math.PI * (n.midi - Math.round(n.midi));
    x += Math.cos(a) * n.dur;
    y += Math.sin(a) * n.dur;
  }
  return x === 0 && y === 0 ? 0 : Math.atan2(y, x) / (2 * Math.PI);
}

/** pitch classes of the major scale on `tonic` */
export function scalePitchClasses(tonic: number): number[] {
  return MAJOR_SCALE_STEPS.map((s) => (((tonic + s) % 12) + 12) % 12);
}

/** distance in semitones from fractional `midi` to the nearest tone of the major scale on `tonic`, and that tone */
export function nearestScaleTone(midi: number, tonic: number): { tone: number; dist: number } {
  const pcs = scalePitchClasses(tonic);
  const base = Math.floor(midi);
  let best = Math.round(midi);
  let dist = Infinity;
  for (let m = base - 2; m <= base + 3; m++) {
    if (!pcs.includes(((m % 12) + 12) % 12)) continue;
    const d = Math.abs(midi - m);
    if (d < dist - 1e-9) {
      dist = d;
      best = m;
    }
  }
  return { tone: best, dist };
}

/**
 * The take's tuning offset, then the major/minor key whose scale the offset-corrected pitches sit closest to
 * (duration-weighted squared distance). Null with fewer than 3 notes. Pure; the proposal in notes/dsp.md.
 */
export function estimateKey(input: { midi: number; dur: number }[]): MusicalKey | null {
  if (input.length < 3) return null;
  const offset = estimateTuningOffset(input);
  const notes = input.map((n) => ({ midi: n.midi - offset, dur: n.dur }));
  const total = notes.reduce((a, n) => a + n.dur, 0) || 1;
  let bestTonic = 0;
  let bestCost = Infinity;
  for (let tonic = 0; tonic < 12; tonic++) {
    let cost = 0;
    for (const n of notes) cost += n.dur * nearestScaleTone(n.midi, tonic).dist ** 2;
    cost /= total;
    if (cost < bestCost - 1e-12) {
      bestCost = cost;
      bestTonic = tonic;
    }
  }
  // major vs relative minor: duration on each reading's tonic and fifth
  const weight = (pc: number) => notes.reduce((a, n) => a + (((nearestScaleTone(n.midi, bestTonic).tone % 12) + 12) % 12 === pc ? n.dur : 0), 0);
  const majorW = weight(bestTonic) + weight((bestTonic + 7) % 12);
  const minorTonic = (bestTonic + 9) % 12;
  const minorW = weight(minorTonic) + weight((minorTonic + 7) % 12);
  const mode = minorW > majorW ? 'minor' : 'major';
  const name = `${PITCH_CLASS_NAMES[mode === 'major' ? bestTonic : minorTonic]} ${mode}`;
  return { tonic: bestTonic, mode, name, cost: bestCost, offset };
}

/** nearest tone of the key's scale after removing the take's tuning offset */
export function snapToKey(midi: number, key: MusicalKey): number {
  return nearestScaleTone(midi - key.offset, key.tonic).tone;
}
