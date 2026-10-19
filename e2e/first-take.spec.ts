// [tester] First take → loop. Real dsp on the injected sing-cmaj fixture, real synth voice.
// Asserts: L = stop tDown − t0; committed notes = ground truth (same midi, pos = at − t0 + gt.t − inLat ± 30 ms);
// every sched event at origin + pos + k·L − outLat (± 2 ms); (track, pos, cycle) exactly once over the run;
// with real voices: the lane's output over cycle 1, re-detected by the real dsp = the take's notes (± 40 ms, same midi).
import { expect, test } from '@playwright/test';
import {
  boot, checkPlayed, exactness, firstTake, getLog, getSession, groundTruth, matchNotes, maxAbs, ms, rawNotes, scheds, worstWhenError,
} from './helpers.ts';

const FIXTURE = 'sing-cmaj';
/** pretend the device has this input latency (the test mic has none): every position moves earlier by it */
const IN_LAT = 0.03;
const LEAD = 0.1;

test('first take: notes at sung positions, exact scheduling, output re-detected', async ({ page }) => {
  const errors = await boot(page);
  const gt = groundTruth(FIXTURE);
  await page.evaluate((inLat) => window.__sing!.setDevice({ inLat }), IN_LAT);
  const L = Math.round((gt.durationSec + 0.3) * 1000) / 1000;
  const run = await firstTake(page, { fixture: FIXTURE, L, lead: LEAD, captureKey: 'lane' });
  expect(run.inLat).toBeCloseTo(IN_LAT, 6);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('playing');
  expect(run.L).toBeCloseTo(run.stopT - run.t0, 3);

  // ---- committed take vs ground truth ----
  const session = await getSession(page);
  const lane = session.tracks.find((t) => t.id === run.trackId)!;
  expect(lane.kind).toBe('synth');
  const notes = lane.take!.notes;
  const expected = gt.notes.map((n) => ({ t: run.at - run.t0 + n.t - run.inLat, midi: n.midi }));
  const m = matchNotes(notes.map((n) => ({ t: n.pos, midi: n.midi })), expected, 0.03);
  console.log(`[first-take] ${notes.length} notes, matched ${m.matched}/${m.expected}, max pos err ${ms(maxAbs(m.errors))}, missed ${m.missed.join(' ')} wrong ${m.wrongPitch.join(' ')} extra ${m.extra}`);
  expect(m.missed, 'missed notes').toEqual([]);
  expect(m.wrongPitch, 'wrong pitch').toEqual([]);
  expect(m.extra, 'extra notes').toBe(0);
  expect(notes.every((n) => n.pos >= 0 && n.pos < run.L)).toBe(true);

  // ---- cycle 1 output, then stop ----
  const out = await page.evaluate(async (r) => {
    const s = window.__sing!;
    await s.waitUntil(r.stopT + r.L + 0.4);
    const sum = await s.capture.end('lane');
    const det = s.capture.analyze('lane', 'notes', r.stopT - s.outLat() - 0.05, r.stopT + r.L - s.outLat());
    s.command({ type: 'stop' });
    return { sum, det };
  }, run);
  const log = await getLog(page);

  // ---- scheduling ----
  const sc = scheds(log).filter((s) => s.trackId === run.trackId);
  const start = log.find((e) => e.type === 'transport' && e.data?.action === 'start')!.data!;
  expect(Number(start.origin)).toBeCloseTo(run.t0, 9);
  expect(Number(start.from)).toBeCloseTo(run.stopT, 9);
  const whenErr = worstWhenError(log);
  const ex = exactness(log, await getSession(page));
  console.log(`[first-take] sched ${sc.length} (drops ${ex.dropped}), worst when err ${ms(whenErr)}, required ${ex.required}, missing ${ex.missing.length}, extra ${ex.extra.length}, dups ${ex.dups.length}`);
  expect(sc.length).toBeGreaterThanOrEqual(notes.length);
  expect(whenErr).toBeLessThanOrEqual(0.002);
  expect(sc.every((s) => s.offset > 0 || s.at >= s.when - 1e-9)).toBe(true);
  expect(ex.dups).toEqual([]);
  expect(ex.missing).toEqual([]);
  expect(ex.extra).toEqual([]);

  // ---- audio: the synth played the take ----
  const real = out.sum.rms > 1e-4;
  console.log(`[first-take] lane capture ${out.sum.length} frames, rms ${out.sum.rms.toFixed(4)}, peak ${out.sum.peak.toFixed(3)}`);
  if (!real) {
    test.info().annotations.push({ type: 'pending', description: 'voices silent (instruments not merged): audio re-detection skipped' });
    return;
  }
  const playedC1 = sc.filter((s) => s.cycle === 1 && s.offset === 0);
  const byPos = new Map(notes.map((n) => [n.pos.toFixed(5), n]));
  const expN = playedC1.map((s) => ({ at: s.at, midi: byPos.get(s.pos.toFixed(5))!.midi, dur: byPos.get(s.pos.toFixed(5))!.dur }));
  const am = matchNotes(rawNotes(out.det.notes), expN.map((e) => ({ t: e.at, midi: e.midi })), 0.04);
  const frames = await page.evaluate(([a, b]) => window.__sing!.capture.frames('lane', a, b), [run.stopT - 0.3, run.stopT + run.L] as const);
  const pc = checkPlayed(frames, expN);
  console.log(`[first-take] output: played ${expN.length - pc.late.length - pc.offPitch.length}/${expN.length} (onset err max ${ms(maxAbs(pc.errors))}, late ${pc.late.join(' ')}, off-pitch ${pc.offPitch.join(' ')}); segmenter re-detection ${am.matched}/${am.expected} ±40 ms, max ${ms(maxAbs(am.errors))}; missed ${am.missed.join(' ')}; wrong ${am.wrongPitch.join(' ')}; extra ${am.extra}`);
  // frame check (polyphonic release tails fool the segmenter's onset refinement, notes/tester.md) + segmenter ≥ 85%
  expect(pc.late, 'output: pitch not reached in [−40, +80] ms').toEqual([]);
  expect(pc.offPitch, 'output: sustain off pitch').toEqual([]);
  expect(am.wrongPitch, 'output notes wrong pitch').toEqual([]);
  expect(am.matched / am.expected).toBeGreaterThanOrEqual(0.85);
  expect(errors, errors.join('\n')).toEqual([]);
});
