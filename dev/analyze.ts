// [dsp] Offline analyzer: streams WAVs through the live analysis pipeline exactly as the engine does
// (512-sample blocks, frame counter from 0) and scores them against ground truth when a .json sits next to the WAV.
//
// Usage: node dev/analyze.ts [--drums] [--notes] [--verbose] [--smooth x] [files...]
//   no files  → every WAV in dev/fixtures/out/ (generated first with dev/make-fixtures.ts if missing) plus the owner's
//               real takes in dev/fixtures/real/ (local only, gitignored; reported, never gated)
//   --smooth  → cleanNotes smoothing for the "clean" stage (default DEFAULT_SMOOTHING)
//   --drums   → run the onset detector on every file (default: only beatbox* files and files whose truth has hits)
//   --notes   → run the note pipeline on every file (default: every file that is not a drum fixture)
//   --verbose → list every detection next to the truth
// Note stages: "live" = what the segmenter returns; "clean" = cleanNotes(live, smoothing) (what a take commits).
// Scoring:
//   notes: correct = snapped MIDI equal AND onset within NOTE_ONSET_TOLERANCE_SEC (nearest unmatched detection)
//   contour truth (real takes, truth.mode = 'contour'): each syllable is matched to the nearest note within
//     truth.toleranceSec; found = non-optional syllables matched, extra = notes matched to no syllable, intervals =
//     snapped steps between consecutive matched syllables within truth.intervalToleranceSt of the melody's steps
//   drums: correct = same kind AND onset within HIT_ONSET_TOLERANCE_SEC
// Exit code 1 when a threshold below fails (only files with ground truth count; stress-* fixtures, truth.gated = false,
// are reported with a * but never fail the run).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createOnsetDetector } from '../src/analysis/drums.ts';
import { createPitchTracker } from '../src/analysis/pitch.ts';
import { createSegmenter } from '../src/analysis/segment.ts';
import { snapMidi } from '../src/analysis/autotune.ts';
import { cleanNotes, DEFAULT_SMOOTHING } from '../src/analysis/clean.ts';
import type { RawHit, RawNote } from '../src/types.ts';
import { FIXTURE_OUT_DIR, makeFixtures, type ContourSyllable, type FixtureTruth, type NoteStage } from './make-fixtures.ts';
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
const NAME_COL = 30;
const REAL_DIR = join(import.meta.dirname, 'fixtures', 'real');
const DEFAULT_CONTOUR_TOLERANCE_SEC = 0.08;
const DEFAULT_INTERVAL_TOLERANCE_ST = 1;
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

