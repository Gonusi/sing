// [dsp] Offline analyzer: streams WAVs through the live analysis pipeline exactly as the engine does
// (512-sample blocks, frame counter from 0) and scores them against ground truth when a .json sits next to the WAV.
//
// Usage: node dev/analyze.ts [--drums] [--notes] [--verbose] [files...]
//   no files  → every WAV in dev/fixtures/out/ (generated first with dev/make-fixtures.ts if missing)
//   --drums   → run the onset detector on every file (default: only beatbox* files and files whose truth has hits)
//   --notes   → run the note pipeline on every file (default: every file that is not a drum fixture)
//   --verbose → list every detection next to the truth
// Scoring:
//   notes: correct = snapped MIDI equal AND onset within NOTE_ONSET_TOLERANCE_SEC (nearest unmatched detection)
//   drums: correct = same kind AND onset within HIT_ONSET_TOLERANCE_SEC
// Exit code 1 when a threshold below fails (only files with ground truth count; stress-* fixtures, truth.gated = false,
// are reported with a * but never fail the run).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createOnsetDetector } from '../src/analysis/drums.ts';
import { createPitchTracker } from '../src/analysis/pitch.ts';
import { createSegmenter } from '../src/analysis/segment.ts';
import { snapMidi } from '../src/analysis/autotune.ts';
import type { RawHit, RawNote } from '../src/types.ts';
import { FIXTURE_OUT_DIR, makeFixtures, type FixtureTruth } from './make-fixtures.ts';
import { readWavMono } from './wav.ts';

// ---------- constants ----------
const BLOCK_SAMPLES = 512;
const NOTE_ONSET_TOLERANCE_SEC = 0.05;
const HIT_ONSET_TOLERANCE_SEC = 0.04;
const MIN_NOTE_ACCURACY = 0.95;
const MAX_MEAN_ONSET_ERROR_SEC = 0.03;
const MIN_DRUM_ACCURACY = 0.85;
const MAX_DRUM_EXTRA_FRACTION = 0.1;
const MIN_SPEED_X_REALTIME = 20;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ---------- types ----------
interface TimedNote extends RawNote {
  /** context time of the end of the block whose push() returned it (Infinity = returned by close()) */
  emittedAt: number;
}

interface TimedHit extends RawHit {
  emittedAt: number;
}

interface NoteScore {
  gt: number;
  det: number;
  correct: number;
  wrongPitch: number;
  missed: number;
  extra: number;
  onsetErrors: number[];
  finalDelays: number[];
}

interface HitScore {
  gt: number;
  det: number;
  correct: number;
  wrongKind: number;
  missed: number;
  extra: number;
  onsetErrors: number[];
  finalDelays: number[];
  confusion: Record<string, number>;
}

// ---------- helpers ----------
export function noteName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

const ms = (sec: number) => (sec * 1000).toFixed(1);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

function loadTruth(wavPath: string): FixtureTruth | null {
  const jsonPath = wavPath.replace(/\.wav$/i, '.json');
  if (!existsSync(jsonPath)) return null;
  return JSON.parse(readFileSync(jsonPath, 'utf8')) as FixtureTruth;
}

// ---------- pipelines ----------
export function runNotes(samples: Float32Array, sampleRate: number): { notes: TimedNote[]; seconds: number } {
  const tracker = createPitchTracker();
  const seg = createSegmenter();
  const notes: TimedNote[] = [];
  const t0 = performance.now();
  for (let frame = 0; frame < samples.length; frame += BLOCK_SAMPLES) {
    const block = samples.subarray(frame, Math.min(samples.length, frame + BLOCK_SAMPLES));
    const emittedAt = (frame + block.length) / sampleRate;
    for (const pf of tracker.push({ frame, samples: block }, sampleRate)) {
      for (const n of seg.push(pf)) notes.push({ ...n, emittedAt });
    }
    seg.open();
  }
  for (const n of seg.close(samples.length / sampleRate)) notes.push({ ...n, emittedAt: Infinity });
  return { notes, seconds: (performance.now() - t0) / 1000 };
}

export function runDrums(samples: Float32Array, sampleRate: number): { hits: TimedHit[]; seconds: number } {
  const det = createOnsetDetector();
  const hits: TimedHit[] = [];
  const t0 = performance.now();
  for (let frame = 0; frame < samples.length; frame += BLOCK_SAMPLES) {
    const block = samples.subarray(frame, Math.min(samples.length, frame + BLOCK_SAMPLES));
    const emittedAt = (frame + block.length) / sampleRate;
    for (const h of det.push({ frame, samples: block }, sampleRate)) hits.push({ ...h, emittedAt });
  }
  for (const h of det.close(samples.length / sampleRate)) hits.push({ ...h, emittedAt: Infinity });
  return { hits, seconds: (performance.now() - t0) / 1000 };
}

