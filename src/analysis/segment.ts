// [dsp] PitchFrame stream (10 ms) → RawNote stream, live. Pure: no DOM, no Node globals, no Web Audio.
//
// Pipeline per frame (frame i is processed once frame i+2 has arrived: MEDIAN_FRAMES = 5, centred):
//   1. smooth   — median of the voiced fractional-MIDI values in frames i-2..i+2 (unvoiced centre stays unvoiced)
//   2. dips     — frame RMS falling DIP_DROP_DB below the note's peak and recovering DIP_RECOVER_DB above the dip
//                 minimum = a repeated note: split at the dip minimum, and never merge across it
//   3. pitch    — a value more than DEPART_SEMITONES from the running note median (same side, CONFIRM_FRAMES voiced
//                 frames in a row) is a change candidate; confirmed only if it rounds to a different semitone than the
//                 note; the new note starts where the pitch crosses halfway between the two (the glide centre,
//                 interpolated between frames). Shorter runs are folded back
//                 into the note (an octave error is moved by ±12 first): this is the octave fold.
//   4. gaps     — UNVOICED_SPLIT_FRAMES unvoiced frames end a note (it becomes "held"); a single unvoiced frame is
//                 bridged. A held note is merged with the next one when the gap < MERGE_GAP_SEC, both round to the
//                 same semitone and no dip happened in between; otherwise it is finalised. A pitch change across
//                 a gap < LEGATO_DROPOUT_MAX_SEC without a dip is a legato dropout (pitchy loses the pitch in a fast
//                 glide): the new note starts in the middle of the gap.
//   5. length   — notes shorter than MIN_NOTE_SEC are dropped; a short note that runs straight into the next one
//                 (pitch or dip boundary) is absorbed into it instead (its onset moves back), e.g. a scoop.
//   6. onset    — after a gap the onset is refined from frame RMS: where it crosses floor + ONSET_RMS_FRACTION of the
//                 way to the note level, searched from ONSET_LOOKBACK_FRAMES before to ONSET_LOOKAHEAD_FRAMES after
//                 the first voiced frame (the 43 ms pitch window makes the first voiced frame early for high notes
//                 and late for low ones).
// A note is emitted from push() as soon as nothing can change it any more (see notes/dsp.md for the delays).
// Times: the same clock as PitchFrame.t (mic-stamp context time). RawNote.midi is the fractional median (unsnapped).
import type { NoteSegmenter, PitchFrame, RawNote, Sec } from '../types.ts';
import { hzToMidi } from './autotune.ts';

// ---------- constants ----------
export const SEG_HOP_SEC = 0.01;
export const MEDIAN_FRAMES = 5;
const MEDIAN_HALF = (MEDIAN_FRAMES - 1) >> 1;
export const DEPART_SEMITONES = 0.5;
export const CONFIRM_FRAMES = 4;
export const OCTAVE_FOLD_TOLERANCE_SEMITONES = 1.0;
export const UNVOICED_SPLIT_FRAMES = 2;
export const MIN_NOTE_SEC = 0.08;
export const MERGE_GAP_SEC = 0.05;
/** a pitch change across an unvoiced gap shorter than this with no energy dip is legato (a pitch-tracking dropout) */
export const LEGATO_DROPOUT_MAX_SEC = 0.12;
/** voiced frames a note needs after a short gap before it is compared with the held note */
export const MERGE_DECIDE_FRAMES = 3;
export const DIP_DROP_DB = 6;
export const DIP_RECOVER_DB = 4;
/** a dip that has not recovered within this long is a level change, not an articulation */
export const DIP_MAX_SEC = 0.3;
export const ONSET_LOOKBACK_FRAMES = 5;
export const ONSET_LOOKAHEAD_FRAMES = 4;
export const ONSET_RMS_FRACTION = 0.15;
/** the energy refinement only runs when the note level is this far above the floor before it (a real attack) */
export const ONSET_MIN_RISE_DB = 6;
export const VEL_FLOOR_DBFS = -50;
export const VEL_CEIL_DBFS = -10;
/** a jump in frame time larger than this is a stream discontinuity: everything open is closed */
export const MAX_FRAME_GAP_SEC = 0.05;