/** the commit stage: cleanNotes on the live notes, treating file time as loop position (a first take) */
export function cleanStage(notes: TimedNote[], smoothing: number, durationSec: number): TimedNote[] {
  const raw = notes.map((n) => ({ pos: n.t, dur: n.dur, midi: n.midi, vel: n.vel, attack: (n as { attack?: boolean }).attack }));
  return cleanNotes(raw, smoothing, durationSec).map((n) => ({ t: n.pos, dur: n.dur, midi: n.midi, vel: n.vel, emittedAt: Infinity }));
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

export interface ContourScore {
  syllables: number;
  found: number;
  optionalFound: number;
  extra: number;
  intervals: number;
  intervalsOk: number;
}

export function scoreContour(truth: FixtureTruth, notes: TimedNote[], verbose: boolean): ContourScore {
  const syl: ContourSyllable[] = truth.syllables ?? [];
  const tol = truth.toleranceSec ?? DEFAULT_CONTOUR_TOLERANCE_SEC;
  const itol = truth.intervalToleranceSt ?? DEFAULT_INTERVAL_TOLERANCE_ST;
  // required syllables claim their notes first, optional ones take what is left
  const order = syl.map((_, i) => i).sort((a, b) => Number(!!syl[a].optional) - Number(!!syl[b].optional));
  const used = new Set<number>();
  const match = new Array<number>(syl.length).fill(-1);
  for (const i of order) {
    let best = -1;
    let bestErr = tol;
    notes.forEach((n, j) => {
      const e = Math.abs(n.t - syl[i].t);
      if (!used.has(j) && e <= bestErr) {
        best = j;
        bestErr = e;
      }
    });
    if (best >= 0) {
      used.add(best);
      match[i] = best;
    }
  }
  const s: ContourScore = { syllables: 0, found: 0, optionalFound: 0, extra: 0, intervals: 0, intervalsOk: 0 };
  let prev = -1;
  let stepSum = 0;
  syl.forEach((x, i) => {
    if (!x.optional) s.syllables++;
    if (i > 0) stepSum += x.step ?? 0;
    const j = match[i];
    let note = '      —';
    if (j >= 0) {
      if (x.optional) s.optionalFound++;
      else s.found++;
      note = `${notes[j].t.toFixed(3)} ${noteName(notes[j].midi).padEnd(4)} ${notes[j].midi.toFixed(2)}`;
      let mark = '';
      if (prev >= 0) {
        const got = snapMidi(notes[j].midi) - snapMidi(notes[match[prev]].midi);
        const ok = Math.abs(got - stepSum) <= itol;
        s.intervals++;
        if (ok) s.intervalsOk++;
        mark = `step ${String(got).padStart(3)} (want ${String(stepSum).padStart(3)})${ok ? '' : '  WRONG'}`;
      }
      if (verbose || mark.endsWith('WRONG')) console.log(`    ${String(x.phrase)} ${x.text.padEnd(8)} ${x.t.toFixed(2)}  ${note}  ${mark}`);
      prev = i;
      stepSum = 0;
    } else if (!x.optional) {
      console.log(`    ${String(x.phrase)} ${x.text.padEnd(8)} ${x.t.toFixed(2)}  MISSED`);
    }
  });
  notes.forEach((n, j) => {
    if (used.has(j)) return;
    s.extra++;
    console.log(`    EXTRA ${n.t.toFixed(3)} ${noteName(n.midi)} ${n.midi.toFixed(2)} dur ${n.dur.toFixed(3)}`);
  });
  return s;
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
  const wavs = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.wav')).sort().map((f) => join(dir, f)) : []);
  return [...wavs(FIXTURE_OUT_DIR), ...wavs(REAL_DIR)];
}

function main(): number {
  const args = process.argv.slice(2);
  const forceDrums = args.includes('--drums');
  const forceNotes = args.includes('--notes');
  const verbose = args.includes('--verbose');
  const smoothIdx = args.indexOf('--smooth');
  const smoothing = smoothIdx >= 0 ? Number(args[smoothIdx + 1]) : DEFAULT_SMOOTHING;
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--smooth'));
  const paths = files.length ? files : listDefaultFiles();

  const noteRows: string[] = [];
  const hitRows: string[] = [];
  const failures: string[] = [];
  let noteAudioSec = 0;
  let noteCpuSec = 0;
  let drumAudioSec = 0;
  let drumCpuSec = 0;
  const totals = (): { gt: number; correct: number; extra: number; onsetErrors: number[]; finalDelays: number[] } => ({ gt: 0, correct: 0, extra: 0, onsetErrors: [], finalDelays: [] });
  const sung: Record<NoteStage, ReturnType<typeof totals>> = { live: totals(), clean: totals() };
  const stress: Record<NoteStage, ReturnType<typeof totals>> = { live: totals(), clean: totals() };
  const contourRows: string[] = [];
  const allHitDelays: number[] = [];

  for (const path of paths) {
    const name = basename(path).replace(/\.wav$/i, '');
    const truth = loadTruth(path);
    const { sampleRate, samples } = readWavMono(path);
    const audioSec = samples.length / sampleRate;
    const isDrumFixture = name.startsWith('beatbox') || (truth?.hits.length ?? 0) > 0;
    const isSilence = truth !== null && truth.mode !== 'contour' && truth.notes.length === 0 && truth.hits.length === 0;
    const gated = truth?.gated !== false;
    const label = (gated ? name : `${name}*`).padEnd(NAME_COL);
    const doNotes = forceNotes || !isDrumFixture || isSilence;
    const doDrums = forceDrums || isDrumFixture || isSilence;
    console.log(`\n${name}  (${sampleRate} Hz, ${audioSec.toFixed(2)} s)${truth ? '  — ' + truth.description : ''}`);

    if (doNotes) {
      const { notes: live, seconds } = runNotes(samples, sampleRate);
      noteAudioSec += audioSec;
      noteCpuSec += seconds;
      const stages: Record<NoteStage, TimedNote[]> = { live, clean: cleanStage(live, smoothing, audioSec) };
      if (!truth) {
        for (const stage of ['live', 'clean'] as const) {
          console.log(`  ${stage}:`);
          for (const n of stages[stage]) console.log(`    note ${n.t.toFixed(3)} dur ${n.dur.toFixed(3)} midi ${n.midi.toFixed(2)} ${noteName(n.midi)} vel ${n.vel.toFixed(2)}`);
          noteRows.push(`${(label + ' ' + stage).padEnd(NAME_COL + 6)} ${'-'.padStart(4)} ${String(stages[stage].length).padStart(4)}   (no ground truth)`);
        }
      } else if (truth.mode === 'contour') {
        for (const stage of ['live', 'clean'] as const) {
          console.log(`  ${stage}${stage === 'clean' ? ` (smoothing ${smoothing})` : ''}:`);
          const c = scoreContour(truth, stages[stage], verbose);
          contourRows.push(
            `${(label + ' ' + stage).padEnd(NAME_COL + 6)} syllables ${c.found}/${c.syllables} (+${c.optionalFound} optional)  extra ${c.extra}  notes ${stages[stage].length}  intervals ${c.intervalsOk}/${c.intervals}`,
          );
        }
      } else {
        const gateStages = truth.gateStages ?? ['live', 'clean'];
        for (const stage of ['live', 'clean'] as const) {
          if (verbose) console.log(`  ${stage}:`);
          const s = scoreNotes(truth.notes, stages[stage], verbose);
          const bucket = truth.notes.length > 0 && gated && gateStages.includes(stage) ? sung[stage] : truth.notes.length > 0 ? stress[stage] : null;
          if (bucket) {
            bucket.gt += s.gt;
            bucket.correct += s.correct;
            bucket.extra += s.extra;
            bucket.onsetErrors.push(...s.onsetErrors);
            bucket.finalDelays.push(...s.finalDelays);
          } else if (truth.notes.length === 0 && stages[stage].length > 0 && gated) {
            failures.push(`${name} ${stage}: ${stages[stage].length} notes on a fixture that must yield none`);
          }
          const ungatedStage = gated && truth.notes.length > 0 && !gateStages.includes(stage);
          noteRows.push(
            [
              `${label.trimEnd()}${ungatedStage ? '*' : ''} ${stage}`.padEnd(NAME_COL + 6),
              String(s.gt).padStart(4),
              String(s.det).padStart(4),
              String(s.correct).padStart(5),
              (s.gt ? pct(s.correct / s.gt) : '-').padStart(7),
              `${ms(mean(s.onsetErrors))}/${ms(maxOf(s.onsetErrors))}`.padStart(11),
              String(s.extra).padStart(5),
              String(s.missed).padStart(6),
              String(s.wrongPitch).padStart(6),
              (stage === 'live' ? `${ms(percentile(s.finalDelays, 0.95))}/${ms(maxOf(s.finalDelays))}` : '-').padStart(13),
              (stage === 'live' ? `${(audioSec / seconds).toFixed(0)}x` : '').padStart(6),
            ].join(' '),
          );
        }
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
    console.log('fixture  stage'.padEnd(NAME_COL + 6) + '   gt  det    ok       %  onset ms mean/max  extra missed pitch  final ms p95/max  speed');
    for (const r of noteRows) console.log(r);
    for (const stage of ['live', 'clean'] as const) {
      const t = sung[stage];
      if (t.gt === 0) continue;
      const acc = t.correct / t.gt;
      const meanErr = mean(t.onsetErrors);
      console.log(
        `sung total ${stage}: ${t.correct}/${t.gt} = ${pct(acc)} correct, ${t.extra} extra, onset error mean ${ms(meanErr)} ms max ${ms(maxOf(t.onsetErrors))} ms` +
          (stage === 'live' ? `, finalisation delay after note end p95 ${ms(percentile(t.finalDelays, 0.95))} ms max ${ms(maxOf(t.finalDelays))} ms` : ` (smoothing ${smoothing})`),
      );
      if (acc < MIN_NOTE_ACCURACY) failures.push(`notes ${stage}: ${pct(acc)} correct < ${pct(MIN_NOTE_ACCURACY)}`);
      if (meanErr >= MAX_MEAN_ONSET_ERROR_SEC) failures.push(`notes ${stage}: mean onset error ${ms(meanErr)} ms >= ${ms(MAX_MEAN_ONSET_ERROR_SEC)} ms`);
    }
    for (const stage of ['live', 'clean'] as const) {
      const t = stress[stage];
      if (t.gt === 0) continue;
      console.log(`stress / ungated ${stage}: ${t.correct}/${t.gt} = ${pct(t.correct / t.gt)} correct, ${t.extra} extra, onset error mean ${ms(mean(t.onsetErrors))} ms max ${ms(maxOf(t.onsetErrors))} ms`);
    }
  }
  if (contourRows.length) {
    console.log('\nREAL TAKES (contour truth, not gated)');
    for (const r of contourRows) console.log(r);
  }
  if (hitRows.length) {
    console.log('\nDRUMS');
    console.log('fixture'.padEnd(NAME_COL) + '   gt  det    ok       %  onset ms mean/max  extra missed  kind  final ms max  speed  confusions');
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
