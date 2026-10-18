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
// Notes of a melodic take (deriveNotes, the ONE derivation, also used by controller.setSmoothing):
//   take.raw   = detections in loop positions after inLat/window clipping, fractional midi (stored)
//   take.notes = assignPhrases(registerShift + snapMidi(cleanNotes(raw, smoothing, L)))
// Live notes during recording stay raw-ish (snapped, uncleaned); the pending overdub track uses deriveNotes on the
// notes so far (running shift/phrases).
// Vocal takes ('vocals'): no analysis; the raw mic audio is the take (buildVocalLoop): corrected by inLat, exactly
// L long + a VOCAL_TAIL_SEC tail, exclusions zeroed (5 ms ramps), rotated so sample 0 = loop pos 0. The window seam
// (first take: pos 0; overdub: pos of ts) is crossfaded over the tail length with the audio recorded just after the
// window end; the tail is a copy of the loop's first samples, so the voice's cycle crossfade is click-free.
import type {
  DrumHit, InstrumentKind, MicBlock, RawLoopNote, MicFeed, Note, NoteSegmenter, OnsetDetector, PitchTracker, RawHit, RawNote, Sec, Take,
} from '../types.ts';
import { createPitchTracker } from '../analysis/pitch.ts';
import { createSegmenter } from '../analysis/segment.ts';
import { createOnsetDetector } from '../analysis/drums.ts';
import { registerShift, snapMidi } from '../analysis/autotune.ts';
import { assignPhrases, type PlainNote } from '../analysis/phrases.ts';
import { DEFAULT_SMOOTHING, cleanNotes } from '../analysis/clean.ts';
import { audioKey } from '../audio/audio-store.ts';

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
/** raw audio kept for the WAV export (and vocal takes: first take max 60 s + pre-roll + tail) */
export const MAX_RAW_SEC = 70;
/** vocal take: seam tail after the loop (the voice crossfades cycles over it) */
export const VOCAL_TAIL_SEC = 0.02;
/** vocal take: fade at exclusion edges (no click where a hold's audio is cut) */
const VOCAL_EXCLUSION_RAMP_SEC = 0.005;
/** peak bins across the loop (Take.peaks, View.livePeaks) */
export const PEAK_BINS = 256;
/** peaks are shown on a dB scale: this level maps to 0, 0 dBFS to 1 */
export const PEAK_FLOOR_DB = -50;
/** first take: live peaks span max(elapsed, this) — the shell's FIRST_TAKE_MIN_LENGTH (src/ui/lanes.ts) */
export const FIRST_TAKE_DISPLAY_MIN_SEC = 4;
/** live peak resolution (samples per chunk) */
const LIVE_PEAK_CHUNK = 128;
const FEED_BLOCK = 512;

export interface Analysis {
  createPitchTracker(): PitchTracker;
  createSegmenter(): NoteSegmenter;
  createOnsetDetector(): OnsetDetector;
  snapMidi(midi: number): number;
  registerShift(midis: number[], kind: InstrumentKind): number;
  assignPhrases(notes: PlainNote[], loopLength: Sec, takeId: string): Note[];
  cleanNotes(raw: RawLoopNote[], smoothing: number, loopLength: Sec): RawLoopNote[];
}

export const REAL_ANALYSIS: Analysis = {
  createPitchTracker, createSegmenter, createOnsetDetector, snapMidi, registerShift, assignPhrases, cleanNotes,
};

/** take.notes from take.raw: cleanNotes(smoothing) → snap → register fit (per take) → phrases */
export function deriveNotes(
  raw: RawLoopNote[], smoothing: number, L: Sec, kind: InstrumentKind, takeId: string, analysis: Partial<Analysis> = {},
): Note[] {
  const A: Analysis = { ...REAL_ANALYSIS, ...analysis };
  const cleaned = A.cleanNotes(raw, smoothing, L);
  const snapped = cleaned.map((n) => ({ ...n, midi: A.snapMidi(n.midi) }));
  const shift = snapped.length ? A.registerShift(snapped.map((n) => n.midi), kind) : 0;
  const plain: PlainNote[] = snapped.map((n) => ({ pos: n.pos, dur: n.dur, midi: n.midi + shift, vel: n.vel }));
  return A.assignPhrases(plain, L, takeId);
}

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
  /** note smoothing (Session.fx.smooth), read when the notes are derived */
  smoothing?: () => number;
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
  /** vocals: peaks 0..1 of what was recorded so far, PEAK_BINS across the loop (first take: across displayLen) */
  livePeaks(displayLen: Sec): number[] | null;
  /** vocals, after finish(): the loop audio (Ls samples + tail), as stored */
  loopAudio(): Float32Array | null;
}

