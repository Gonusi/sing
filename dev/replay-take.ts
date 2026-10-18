// [dsp] Replay a recorded take (the app's "export last raw take" WAV) through the REAL take recorder
// (src/loop/take.ts createTakeRecorder + src/analysis) in Node, as a first take, and print what the app commits.
//
// Usage: node dev/replay-take.ts <wav> [--kind synth|violin|bass|drums] [--smooth x] [--inlat sec] [--raw]
//   The exported WAV starts at the take's pre-roll (t0 + inLat − PREROLL_FIRST_SEC) and runs to the stop, so the replay
//   puts WAV sample 0 at that stamp and finishes the take at the WAV's end. Holds (voice commands) are not in the WAV:
//   a take stopped by voice also contains the spoken "stop" (no exclusion here).
// Prints: the raw notes the segmenter returned (placed in loop positions, fractional midi), the notes the CURRENT
// take.ts commits (Take.notes), and the round-2 derivation cleanNotes(raw, smooth) → snap → register shift → phrases.
import { createTakeRecorder, placeNote, PREROLL_FIRST_SEC, REAL_ANALYSIS, type PlaceContext } from '../src/loop/take.ts';
import { cleanNotes, DEFAULT_SMOOTHING } from '../src/analysis/clean.ts';
import { assignPhrases } from '../src/analysis/phrases.ts';
import { registerShift, snapMidi } from '../src/analysis/autotune.ts';
import type { InstrumentKind, MicBlock, MicFeed, Note, RawLoopNote, RawNote, Sec } from '../src/types.ts';
import type { SegmentedNote } from '../src/analysis/segment.ts';
import { readWavMono } from './wav.ts';

// ---------- constants ----------
const BLOCK_SAMPLES = 512;
/** context frame of WAV sample 0 (any positive value; 1 s keeps every time positive) */
const START_FRAME = 48000;
const DEFAULT_INLAT_SEC = 0.01;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const noteName = (m: number) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

/** a MicFeed that plays `samples` from context frame `startFrame` when `run()` is called */
export function createWavFeed(samples: Float32Array, sampleRate: number, startFrame: number): MicFeed & { run(): void } {
  const subs = new Set<(b: MicBlock) => void>();
  return {
    sampleRate,
    subscribe(cb) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    // the ring is empty when the recorder is created: everything arrives through subscribe
    read: (from: Sec) => ({ t: from, samples: new Float32Array(0) }),
    inject() {
      throw new Error('not supported by the WAV feed');
    },
    run() {
      for (let i = 0; i < samples.length; i += BLOCK_SAMPLES) {
        const block = { frame: startFrame + i, samples: samples.subarray(i, i + BLOCK_SAMPLES) };
        for (const cb of [...subs]) cb(block);
      }
    },
  };
}

export interface ReplayResult {
  loopLength: Sec;
  /** detections as placed in loop positions (what Take.raw holds in round 2) */
  raw: RawLoopNote[];
  /** what the current take.ts commits */
  committed: Note[];
  /** cleanNotes(raw) → snap → register shift → phrases */
  cleaned: Note[];
}

export function replayTake(samples: Float32Array, sampleRate: number, kind: InstrumentKind, smoothing: number, inLat = DEFAULT_INLAT_SEC): ReplayResult {
  const mic = createWavFeed(samples, sampleRate, START_FRAME);
  const t0 = START_FRAME / sampleRate - inLat + PREROLL_FIRST_SEC;
  const seen: RawNote[] = [];
  const rec = createTakeRecorder({
    mic,
    kind,
    takeId: 'replay',
    inLat,
    window: { type: 'first', t0 },
    analysis: {
      // the real segmenter, with every returned note recorded on the way out
      createSegmenter() {
        const s = REAL_ANALYSIS.createSegmenter();
        return {
          push: (f) => record(s.push(f)),
          open: () => s.open(),
          close: (at) => record(s.close(at)),
          reset: () => s.reset(),
        };
      },
    },
  });
  const record = (notes: RawNote[]) => {
    seen.push(...notes);
    return notes;
  };
  mic.run();
  const end = (START_FRAME + samples.length) / sampleRate - inLat;
  const take = rec.finish(end);
  const L = end - t0;
  const ctx: PlaceContext = { win: { type: 'first', t0 }, inLat, exclusions: [], end };
  // take.raw once the engine stores it; until then the same placement here (plus the segmenter's attack flag,
  // which placeNote does not copy yet)
  const raw: RawLoopNote[] = take.raw ?? seen
    .map((r) => {
      const p = placeNote(r, ctx);
      return p ? { pos: p.pos, dur: p.dur, midi: p.midi, vel: p.vel, attack: (r as SegmentedNote).attack } : null;
    })
    .filter((p) => p !== null)
    .sort((a, b) => a.pos - b.pos);
  return { loopLength: L, raw, committed: take.notes, cleaned: deriveNotes(raw, kind, smoothing, L) };
}

/** the round-2 derivation (engine does the same): clean → snap → register fit → phrases */
export function deriveNotes(raw: RawLoopNote[], kind: InstrumentKind, smoothing: number, L: Sec): Note[] {
  const clean = cleanNotes(raw, smoothing, L).map((n) => ({ ...n, midi: snapMidi(n.midi) }));
  const shift = clean.length ? registerShift(clean.map((n) => n.midi), kind) : 0;
  return assignPhrases(clean.map((n) => ({ ...n, midi: n.midi + shift })), L, 'replay');
}

function printNotes(title: string, notes: { pos: number; dur: number; midi: number; phrase?: string; legatoNext?: boolean; attack?: boolean }[]): void {
  console.log(`\n${title}: ${notes.length}`);
  for (const n of notes) {
    const legato = (n.legatoNext ? ' →' : '') + (n.attack === false ? ' (glide in)' : '');
    console.log(`  ${n.pos.toFixed(3).padStart(7)}  dur ${n.dur.toFixed(3)}  ${n.midi.toFixed(2).padStart(6)} ${noteName(n.midi).padEnd(4)}${n.phrase ? ' ' + n.phrase : ''}${legato}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--raw'));
  if (!file) {
    console.log('usage: node dev/replay-take.ts <wav> [--kind synth|violin|bass|drums] [--smooth x] [--inlat sec]');
    process.exitCode = 2;
    return;
  }
  const kind = (opt('--kind') ?? 'synth') as InstrumentKind;
  const smoothing = Number(opt('--smooth') ?? DEFAULT_SMOOTHING);
  const inLat = Number(opt('--inlat') ?? DEFAULT_INLAT_SEC);
  const { sampleRate, samples } = readWavMono(file);
  let peak = 0;
  let sq = 0;
  for (const x of samples) {
    peak = Math.max(peak, Math.abs(x));
    sq += x * x;
  }
  console.log(`${file}: ${(samples.length / sampleRate).toFixed(2)} s at ${sampleRate} Hz, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, rms ${(10 * Math.log10(sq / samples.length)).toFixed(1)} dBFS; kind ${kind}, smoothing ${smoothing}, inLat ${inLat}`);
  const r = replayTake(samples, sampleRate, kind, smoothing, inLat);
  console.log(`loop length ${r.loopLength.toFixed(3)} s`);
  printNotes('raw detections (loop positions)', r.raw);
  printNotes('committed by the current take.ts (Take.notes)', r.committed);
  printNotes(`round 2: cleanNotes(smoothing ${smoothing}) → snap → shift → phrases`, r.cleaned);
}

if (import.meta.main) main();
