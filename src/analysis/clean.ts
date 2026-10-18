// [dsp] Note smoothing for a finished take: absorbs scoops/tails into neighbouring notes, merges wobble across a
// semitone boundary (hysteresis), and drops what is left too short. Pure. Input and output are in loop positions with
// fractional midi; snapping, register fit and phrases happen after this (engine).
//
// Design rule (owner): users are super-amateurs humming roughly in tune → fewer, longer, steadier notes.
// One knob `smoothing` s ∈ [0, 1] scales every threshold (0 ≈ as detected):
//   STABLE_SEC    60 → 240 ms   a note shorter than this is a transition candidate (scoop / tail)
//   MERGE_ST      1 → 4 st      how far in pitch a short note may be from the neighbour it joins
//   HYST_ST       0.3 → 1.2 st  joined neighbours closer than this become one note ...
//   HYST_MAX_SEC  80 → 280 ms   ... when the shorter of the two is shorter than this (a drift split inside one
//                               syllable); two held notes (a semitone step sung 40 cents narrow) stay apart,
//                               unless they are closer than HYST_ANY_LENGTH_ST (one pitch split by a wobble)
//   JOIN_GAP_SEC  20 → 70 ms    "joined" = the next note starts within this after the previous one ends
//   MIN_SEC       80 → 140 ms   what is still shorter at the end is dropped
// Boundaries: a note with `attack` (a new articulation: after silence or an energy dip, see segment.ts SegmentedNote)
// is never merged into the note before it, so repeated syllables on one pitch stay separate. Without the flag (older
// raw data) a joined pair that rounds to the same semitone counts as an attack: the live segmenter splits a continuous
// voice only on a pitch change that rounds differently, so a same-semitone split was an energy dip.
// Steps, in order:
//   1. absorb short notes, shortest first: a scoop (short note running into the next) keeps its onset and takes the
//      next note's pitch; a tail (short note continuing the previous one) extends the previous note. A transition
//      joined on both sides goes to the next note (the voice glides toward it: a late-reach scoop often dips below or
//      stays near the previous pitch, so pitch distance does not tell); to the previous one only when the next is out
//      of MERGE_ST reach or starts a new articulation.
//   2. hysteresis: joined non-attack neighbours closer than HYST_ST, one of them shorter than HYST_MAX_SEC, become one
//      note (duration-weighted pitch).
//   3. drop notes still shorter than MIN_SEC.
import type { RawLoopNote, Sec } from '../types.ts';

/** default slider position (tuned on the owner's first real take, notes/dsp.md) */
export const DEFAULT_SMOOTHING = 0.55;

// ---------- constants: [value at smoothing 0, value at smoothing 1] ----------
export const STABLE_SEC: readonly [number, number] = [0.06, 0.24];
export const MERGE_ST: readonly [number, number] = [1, 4];
export const HYST_ST: readonly [number, number] = [0.3, 1.2];
export const HYST_MAX_SEC: readonly [number, number] = [0.08, 0.28];
/** joined glide neighbours this close are one note whatever their length */
export const HYST_ANY_LENGTH_ST = 0.35;
export const JOIN_GAP_SEC: readonly [number, number] = [0.02, 0.07];
export const MIN_SEC: readonly [number, number] = [0.08, 0.14];

export interface CleanParams {
  stableSec: number;
  mergeSt: number;
  hystSt: number;
  hystMaxSec: number;
  joinGapSec: number;
  minSec: number;
}

/** RawLoopNote with the optional segmenter flag (proposed contract field) */
type InNote = RawLoopNote & { attack?: boolean };

interface Work {
  pos: Sec;
  dur: Sec;
  midi: number;
  vel: number;
  /** starts a new articulation: never merged into the note before it */
  attack: boolean;
}

const lerp = (r: readonly [number, number], s: number) => r[0] + (r[1] - r[0]) * s;

export function cleanParams(smoothing: number): CleanParams {
  const s = Math.min(1, Math.max(0, Number.isFinite(smoothing) ? smoothing : DEFAULT_SMOOTHING));
  return {
    stableSec: lerp(STABLE_SEC, s),
    mergeSt: lerp(MERGE_ST, s),
    hystSt: lerp(HYST_ST, s),
    hystMaxSec: lerp(HYST_MAX_SEC, s),
    joinGapSec: lerp(JOIN_GAP_SEC, s),
    minSec: lerp(MIN_SEC, s),
  };
}