export function createTakeRecorder(opts: TakeOptions): TakeRecorder {
  const A: Analysis = { ...REAL_ANALYSIS, ...opts.analysis };
  const { mic, kind, takeId, inLat, window: win } = opts;
  const sr = mic.sampleRate;
  const drums = kind === 'drums';
  const vocals = kind === 'vocals';
  const melodic = !drums && !vocals;
  const tracker = melodic ? A.createPitchTracker() : null;
  const segmenter = melodic ? A.createSegmenter() : null;
  const onsets = drums ? A.createOnsetDetector() : null;
  const chunkPeaks: number[] = []; // vocals: peak per LIVE_PEAK_CHUNK raw samples from firstFrame
  let loopPcm: Float32Array | null = null;

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
    // drums: no zeroing — zeroed noise resuming at an exclusion edge is a sharp onset (phantom hats); hits inside an
    // exclusion are dropped by the post-filter (placeHit) instead
    const x = drums ? limited : zeroExcluded(frame, limited);
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
    if (vocals) trackPeaks(samples);
    rawChunks.push(samples.slice());
    rawLength += samples.length;
  };

  let peakFill = 0;
  const trackPeaks = (samples: Float32Array) => {
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (peakFill === 0) chunkPeaks.push(a);
      else if (a > chunkPeaks[chunkPeaks.length - 1]) chunkPeaks[chunkPeaks.length - 1] = a;
      peakFill = (peakFill + 1) % LIVE_PEAK_CHUNK;
    }
  };

  const joinRaw = () => {
    const samples = new Float32Array(rawLength);
    let o = 0;
    for (const c of rawChunks) {
      samples.set(c, o);
      o += c.length;
    }
    return samples;
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
  const toRaw = (placed: PlacedNote[]): RawLoopNote[] => placed.map((p) => ({ pos: p.pos, dur: p.dur, midi: p.midi, vel: p.vel }));
  const buildNotes = (raw: RawLoopNote[], L: Sec): Note[] =>
    deriveNotes(raw, opts.smoothing?.() ?? DEFAULT_SMOOTHING, L, kind, takeId, A);

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
      return { id: takeId, notes: melodic ? buildNotes(toRaw(placedNotes()), L) : [], hits: drums ? placedHits() : [] };
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
      if (vocals) {
        loopPcm = buildVocalLoop({ raw: joinRaw(), rawStartFrame: firstFrame, sampleRate: sr, inLat, win, end, exclusions });
        return {
          id: takeId, notes: [], hits: [],
          audio: { key: audioKey(takeId), sampleRate: sr, length: loopPcm.length },
          peaks: loopPeaks(loopPcm, loopPcm.length - Math.round(VOCAL_TAIL_SEC * sr)),
        };
      }
      if (drums) return { id: takeId, notes: [], hits: placedHits(end) };
      const raw = toRaw(placedNotes(end));
      return { id: takeId, notes: buildNotes(raw, L), hits: [], raw };
    },
    discard() {
      finished = true;
      unsubscribe();
    },
    rawAudio() {
      return { t: firstFrame / sr, sampleRate: sr, samples: joinRaw() };
    },
    livePeaks(displayLen) {
      if (!vocals) return null;
      const bins = new Array<number>(PEAK_BINS).fill(0);
      const span = win.type === 'first' ? Math.max(displayLen, 1e-3) : win.loopLength;
      const ws = win.type === 'first' ? win.t0 : win.ts;
      const we = win.type === 'first' ? Infinity : win.ts + win.loopLength;
      for (let c = 0; c < chunkPeaks.length; c++) {
        const tc = (firstFrame + c * LIVE_PEAK_CHUNK) / sr - inLat;
        if (tc < ws || tc >= we || exclusions.some((x) => tc >= x.from && tc < x.to)) continue;
        const pos = win.type === 'first' ? tc - ws : (((tc - win.origin) % span) + span) % span;
        const b = Math.floor((pos / span) * PEAK_BINS);
        if (b >= 0 && b < PEAK_BINS && chunkPeaks[c] > bins[b]) bins[b] = chunkPeaks[c];
      }
      return bins.map(displayLevel);
    },
    loopAudio: () => loopPcm,
  };
}