const DIP_DROP_RATIO = 10 ** (-DIP_DROP_DB / 20);
const DIP_RECOVER_RATIO = 10 ** (DIP_RECOVER_DB / 20);
const ONSET_MIN_RISE_RATIO = 10 ** (ONSET_MIN_RISE_DB / 20);
/** raw frames kept for smoothing and onset refinement (power of two) */
const RAW_RING = 64;

// ---------- small helpers ----------
/** growable Float64Array */
interface Grow {
  data: Float64Array;
  length: number;
}

function grow(capacity = 128): Grow {
  return { data: new Float64Array(capacity), length: 0 };
}

function growPush(g: Grow, x: number): void {
  if (g.length === g.data.length) {
    const next = new Float64Array(g.data.length * 2);
    next.set(g.data);
    g.data = next;
  }
  g.data[g.length++] = x;
}

/** sorted multiset of numbers, for a running median */
function sortedInsert(g: Grow, x: number): void {
  growPush(g, x);
  let i = g.length - 1;
  const d = g.data;
  while (i > 0 && d[i - 1] > x) {
    d[i] = d[i - 1];
    i--;
  }
  d[i] = x;
}

function sortedMedian(g: Grow): number {
  const n = g.length;
  if (n === 0) return NaN;
  const m = n >> 1;
  return n & 1 ? g.data[m] : 0.5 * (g.data[m - 1] + g.data[m]);
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length & 1 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** move an octave error (±12 or ±24 semitones from ref, within tolerance) back next to ref */
export function foldOctave(midi: number, ref: number): number {
  for (const k of [12, -12, 24, -24]) {
    if (Math.abs(midi - ref - k) < OCTAVE_FOLD_TOLERANCE_SEMITONES) return midi - k;
  }
  return midi;
}

/** loudness 0..1 from an RMS level: VEL_FLOOR_DBFS → 0, VEL_CEIL_DBFS → 1 */
export function velocityFromRms(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-9));
  return Math.min(1, Math.max(0, (db - VEL_FLOOR_DBFS) / (VEL_CEIL_DBFS - VEL_FLOOR_DBFS)));
}

// ---------- note accumulator ----------
type NoteStart = 'gap' | 'pitch' | 'dip';

interface NoteAcc {
  onset: Sec;
  start: NoteStart;
  /** raw index of the first voiced frame, for the energy-onset refinement; -1 when not needed */
  refineIdx: number;
  /** lower bound for the refined onset (end of the previous note, or stream start) */
  onsetFloorT: Sec;
  /** raw index of the previous note's last voiced frame: the onset search stays after it */
  refineFloorIdx: number;
  /** per frame in the note: time, smoothed midi (NaN = bridged unvoiced), accepted value (NaN = not in median), rms */
  t: Grow;
  midi: Grow;
  accepted: Grow;
  rms: Grow;
  /** accepted values, sorted */
  sorted: Grow;
  lastVoicedT: Sec;
}

function newNote(onset: Sec, start: NoteStart): NoteAcc {
  return {
    onset,
    start,
    refineIdx: -1,
    onsetFloorT: -Infinity,
    refineFloorIdx: -1,
    t: grow(),
    midi: grow(),
    accepted: grow(),
    rms: grow(),
    sorted: grow(),
    lastVoicedT: onset,
  };
}

function noteAppend(n: NoteAcc, t: Sec, midi: number, accepted: number, rms: number): void {
  growPush(n.t, t);
  growPush(n.midi, midi);
  growPush(n.accepted, accepted);
  growPush(n.rms, rms);
  if (!Number.isNaN(accepted)) sortedInsert(n.sorted, accepted);
  if (!Number.isNaN(midi)) n.lastVoicedT = t;
}

function noteSetAccepted(n: NoteAcc, i: number, value: number): void {
  n.accepted.data[i] = value;
  sortedInsert(n.sorted, value);
}

/** drop frames from index `from` on; rebuilds the sorted values and the last voiced time */
function noteTruncate(n: NoteAcc, from: number): void {
  n.t.length = n.midi.length = n.accepted.length = n.rms.length = from;
  n.sorted.length = 0;
  n.lastVoicedT = n.onset;
  for (let i = 0; i < from; i++) {
    const a = n.accepted.data[i];
    if (!Number.isNaN(a)) sortedInsert(n.sorted, a);
    if (!Number.isNaN(n.midi.data[i])) n.lastVoicedT = n.t.data[i];
  }
}