// ---------- scoring ----------
/** greedy nearest-onset matching within `tol`; returns det index per truth index (-1 = none) */
function matchByTime(truthT: number[], detT: number[], tol: number): number[] {
  const used = new Array<boolean>(detT.length).fill(false);
  return truthT.map((t) => {
    let best = -1;
    let bestErr = tol;
    for (let j = 0; j < detT.length; j++) {
      const err = Math.abs(detT[j] - t);
      if (!used[j] && err <= bestErr) {
        best = j;
        bestErr = err;
      }
    }
    if (best >= 0) used[best] = true;
    return best;
  });
}

function scoreNotes(truth: FixtureTruth['notes'], notes: TimedNote[], verbose: boolean): NoteScore {
  const match = matchByTime(truth.map((n) => n.t), notes.map((n) => n.t), NOTE_ONSET_TOLERANCE_SEC);
  const score: NoteScore = { gt: truth.length, det: notes.length, correct: 0, wrongPitch: 0, missed: 0, extra: 0, onsetErrors: [], finalDelays: [] };
  const matched = new Set<number>();
  truth.forEach((gt, i) => {
    const j = match[i];
    if (j < 0) {
      score.missed++;
      if (verbose) console.log(`    miss  gt ${gt.t.toFixed(3)} ${noteName(gt.midi)}(${gt.midi}) dur ${gt.dur.toFixed(3)}`);
      return;
    }
    matched.add(j);
    const d = notes[j];
    score.onsetErrors.push(Math.abs(d.t - gt.t));
    const ok = snapMidi(d.midi) === gt.midi;
    if (ok) score.correct++;
    else score.wrongPitch++;
    if (verbose || !ok) {
      console.log(
        `    ${ok ? 'ok   ' : 'PITCH'} gt ${gt.t.toFixed(3)} ${noteName(gt.midi)}(${gt.midi}) dur ${gt.dur.toFixed(3)}  det ${d.t.toFixed(3)} midi ${d.midi.toFixed(2)} dur ${d.dur.toFixed(3)} vel ${d.vel.toFixed(2)}  Δ ${ms(d.t - gt.t)} ms`,
      );
    }
  });
  notes.forEach((d, j) => {
    if (Number.isFinite(d.emittedAt)) score.finalDelays.push(d.emittedAt - (d.t + d.dur));
    if (matched.has(j)) return;
    score.extra++;
    console.log(`    EXTRA det ${d.t.toFixed(3)} midi ${d.midi.toFixed(2)} (${noteName(d.midi)}) dur ${d.dur.toFixed(3)} vel ${d.vel.toFixed(2)}`);
  });
  return score;
}

function scoreHits(truth: FixtureTruth['hits'], hits: TimedHit[], verbose: boolean): HitScore {
  const match = matchByTime(truth.map((h) => h.t), hits.map((h) => h.t), HIT_ONSET_TOLERANCE_SEC);
  const score: HitScore = { gt: truth.length, det: hits.length, correct: 0, wrongKind: 0, missed: 0, extra: 0, onsetErrors: [], finalDelays: [], confusion: {} };
  const matched = new Set<number>();
  truth.forEach((gt, i) => {
    const j = match[i];
    if (j < 0) {
      score.missed++;
      console.log(`    miss  gt ${gt.t.toFixed(3)} ${gt.kind}`);
      return;
    }
    matched.add(j);
    const d = hits[j];
    score.onsetErrors.push(Math.abs(d.t - gt.t));
    const key = `${gt.kind}→${d.kind}`;
    score.confusion[key] = (score.confusion[key] ?? 0) + 1;
    const ok = d.kind === gt.kind;
    if (ok) score.correct++;
    else score.wrongKind++;
    if (verbose || !ok) console.log(`    ${ok ? 'ok  ' : 'KIND'} gt ${gt.t.toFixed(3)} ${gt.kind.padEnd(5)} det ${d.t.toFixed(3)} ${d.kind.padEnd(5)} vel ${d.vel.toFixed(2)}  Δ ${ms(d.t - gt.t)} ms`);
  });
  hits.forEach((d, j) => {
    if (Number.isFinite(d.emittedAt)) score.finalDelays.push(d.emittedAt - d.t);
    if (matched.has(j)) return;
    score.extra++;
    console.log(`    EXTRA det ${d.t.toFixed(3)} ${d.kind} vel ${d.vel.toFixed(2)}`);
  });
  return score;
}