// ---------- vocal takes (pure) ----------

export interface VocalLoopInput {
  /** raw mic samples; raw[0] is context frame rawStartFrame */
  raw: Float32Array;
  rawStartFrame: number;
  sampleRate: number;
  inLat: Sec;
  win: TakeWindow;
  /** corrected window end asked for (first take: t0 + L; overdub: ≤ ts + L, earlier on a tap/stop commit) */
  end: Sec;
  exclusions: Span[];
}

/** the loop audio: Ls = round(L·sr) samples (sample 0 = loop pos 0) + a tail copying the first samples */
export function buildVocalLoop(v: VocalLoopInput): Float32Array {
  const { raw, sampleRate: sr, inLat, win } = v;
  const L = win.type === 'first' ? v.end - win.t0 : win.loopLength;
  const ws = win.type === 'first' ? win.t0 : win.ts;
  const full = win.type === 'first' || v.end >= win.ts + win.loopLength;
  const Ls = Math.max(1, Math.round(L * sr));
  const X = Math.min(Ls, Math.round(VOCAL_TAIL_SEC * sr));
  // recorded timeline: rec[d] = audio sung at corrected time ws + d/sr (d < Ls + X)
  const rec = new Float32Array(Ls + X);
  const base = Math.round((ws + inLat) * sr) - v.rawStartFrame;
  const recordedTo = full ? Ls + X : Math.max(0, Math.round((v.end - ws) * sr));
  for (let d = 0; d < recordedTo; d++) {
    const i = base + d;
    rec[d] = i >= 0 && i < raw.length ? raw[i] : 0;
  }
  zeroExclusions(rec, v.exclusions, ws, sr);
  // rotate: loop pos q ↔ d = (q − ps) mod Ls
  const ps = win.type === 'first' ? 0 : Math.round(((((win.ts - win.origin) % L) + L) % L) * sr) % Ls;
  const loop = new Float32Array(Ls + X);
  for (let q = 0; q < Ls; q++) loop[q] = rec[(q - ps + Ls) % Ls];
  // window seam at ps: crossfade the window start in while the audio just after the window end fades out
  for (let k = 0; k < X; k++) {
    const w = k / X;
    loop[(ps + k) % Ls] = w * rec[k] + (1 - w) * rec[Ls + k];
  }
  loop.set(loop.subarray(0, X), Ls);
  return loop;
}

function zeroExclusions(rec: Float32Array, exclusions: Span[], ws: Sec, sr: number): void {
  const R = Math.round(VOCAL_EXCLUSION_RAMP_SEC * sr);
  for (const ex of exclusions) {
    const a = Math.round((ex.from - ws) * sr);
    const b = ex.to === Infinity ? rec.length : Math.round((ex.to - ws) * sr);
    if (b <= 0 || a >= rec.length) continue;
    for (let d = Math.max(0, a - R); d < Math.min(rec.length, b + R); d++) {
      const g = d < a ? (a - d) / R : d >= b ? (d - b + 1) / R : 0;
      rec[d] *= Math.min(1, g);
    }
  }
}

/** PEAK_BINS display peaks over the first `loopSamples` samples */
export function loopPeaks(loop: Float32Array, loopSamples: number): number[] {
  const out = new Array<number>(PEAK_BINS).fill(0);
  for (let q = 0; q < loopSamples; q++) {
    const b = Math.floor((q / loopSamples) * PEAK_BINS);
    const a = Math.abs(loop[q]);
    if (a > out[b]) out[b] = a;
  }
  return out.map(displayLevel);
}

/** linear peak → 0..1 on a dB scale (PEAK_FLOOR_DB → 0, 0 dBFS → 1) */
export function displayLevel(peak: number): number {
  if (!(peak > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(peak) - PEAK_FLOOR_DB) / -PEAK_FLOOR_DB));
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