/** move frames [from, end) of `src` into `dst` (appended), then truncate `src` */
function noteMoveTail(src: NoteAcc, from: number, dst: NoteAcc): void {
  for (let i = from; i < src.t.length; i++) {
    const midi = src.midi.data[i];
    let acc = src.accepted.data[i];
    if (Number.isNaN(acc) && !Number.isNaN(midi)) acc = midi;
    noteAppend(dst, src.t.data[i], midi, acc, src.rms.data[i]);
  }
  noteTruncate(src, from);
}

function noteMedian(n: NoteAcc): number {
  return sortedMedian(n.sorted);
}

function noteRms(n: NoteAcc, untilT: Sec): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n.t.length; i++) {
    if (n.t.data[i] >= untilT) break;
    if (Number.isNaN(n.midi.data[i])) continue;
    sum += n.rms.data[i] * n.rms.data[i];
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

// ---------- segmenter ----------
export function createSegmenter(): NoteSegmenter {
  // raw frame ring (absolute index i → slot i & (RAW_RING-1))
  const rawT = new Float64Array(RAW_RING);
  const rawMidi = new Float64Array(RAW_RING);
  const rawRms = new Float64Array(RAW_RING);
  let rawCount = 0;
  let processedCount = 0;
  let hopSec = SEG_HOP_SEC;
  let ignoreBeforeT = -Infinity;
  const medianScratch: number[] = [];

  let cur: NoteAcc | null = null;
  let held: NoteAcc | null = null;
  let heldEnd = 0;
  /** raw index of the most recent voiced frame processed */
  let lastVoicedIdx = -1;
  let pendingMerge = false;
  let unvoicedRun = 0;
  // change candidate inside cur
  let candStart = -1;
  let candCount = 0;
  let candSign = 0;
  // dip tracker
  let dipActive = false;
  let dipPeak = 0;
  let dipOpen = false;
  let dipMin = 0;
  let dipMinT = 0;
  let dipStartT = 0;
  let dipSinceHeld = false;
  // the last note that ended in a gap (for legato dropouts)
  let lastEnd = -Infinity;
  let lastMidi = NaN;
  let pendingDropout = false;

  let out: RawNote[] = [];

  const slot = (i: number) => i & (RAW_RING - 1);

  function resetState(): void {
    rawCount = 0;
    processedCount = 0;
    cur = null;
    held = null;
    lastVoicedIdx = -1;
    pendingMerge = false;
    unvoicedRun = 0;
    candStart = -1;
    candCount = 0;
    candSign = 0;
    dipActive = false;
    dipOpen = false;
    dipSinceHeld = false;
    lastEnd = -Infinity;
    lastMidi = NaN;
    pendingDropout = false;
  }

  function smoothedMidi(i: number): number {
    if (Number.isNaN(rawMidi[slot(i)])) return NaN;
    medianScratch.length = 0;
    const lo = Math.max(0, i - MEDIAN_HALF, rawCount - RAW_RING);
    const hi = Math.min(rawCount - 1, i + MEDIAN_HALF);
    for (let j = lo; j <= hi; j++) {
      const v = rawMidi[slot(j)];
      if (!Number.isNaN(v)) medianScratch.push(v);
    }
    medianScratch.sort((a, b) => a - b);
    const n = medianScratch.length;
    const m = n >> 1;
    return n & 1 ? medianScratch[m] : 0.5 * (medianScratch[m - 1] + medianScratch[m]);
  }

  // ----- emission -----
  function noteEnd(n: NoteAcc): Sec {
    return n.lastVoicedT + hopSec / 2;
  }

  function emit(n: NoteAcc, end: Sec): void {
    refineOnset(n);
    const dur = end - n.onset;
    if (dur < MIN_NOTE_SEC || n.sorted.length === 0) return;
    out.push({ t: n.onset, dur, midi: noteMedian(n), vel: velocityFromRms(noteRms(n, end)) });
  }

  // ----- onset refinement (energy) -----
  function refineOnset(n: NoteAcc): void {
    if (n.refineIdx < 0) return;
    const k0 = n.refineIdx;
    n.refineIdx = -1;
    const oldest = Math.max(0, rawCount - RAW_RING);
    const lo = Math.max(oldest, k0 - ONSET_LOOKBACK_FRAMES, n.refineFloorIdx + 1);
    const hi = Math.min(rawCount - 1, k0 + ONSET_LOOKAHEAD_FRAMES);
    if (k0 < lo || k0 > hi) return;
    let ref = 0;
    let refIdx = k0;
    for (let j = k0; j <= hi; j++) {
      if (rawRms[slot(j)] > ref) {
        ref = rawRms[slot(j)];
        refIdx = j;
      }
    }
    let floor = Infinity;
    for (let j = lo; j <= k0; j++) floor = Math.min(floor, rawRms[slot(j)]);
    if (!(ref > floor * ONSET_MIN_RISE_RATIO)) return; // no attack (e.g. a legato dropout): keep the frame onset
    const thr = floor + ONSET_RMS_FRACTION * (ref - floor);
    let j = refIdx;
    while (j > lo && rawRms[slot(j - 1)] >= thr) j--;
    if (j === lo && rawRms[slot(j)] >= thr) return; // never dropped below the threshold: keep the frame-based onset
    const r0 = rawRms[slot(j - 1)];
    const r1 = rawRms[slot(j)];
    const t0 = rawT[slot(j - 1)];
    const t1 = rawT[slot(j)];
    const onset = r1 > r0 ? t0 + ((thr - r0) / (r1 - r0)) * (t1 - t0) : t1 - hopSec / 2;
    n.onset = Math.max(onset, n.onsetFloorT);
  }

  // ----- held note / merging -----
  function finaliseHeld(): void {
    if (!held) return;
    emit(held, heldEnd);
    held = null;
  }

  function decideMerge(): void {
    pendingMerge = false;
    if (!held || !cur) return;
    const same = cur.sorted.length > 0 && Math.round(noteMedian(held)) === Math.round(noteMedian(cur));
    if (!dipSinceHeld && same) {
      const merged = held;
      noteMoveTail(cur, 0, merged);
      held = null;
      cur = merged;
      return;
    }
    if (!dipSinceHeld) {
      // a pitch change across a short voicing dropout with no energy dip is legato: meet in the middle of the gap
      const mid = 0.5 * (heldEnd + cur.onset);
      heldEnd = mid;
      cur.onset = mid;
      cur.refineIdx = -1;
    }
    finaliseHeld();
  }

  /** a note that began after a gap (with no held note) and no dip: if its pitch differs, start it mid-gap */
  function decideDropout(): void {
    pendingDropout = false;
    if (!cur || dipSinceHeld || Number.isNaN(lastMidi) || cur.sorted.length === 0) return;
    if (Math.round(noteMedian(cur)) === Math.round(lastMidi)) return;
    cur.onset = 0.5 * (lastEnd + cur.t.data[0] - hopSec / 2);
    cur.refineIdx = -1;
  }

  function closeCurToHeld(): void {
    if (!cur) return;
    resolveCandidate();
    if (pendingMerge) decideMerge();
    if (pendingDropout) decideDropout();
    if (!cur) return;
    refineOnset(cur);
    finaliseHeld();
    held = cur;
    heldEnd = noteEnd(cur);
    lastEnd = heldEnd;
    lastMidi = noteMedian(cur);
    cur = null;
    dipSinceHeld = false;
  }

  // ----- change candidates -----
  function resolveCandidate(): void {
    if (candStart < 0 || !cur) return;
    const ref = noteMedian(cur);
    for (let i = candStart; i < cur.t.length; i++) {
      const v = cur.midi.data[i];
      if (!Number.isNaN(v) && Number.isNaN(cur.accepted.data[i])) noteSetAccepted(cur, i, Number.isNaN(ref) ? v : foldOctave(v, ref));
    }
    candStart = -1;
    candCount = 0;
  }

  function candidateMedian(n: NoteAcc): number {
    medianScratch.length = 0;
    for (let i = candStart; i < n.t.length; i++) {
      const v = n.midi.data[i];
      if (!Number.isNaN(v)) medianScratch.push(v);
    }
    return medianOf(medianScratch);
  }

  /** end `cur` before index `from`; the tail becomes the new current note starting at `onset` */
  function splitCur(from: number, onset: Sec, start: NoteStart): void {
    if (!cur) return;
    if (pendingDropout) decideDropout();
    const old = cur;
    const next = newNote(onset, start);
    noteMoveTail(old, from, next);
    candStart = -1;
    candCount = 0;
    refineOnset(old);
    if (onset - old.onset < MIN_NOTE_SEC) {
      // too short to stand alone and it runs straight into the next note: absorb it (onset moves back)
      next.onset = old.onset;
      next.start = old.start;
    } else {
      emit(old, onset);
    }
    cur = next;
  }

  function onVoicedInNote(t: Sec, v: number, rms: number): void {
    if (!cur) return;
    if (pendingMerge) {
      noteAppend(cur, t, v, v, rms);
      if (cur.sorted.length >= MERGE_DECIDE_FRAMES) decideMerge();
      return;
    }
    if (pendingDropout && cur.sorted.length >= MERGE_DECIDE_FRAMES) decideDropout();
    const ref = noteMedian(cur);
    const d = v - ref;
    if (Number.isNaN(ref) || Math.abs(d) <= DEPART_SEMITONES) {
      resolveCandidate();
      noteAppend(cur, t, v, v, rms);
      return;
    }
    const sign = d > 0 ? 1 : -1;
    if (candStart >= 0 && sign !== candSign) resolveCandidate();
    if (candStart < 0) {
      candStart = cur.t.length;
      candSign = sign;
      candCount = 0;
    }
    noteAppend(cur, t, v, NaN, rms);
    candCount++;
    if (candCount < CONFIRM_FRAMES) return;
    const candMid = candidateMedian(cur);
    if (Math.round(candMid) !== Math.round(ref)) {
      const [idx, onset] = glideCrossing(cur, Math.max(1, candStart - CONFIRM_FRAMES), 0.5 * (ref + candMid), sign);
      splitCur(idx, onset, 'pitch');
    } else {
      // same semitone (vibrato, drift): keep the note and take the values into its median
      for (let i = candStart; i < cur.t.length; i++) {
        const x = cur.midi.data[i];
        if (!Number.isNaN(x)) noteSetAccepted(cur, i, x);
      }
      candStart = -1;
      candCount = 0;
    }
  }

  /** first frame (from `from`) past `boundary` in direction `sign`, and the interpolated crossing time */
  function glideCrossing(n: NoteAcc, from: number, boundary: number, sign: number): [number, Sec] {
    let prev = -1;
    for (let i = from; i < n.t.length; i++) {
      const v = n.midi.data[i];
      if (Number.isNaN(v)) continue;
      if ((v - boundary) * sign >= 0) {
        if (prev < 0) return [i, n.t.data[i] - hopSec / 2];
        const v0 = n.midi.data[prev];
        const t0 = n.t.data[prev];
        return [i, t0 + ((boundary - v0) / (v - v0)) * (n.t.data[i] - t0)];
      }
      prev = i;
    }
    return [candStart, n.t.data[candStart] - hopSec / 2];
  }

  // ----- dips (repeated notes) -----
  /** returns the dip-minimum time when a dip completed on this frame, else NaN */
  function updateDip(t: Sec, rms: number): number {
    if (!dipActive) return NaN;
    if (!dipOpen) {
      if (rms > dipPeak) dipPeak = rms;
      if (rms < dipPeak * DIP_DROP_RATIO) {
        dipOpen = true;
        dipMin = rms;
        dipMinT = t;
        dipStartT = t;
      }
      return NaN;
    }
    if (rms < dipMin) {
      dipMin = rms;
      dipMinT = t;
    }
    if (rms >= dipMin * DIP_RECOVER_RATIO) {
      dipOpen = false;
      dipPeak = rms;
      return dipMinT;
    }
    if (t - dipStartT > DIP_MAX_SEC) {
      dipOpen = false;
      dipPeak = rms;
    }
    return NaN;
  }

  function onDip(minT: Sec): void {
    dipSinceHeld = true;
    pendingDropout = false;
    if (pendingMerge) decideMerge();
    if (!cur || minT <= cur.t.data[0]) return;
    let idx = -1;
    for (let i = 1; i < cur.t.length; i++) {
      if (cur.t.data[i] >= minT) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return;
    resolveCandidate();
    splitCur(idx, cur.t.data[idx], 'dip');
  }

  // ----- per processed frame -----
  function processFrame(i: number): void {
    const s = slot(i);
    const t = rawT[s];
    const rms = rawRms[s];
    const v = smoothedMidi(i);

    if (!cur && !held && !(t - lastEnd < LEGATO_DROPOUT_MAX_SEC)) {
      dipActive = false;
      dipOpen = false;
    }
    const dipT = updateDip(t, rms);
    if (!Number.isNaN(dipT)) onDip(dipT);

    if (!Number.isNaN(v)) {
      if (!cur) {
        unvoicedRun = 0;
        cur = newNote(t - hopSec / 2, 'gap');
        cur.refineIdx = i;
        cur.onsetFloorT = held ? heldEnd : ignoreBeforeT;
        cur.refineFloorIdx = lastVoicedIdx;
        if (held) {
          pendingMerge = true;
        } else if (!dipSinceHeld && cur.onset - lastEnd < LEGATO_DROPOUT_MAX_SEC) {
          pendingDropout = true;
        } else {
          dipActive = true;
          dipOpen = false;
          dipPeak = rms;
        }
        noteAppend(cur, t, v, v, rms);
      } else {
        // bridged unvoiced frames stay in the note as NaN
        unvoicedRun = 0;
        onVoicedInNote(t, v, rms);
      }
      lastVoicedIdx = i;
      if (cur && cur.refineIdx >= 0 && i >= cur.refineIdx + ONSET_LOOKAHEAD_FRAMES) refineOnset(cur);
    } else {
      unvoicedRun++;
      if (cur) {
        if (unvoicedRun < UNVOICED_SPLIT_FRAMES) {
          noteAppend(cur, t, NaN, NaN, rms);
        } else {
          // drop the bridged frames, end the note at its last voiced frame
          let k = cur.t.length;
          while (k > 0 && Number.isNaN(cur.midi.data[k - 1])) k--;
          if (k < cur.t.length) {
            const cs = candStart;
            noteTruncate(cur, k);
            candStart = cs >= 0 && cs < k ? cs : -1;
          }
          closeCurToHeld();
        }
      }
      if (held && !cur && t + hopSec / 2 - heldEnd >= MERGE_GAP_SEC - 1e-9) finaliseHeld();
    }
  }

  function pushRaw(f: PitchFrame): void {
    if (rawCount > 0) {
      const dt = f.t - rawT[slot(rawCount - 1)];
      if (dt > MAX_FRAME_GAP_SEC || dt <= 0) {
        flush(rawT[slot(rawCount - 1)] + hopSec / 2);
        resetState();
      } else if (rawCount === 1) {
        hopSec = dt;
      }
    }
    const s = slot(rawCount);
    rawT[s] = f.t;
    rawMidi[s] = f.hz === null ? NaN : hzToMidi(f.hz);
    rawRms[s] = f.rms;
    rawCount++;
    while (processedCount + MEDIAN_HALF < rawCount) processFrame(processedCount++);
  }

  /** process every pending frame before `at`, then finish everything at `at` */
  function flush(at: Sec): void {
    while (processedCount < rawCount && rawT[slot(processedCount)] < at) processFrame(processedCount++);
    processedCount = rawCount;
    if (cur) {
      resolveCandidate();
      if (pendingMerge) decideMerge();
      if (pendingDropout) decideDropout();
    }
    finishAt(held, at, heldEnd);
    held = null;
    if (cur) finishAt(cur, at, noteEnd(cur));
    cur = null;
  }

  function finishAt(n: NoteAcc | null, at: Sec, end: Sec): void {
    if (!n) return;
    refineOnset(n);
    if (n.onset >= at) return;
    let k = n.t.length;
    while (k > 0 && n.t.data[k - 1] >= at) k--;
    if (k < n.t.length) noteTruncate(n, k);
    emit(n, Math.min(end, at));
  }

  function liveNote(n: NoteAcc, end: Sec): RawNote {
    let midi = noteMedian(n);
    if (Number.isNaN(midi)) midi = n.midi.data[n.midi.length - 1];
    return { t: n.onset, dur: Math.max(0, end - n.onset), midi, vel: velocityFromRms(noteRms(n, Infinity)) };
  }

  return {
    push(frame: PitchFrame): RawNote[] {
      out = [];
      if (frame.t < ignoreBeforeT) return out;
      pushRaw(frame);
      return out;
    },
    open(): RawNote | null {
      if (cur) return liveNote(cur, rawT[slot(rawCount - 1)] + hopSec / 2);
      if (held) return liveNote(held, heldEnd);
      return null;
    },
    close(at: Sec): RawNote[] {
      out = [];
      flush(at);
      resetState();
      ignoreBeforeT = at;
      return out;
    },
    reset(): void {
      resetState();
      ignoreBeforeT = -Infinity;
      hopSec = SEG_HOP_SEC;
    },
  };
}