// ---------- main ----------
function listDefaultFiles(): string[] {
  const hasWavs = existsSync(FIXTURE_OUT_DIR) && readdirSync(FIXTURE_OUT_DIR).some((f) => f.endsWith('.wav'));
  if (!hasWavs) {
    console.log(`no fixtures in ${FIXTURE_OUT_DIR}: generating them (dev/make-fixtures.ts)`);
    makeFixtures(FIXTURE_OUT_DIR);
  }
  return readdirSync(FIXTURE_OUT_DIR)
    .filter((f) => f.endsWith('.wav'))
    .sort()
    .map((f) => join(FIXTURE_OUT_DIR, f));
}

function main(): number {
  const args = process.argv.slice(2);
  const forceDrums = args.includes('--drums');
  const forceNotes = args.includes('--notes');
  const verbose = args.includes('--verbose');
  const files = args.filter((a) => !a.startsWith('--'));
  const paths = files.length ? files : listDefaultFiles();

  const noteRows: string[] = [];
  const hitRows: string[] = [];
  const failures: string[] = [];
  let noteAudioSec = 0;
  let noteCpuSec = 0;
  let drumAudioSec = 0;
  let drumCpuSec = 0;
  const sung = { gt: 0, correct: 0, onsetErrors: [] as number[], finalDelays: [] as number[] };
  const stress = { gt: 0, correct: 0, onsetErrors: [] as number[] };
  const allHitDelays: number[] = [];

  for (const path of paths) {
    const name = basename(path).replace(/\.wav$/i, '');
    const truth = loadTruth(path);
    const { sampleRate, samples } = readWavMono(path);
    const audioSec = samples.length / sampleRate;
    const isDrumFixture = name.startsWith('beatbox') || (truth?.hits.length ?? 0) > 0;
    const isSilence = truth !== null && truth.notes.length === 0 && truth.hits.length === 0;
    const gated = truth?.gated !== false;
    const label = (gated ? name : `${name}*`).padEnd(18);
    const doNotes = forceNotes || !isDrumFixture || isSilence;
    const doDrums = forceDrums || isDrumFixture || isSilence;
    console.log(`\n${name}  (${sampleRate} Hz, ${audioSec.toFixed(2)} s)${truth ? '  — ' + truth.description : ''}`);

    if (doNotes) {
      const { notes, seconds } = runNotes(samples, sampleRate);
      noteAudioSec += audioSec;
      noteCpuSec += seconds;
      if (!truth) {
        for (const n of notes) console.log(`    note ${n.t.toFixed(3)} dur ${n.dur.toFixed(3)} midi ${n.midi.toFixed(2)} ${noteName(n.midi)} vel ${n.vel.toFixed(2)}`);
        noteRows.push(`${label} ${'-'.padStart(4)} ${String(notes.length).padStart(4)}   (no ground truth)`);
      } else {
        const s = scoreNotes(truth.notes, notes, verbose);
        if (truth.notes.length > 0 && !gated) {
          stress.gt += s.gt;
          stress.correct += s.correct;
          stress.onsetErrors.push(...s.onsetErrors);
        } else if (truth.notes.length > 0) {
          sung.gt += s.gt;
          sung.correct += s.correct;
          sung.onsetErrors.push(...s.onsetErrors);
          sung.finalDelays.push(...s.finalDelays);
        } else if (notes.length > 0 && gated) {
          failures.push(`${name}: ${notes.length} notes on a fixture that must yield none`);
        }
        noteRows.push(
          [
            label,
            String(s.gt).padStart(4),
            String(s.det).padStart(4),
            String(s.correct).padStart(5),
            (s.gt ? pct(s.correct / s.gt) : '-').padStart(7),
            `${ms(mean(s.onsetErrors))}/${ms(maxOf(s.onsetErrors))}`.padStart(11),
            String(s.extra).padStart(5),
            String(s.missed).padStart(6),
            String(s.wrongPitch).padStart(6),
            `${ms(percentile(s.finalDelays, 0.95))}/${ms(maxOf(s.finalDelays))}`.padStart(13),
            `${(audioSec / seconds).toFixed(0)}x`.padStart(6),
          ].join(' '),
        );
      }
    }

    if (doDrums) {
      const { hits, seconds } = runDrums(samples, sampleRate);
      drumAudioSec += audioSec;
      drumCpuSec += seconds;
      if (!truth) {
        for (const h of hits) console.log(`    hit ${h.t.toFixed(3)} ${h.kind} vel ${h.vel.toFixed(2)}`);
        hitRows.push(`${label} ${'-'.padStart(4)} ${String(hits.length).padStart(4)}   (no ground truth)`);
      } else {
        const s = scoreHits(truth.hits, hits, verbose);
        allHitDelays.push(...s.finalDelays);
        if (!gated) {
          // stress fixture: reported only
        } else if (truth.hits.length > 0) {
          if (s.correct / s.gt < MIN_DRUM_ACCURACY) failures.push(`${name}: drums ${pct(s.correct / s.gt)} correct < ${pct(MIN_DRUM_ACCURACY)}`);
          if (s.extra / s.gt > MAX_DRUM_EXTRA_FRACTION) failures.push(`${name}: ${s.extra} extra hits > ${pct(MAX_DRUM_EXTRA_FRACTION)}`);
        } else if (hits.length > 0) {
          failures.push(`${name}: ${hits.length} hits on a fixture that must yield none`);
        }
        hitRows.push(
          [
            label,
            String(s.gt).padStart(4),
            String(s.det).padStart(4),
            String(s.correct).padStart(5),
            (s.gt ? pct(s.correct / s.gt) : '-').padStart(7),
            `${ms(mean(s.onsetErrors))}/${ms(maxOf(s.onsetErrors))}`.padStart(11),
            String(s.extra).padStart(5),
            String(s.missed).padStart(6),
            String(s.wrongKind).padStart(6),
            `${ms(maxOf(s.finalDelays))}`.padStart(9),
            `${(audioSec / seconds).toFixed(0)}x`.padStart(6),
            Object.entries(s.confusion)
              .filter(([k]) => k.split('→')[0] !== k.split('→')[1])
              .map(([k, v]) => `${k}:${v}`)
              .join(' '),
          ].join(' '),
        );
      }
    }
  }

  if (noteRows.length) {
    console.log('\nNOTES');
    console.log('fixture              gt  det  ok        %  onset mean/max  extra missed pitch  final p95/max  speed');
    for (const r of noteRows) console.log(r);
    if (sung.gt > 0) {
      const acc = sung.correct / sung.gt;
      const meanErr = mean(sung.onsetErrors);
      console.log(
        `sung total: ${sung.correct}/${sung.gt} = ${pct(acc)} correct, onset error mean ${ms(meanErr)} ms max ${ms(maxOf(sung.onsetErrors))} ms, ` +
          `finalisation delay after note end p95 ${ms(percentile(sung.finalDelays, 0.95))} ms max ${ms(maxOf(sung.finalDelays))} ms`,
      );
      if (acc < MIN_NOTE_ACCURACY) failures.push(`notes: ${pct(acc)} correct < ${pct(MIN_NOTE_ACCURACY)}`);
      if (meanErr >= MAX_MEAN_ONSET_ERROR_SEC) failures.push(`notes: mean onset error ${ms(meanErr)} ms >= ${ms(MAX_MEAN_ONSET_ERROR_SEC)} ms`);
    }
    if (stress.gt > 0) {
      console.log(
        `stress total (not gated): ${stress.correct}/${stress.gt} = ${pct(stress.correct / stress.gt)} correct, onset error mean ${ms(mean(stress.onsetErrors))} ms max ${ms(maxOf(stress.onsetErrors))} ms`,
      );
    }
  }
  if (hitRows.length) {
    console.log('\nDRUMS');
    console.log('fixture              gt  det  ok        %  onset mean/max  extra missed  kind  final max  speed  confusions');
    for (const r of hitRows) console.log(r);
    if (allHitDelays.length) console.log(`hit finalisation delay after onset: max ${ms(maxOf(allHitDelays))} ms`);
  }
  const noteSpeed = noteCpuSec > 0 ? noteAudioSec / noteCpuSec : Infinity;
  const drumSpeed = drumCpuSec > 0 ? drumAudioSec / drumCpuSec : Infinity;
  console.log(`\nspeed: notes ${noteSpeed.toFixed(0)}x realtime, drums ${drumSpeed.toFixed(0)}x realtime`);
  if (noteSpeed < MIN_SPEED_X_REALTIME) failures.push(`notes pipeline ${noteSpeed.toFixed(1)}x realtime < ${MIN_SPEED_X_REALTIME}x`);
  if (drumSpeed < MIN_SPEED_X_REALTIME) failures.push(`drum pipeline ${drumSpeed.toFixed(1)}x realtime < ${MIN_SPEED_X_REALTIME}x`);

  if (failures.length) {
    console.log('\nFAIL');
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log('\nPASS');
  return 0;
}

if (import.meta.main) process.exitCode = main();