/** smoothing 0 = as detected, 1 = strongest; returns notes sorted by pos */
export function cleanNotes(raw: RawLoopNote[], smoothing: number, loopLength: Sec): RawLoopNote[] {
  const p = cleanParams(smoothing);
  const notes = toWork(raw, p);
  absorbShortNotes(notes, p);
  mergeHysteresis(notes, p);
  return notes
    .filter((n) => n.dur >= p.minSec - 1e-9)
    .map((n) => ({
      pos: n.pos,
      dur: loopLength > 0 ? Math.min(n.dur, Math.max(0, loopLength - n.pos)) : n.dur,
      midi: n.midi,
      vel: n.vel,
    }));
}

function toWork(raw: RawLoopNote[], p: CleanParams): Work[] {
  const sorted = [...raw].sort((a, b) => a.pos - b.pos) as InNote[];
  return sorted.map((n, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    const joined = prev !== null && isJoined(prev, n, p);
    let attack = typeof n.attack === 'boolean' ? n.attack : !joined || Math.round(prev.midi) === Math.round(n.midi);
    if (!joined) attack = true; // a gap is always an articulation
    return { pos: n.pos, dur: n.dur, midi: n.midi, vel: n.vel, attack };
  });
}

/** `b` starts within the join gap after `a` ends */
function isJoined(a: { pos: Sec; dur: Sec }, b: { pos: Sec }, p: CleanParams): boolean {
  return b.pos - (a.pos + a.dur) <= p.joinGapSec;
}

/** step 1: scoops and tails (in place) */
function absorbShortNotes(notes: Work[], p: CleanParams): void {
  const stuck = new Set<Work>();
  for (;;) {
    let idx = -1;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.dur < p.stableSec && !stuck.has(n) && (idx < 0 || n.dur < notes[idx].dur)) idx = i;
    }
    if (idx < 0) return;
    const n = notes[idx];
    const prev = idx > 0 ? notes[idx - 1] : null;
    const next = idx + 1 < notes.length ? notes[idx + 1] : null;
    // scoop: n runs into next (next is not a new articulation)
    const toNext = next && !next.attack && isJoined(n, next, p) ? Math.abs(n.midi - next.midi) : Infinity;
    // tail: n continues prev
    const toPrev = prev && !n.attack && isJoined(prev, n, p) ? Math.abs(n.midi - prev.midi) : Infinity;
    const okNext = toNext <= p.mergeSt;
    const okPrev = toPrev <= p.mergeSt;
    if (!okNext && !okPrev) {
      stuck.add(n);
      continue;
    }
    if (next && okNext) {
      // the scoop's onset and articulation, the target's pitch
      next.dur = next.pos + next.dur - n.pos;
      next.pos = n.pos;
      next.attack = n.attack;
      next.vel = Math.max(next.vel, n.vel);
    } else if (prev) {
      prev.dur = Math.max(prev.dur, n.pos + n.dur - prev.pos);
    }
    notes.splice(idx, 1);
  }
}

/** step 2: joined, non-attack neighbours closer than the hysteresis become one note (in place), closest pair first */
function mergeHysteresis(notes: Work[], p: CleanParams): void {
  for (;;) {
    let best = -1;
    let bestDiff = Infinity;
    for (let i = 1; i < notes.length; i++) {
      const a = notes[i - 1];
      const b = notes[i];
      if (b.attack || !isJoined(a, b, p)) continue;
      const d = Math.abs(a.midi - b.midi);
      if (d >= HYST_ANY_LENGTH_ST && Math.min(a.dur, b.dur) >= p.hystMaxSec) continue;
      if (d < p.hystSt && d < bestDiff) {
        best = i;
        bestDiff = d;
      }
    }
    if (best < 0) return;
    const a = notes[best - 1];
    const b = notes[best];
    a.midi = (a.midi * a.dur + b.midi * b.dur) / (a.dur + b.dur);
    a.dur = b.pos + b.dur - a.pos;
    a.vel = Math.max(a.vel, b.vel);
    notes.splice(best, 1);
  }
}
