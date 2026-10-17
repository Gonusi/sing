// [engine] Take recording: mic blocks → analysis (src/analysis, injectable) → RawNote/RawHit → loop positions.
// No Web Audio here: only a MicFeed (subscribe + ring read), so the logic can be driven by any block source.
//
// Timing model (PLAN.md "Timing model"), all context seconds:
//   stamp = mic frame / sampleRate            (RawNote.t / RawHit.t are stamps)
//   tc    = stamp − inLat                     corrected time: when the singer actually sang it
//   first take  (window [t0, t0+L)):  pos = clamp(tc − t0, 0, L) — a note starting in the pre-roll is clipped to t0
//   overdub     (window [ts, ts+L)):  pos = (tc − origin) mod L — a note starting up to OVERDUB_EARLY_CLIP_SEC
//                                     before ts is clipped to ts; earlier ones are dropped
//   every note is clipped to end at the window end (the note open at the end is force-closed there).
// Exclusions (holds): audio with tc in [from, to) is zeroed before analysis; a note starting inside one is
// dropped and a note open at its start is cut there (post-filter, because a hold is known only 300 ms late).
// Autotune: midi = snapMidi(raw) (+ registerShift of the take, computed at commit; the pending overdub track
// uses the running shift of the notes so far). Phrases: assignPhrases at commit (running for pending).
import type {
  DrumHit, InstrumentKind, MicBlock, MicFeed, Note, NoteSegmenter, OnsetDetector, PitchTracker, RawHit, RawNote, Sec, Take,
} from '../types.ts';
import { createPitchTracker } from '../analysis/pitch.ts';
import { createSegmenter } from '../analysis/segment.ts';
import { createOnsetDetector } from '../analysis/drums.ts';
import { registerShift, snapMidi } from '../analysis/autotune.ts';
import { assignPhrases, type PlainNote } from '../analysis/phrases.ts';

/** first take: analysis starts this long before t0 */
export const PREROLL_FIRST_SEC = 0.2;
/** overdub: a note may start this long before ts and is clipped to ts */
export const OVERDUB_EARLY_CLIP_SEC = 0.5;
/** overdub: analysis starts this long before (ts − OVERDUB_EARLY_CLIP_SEC) */
export const PREROLL_OVERDUB_SEC = 0.2;
/** drums: keep feeding this long past the window end so the last hit is classified on full audio (dsp: ≤ 82 ms) */
export const DRUM_TAIL_SEC = 0.1;
/**
 * notes: keep feeding this long past the window end before segmenter.close(windowEnd): a pitch frame centred at t
 * needs audio up to t + half the 2048-sample window (21–23 ms) plus one 10 ms hop
 */
export const PITCH_TAIL_SEC = 0.035;
/** shorter notes (after clipping) are dropped — the same 80 ms minimum as the dsp segmenter */
export const MIN_NOTE_SEC = 0.08;
/** raw audio kept for the WAV export */
export const MAX_RAW_SEC = 70;
const FEED_BLOCK = 512;

export interface Analysis {
  createPitchTracker(): PitchTracker;
  createSegmenter(): NoteSegmenter;
  createOnsetDetector(): OnsetDetector;
  snapMidi(midi: number): number;
  registerShift(midis: number[], kind: InstrumentKind): number;
  assignPhrases(notes: PlainNote[], loopLength: Sec, takeId: string): Note[];
}

export const REAL_ANALYSIS: Analysis = {
  createPitchTracker, createSegmenter, createOnsetDetector, snapMidi, registerShift, assignPhrases,
};

export type TakeWindow =
  | { type: 'first'; t0: Sec }
  | { type: 'overdub'; origin: Sec; loopLength: Sec; ts: Sec };

export interface TakeOptions {
  mic: MicFeed;
  kind: InstrumentKind;
  takeId: string;
  /** captured at take start (a later calibration doesn't move this take) */
  inLat: Sec;
  window: TakeWindow;
  analysis?: Partial<Analysis>;
}

/** corrected-time span [from, to) */
export interface Span {
  from: Sec;
  to: Sec;
}

export interface TakeRecorder {
  readonly takeId: string;
  readonly kind: InstrumentKind;
  readonly window: TakeWindow;
  readonly inLat: Sec;
  /** final events so far, in loop positions (first take: tc − t0), snapped but NOT register-shifted */
  liveNotes(): Note[];
  liveHits(): DrumHit[];
  /** the note being sung (pos + fractional midi), null when none or excluded */
  openNote(): { pos: Sec; midi: number } | null;
  /** overdub: the take as it stands (running shift + phrases), for the pending scheduler track */
  pendingTake(): Take;
  /** fires when events became final or exclusions changed */
  onUpdate(cb: () => void): () => void;
  /** drop audio from corrected time `from` (open-ended until endExclusion) */
  beginExclusion(from: Sec): void;
  endExclusion(to: Sec): void;
  addExclusion(span: Span): void;
  /** close the window at corrected time `end` (overdub: clamped to ts + L; first take: L = end − t0) → the take */
  finish(end: Sec): Take;
  discard(): void;
  /** raw (unzeroed) mic samples fed to this take; t = stamp of samples[0] */
  rawAudio(): { t: Sec; sampleRate: number; samples: Float32Array };
}

export function createTakeRecorder(opts: TakeOptions): TakeRecorder {
  const A: Analysis = { ...REAL_ANALYSIS, ...opts.analysis };
  const { mic, kind, takeId, inLat, window: win } = opts;
  const sr = mic.sampleRate;
  const drums = kind === 'drums';
  const tracker = drums ? null : A.createPitchTracker();
  const segmenter = drums ? null : A.createSegmenter();
  const onsets = drums ? A.createOnsetDetector() : null;

  const rawNotes: RawNote[] = [];
  const rawHits: RawHit[] = [];
  const exclusions: Span[] = [];
  const rawChunks: Float32Array[] = [];
  let rawLength = 0;
  const subs = new Set<() => void>();
  let finished = false;
  let segmenterClosed = false;

  // overdub: the window end is known, so analysis stops just past it (a tail so the last frames / hit are complete);
  // the segmenter is closed at the window end as soon as the tail is in, so the last note never waits for its
  // 140 ms finalisation delay
  const windowEndStamp = win.type === 'overdub' ? win.ts + win.loopLength + inLat : Infinity;
  const feedLimitFrame = Math.round((windowEndStamp + (drums ? DRUM_TAIL_SEC : PITCH_TAIL_SEC)) * sr);
  const startStamp = win.type === 'first'
    ? win.t0 + inLat - PREROLL_FIRST_SEC
    : win.ts + inLat - OVERDUB_EARLY_CLIP_SEC - PREROLL_OVERDUB_SEC;

  const emit = () => {
    for (const cb of [...subs]) cb();
  };

  const placeCtx = (end?: Sec): PlaceContext => ({ win, inLat, exclusions, end });

  // ---- feeding ----
  const pre = mic.read(startStamp, Number.MAX_SAFE_INTEGER / sr);
  const firstFrame = pre.samples.length ? Math.round(pre.t * sr) : Math.round(startStamp * sr);
  let nextFrame = firstFrame;

  const feed = (frame: number, samples: Float32Array) => {
    if (finished) return;
    // drop what was already fed
    if (frame + samples.length <= nextFrame) return;
    if (frame < nextFrame) {
      samples = samples.subarray(nextFrame - frame);
      frame = nextFrame;
    }
    nextFrame = frame + samples.length;
    keepRaw(samples);
    const limited = frame >= feedLimitFrame ? null : samples.subarray(0, Math.max(0, feedLimitFrame - frame));
    if (!limited || limited.length === 0) return;
    const x = zeroExcluded(frame, limited);
    let changed = false;
    if (tracker && segmenter && !segmenterClosed) {
      for (const f of tracker.push({ frame, samples: x }, sr)) {
        const done = segmenter.push(f);
        if (done.length) {
          rawNotes.push(...done);
          changed = true;
        }
      }
      if (frame + limited.length >= feedLimitFrame) {
        rawNotes.push(...segmenter.close(windowEndStamp));
        segmenterClosed = true;
        changed = true;
      }
    }
    if (onsets) {
      const hits = onsets.push({ frame, samples: x }, sr);
      if (hits.length) {
        rawHits.push(...hits);
        changed = true;
      }
    }
    if (changed) emit();
  };

  const keepRaw = (samples: Float32Array) => {
    if (rawLength >= MAX_RAW_SEC * sr) return;
    rawChunks.push(samples.slice());
    rawLength += samples.length;
  };

  const zeroExcluded = (frame: number, samples: Float32Array): Float32Array => {
    let out: Float32Array | null = null;
    for (const ex of exclusions) {
      const a = Math.max(0, Math.round((ex.from + inLat) * sr) - frame);
      const b = Math.min(samples.length, ex.to === Infinity ? samples.length : Math.round((ex.to + inLat) * sr) - frame);
      if (b <= a) continue;
      out ??= samples.slice();
      out.fill(0, a, b);
    }
    return out ?? samples;
  };

  const feedChunked = (frame: number, samples: Float32Array) => {
    for (let i = 0; i < samples.length; i += FEED_BLOCK) feed(frame + i, samples.subarray(i, i + FEED_BLOCK));
  };

  feedChunked(firstFrame, pre.samples);
  const unsubscribe = mic.subscribe((b: MicBlock) => feed(b.frame, b.samples));

  // ---- take building ----
  const placedNotes = (end?: Sec) => {
    const c = placeCtx(end);
    return rawNotes
      .map((r) => placeNote(r, c))
      .filter((p): p is PlacedNote => p !== null)
      .sort((a, b) => a.pos - b.pos);
  };
  const placedHits = (end?: Sec): DrumHit[] => {
    const c = placeCtx(end);
    return rawHits
      .map((r) => placeHit(r, c))
      .filter((h): h is DrumHit => h !== null)
      .sort((a, b) => a.pos - b.pos);
  };
  const buildNotes = (placed: PlacedNote[], L: Sec): Note[] => {
    const snapped = placed.map((p) => ({ ...p, midi: A.snapMidi(p.midi) }));
    const shift = snapped.length ? A.registerShift(snapped.map((n) => n.midi), kind) : 0;
    const plain: PlainNote[] = snapped.map((n) => ({ pos: n.pos, dur: n.dur, midi: n.midi + shift, vel: n.vel }));
    return A.assignPhrases(plain, L, takeId);
  };

  return {
    takeId,
    kind,
    window: win,
    inLat,
    liveNotes: () =>
      placedNotes().map((p) => ({
        pos: p.pos, dur: p.dur, midi: A.snapMidi(p.midi), vel: p.vel, phrase: `${takeId}:live`, legatoNext: false,
      })),
    liveHits: () => placedHits(),
    openNote() {
      if (!segmenter || finished || segmenterClosed) return null;
      const open = segmenter.open();
      if (!open) return null;
      const p = placeNote({ ...open, dur: Math.max(open.dur, MIN_NOTE_SEC) }, placeCtx());
      return p ? { pos: p.pos, midi: open.midi } : null;
    },
    pendingTake() {
      const L = win.type === 'overdub' ? win.loopLength : 0;
      return { id: takeId, notes: drums ? [] : buildNotes(placedNotes(), L), hits: drums ? placedHits() : [] };
    },
    onUpdate(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    beginExclusion(from) {
      exclusions.push({ from, to: Infinity });
      emit();
    },
    endExclusion(to) {
      const open = [...exclusions].reverse().find((e) => e.to === Infinity);
      if (open) open.to = Math.max(open.from, to);
      emit();
    },
    addExclusion(span) {
      exclusions.push({ ...span });
      emit();
    },
    finish(endAsked) {
      // an overdub window never grows past ts + L (a tap inside the commit margin must not wrap notes to pos 0)
      const end = win.type === 'overdub' ? Math.min(endAsked, win.ts + win.loopLength) : endAsked;
      if (segmenter && !segmenterClosed) {
        rawNotes.push(...segmenter.close(end + inLat));
        segmenterClosed = true;
      }
      // a hit still waiting for its classification span (stop right after it) is classified on the audio we have
      if (onsets) rawHits.push(...onsets.close(end + inLat));
      finished = true;
      unsubscribe();
      const L = win.type === 'first' ? end - win.t0 : win.loopLength;
      return {
        id: takeId,
        notes: drums ? [] : buildNotes(placedNotes(end), L),
        hits: drums ? placedHits(end) : [],
      };
    },
    discard() {
      finished = true;
      unsubscribe();
    },
    rawAudio() {
      const samples = new Float32Array(rawLength);
      let o = 0;
      for (const c of rawChunks) {
        samples.set(c, o);
        o += c.length;
      }
      return { t: firstFrame / sr, sampleRate: sr, samples };
    },
  };
}

// ---------- placement: raw detections → loop positions (pure) ----------

export interface PlaceContext {
  win: TakeWindow;
  inLat: Sec;
  exclusions: Span[];
  /** corrected window end; undefined while a first take is still open */
  end?: Sec;
}

export interface PlacedNote {
  pos: Sec;
  dur: Sec;
  /** raw fractional midi */
  midi: number;
  vel: number;
  /** corrected start (after clipping) */
  tc: Sec;
}

function windowOf(c: PlaceContext): { start: Sec; end: Sec; earliest: Sec } {
  if (c.win.type === 'first') {
    return { start: c.win.t0, end: c.end ?? Infinity, earliest: -Infinity };
  }
  return { start: c.win.ts, end: c.end ?? c.win.ts + c.win.loopLength, earliest: c.win.ts - OVERDUB_EARLY_CLIP_SEC };
}

function loopPos(c: PlaceContext, tc: Sec): Sec {
  if (c.win.type === 'first') return Math.max(0, tc - c.win.t0);
  const L = c.win.loopLength;
  return (((tc - c.win.origin) % L) + L) % L;
}

export function placeNote(raw: RawNote, c: PlaceContext): PlacedNote | null {
  let start = raw.t - c.inLat;
  let end = start + raw.dur;
  for (const ex of c.exclusions) {
    if (start >= ex.from && start < ex.to) return null;
    if (ex.from > start && ex.from < end) end = ex.from;
  }
  const w = windowOf(c);
  if (start < w.earliest) return null;
  start = Math.max(start, w.start);
  end = Math.min(end, w.end);
  if (end - start < MIN_NOTE_SEC) return null;
  return { pos: loopPos(c, start), dur: end - start, midi: raw.midi, vel: raw.vel, tc: start };
}

export function placeHit(raw: RawHit, c: PlaceContext): DrumHit | null {
  const tc = raw.t - c.inLat;
  for (const ex of c.exclusions) if (tc >= ex.from && tc < ex.to) return null;
  const w = windowOf(c);
  if (tc >= w.end) return null;
  if (c.win.type === 'first') {
    if (tc < w.start - PREROLL_FIRST_SEC) return null;
  } else if (tc < w.start) {
    return null;
  }
  return { pos: loopPos(c, Math.max(tc, w.start)), kind: raw.kind, vel: raw.vel };
}
