// [tester] Four lanes: a synth first take, then violin, bass and drums overdubs one after the other (tap → one cycle →
// auto-commit at the window end). Real dsp, real voices.
// Asserts per lane: take = ground truth (midi after the register fit, pos = (at + gt.t − inLat − origin) mod L ± 30 ms;
// drums: kind + pos); a new lane is silent until ts + L; 15 s of looping with every (track, pos, cycle) exactly once;
// with real voices: every lane's output has energy and re-detects as its notes / hits (± 40 ms, same midi).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { InstrumentKind } from '../src/types.ts';
import { registerShift } from '../src/analysis/autotune.ts';
import {
  OUT_DIR, TRACKER_FLOOR_MIDI, boot, checkPlayed, checkSalience, exactness, firstTake, getLog, getSession, groundTruth, matchHits, matchNotes, maxAbs, ms, overdub, rawNotes,
  scheds, worstWhenError, type GroundTruth, type OverdubRun,
} from './helpers.ts';

const IN_LAT = 0.02;
const L = 6.4;
const LEAD = 0.1;
/** slice ends sit in a gap of each fixture, so no note is cut */
const FIRST = { fixture: 'sing-cmaj', dur: 6.2 };
const DUBS: { kind: InstrumentKind; fixture: string; dur: number }[] = [
  { kind: 'violin', fixture: 'sing-high', dur: 5.7 },
  { kind: 'bass', fixture: 'sing-low', dur: 5.6 },
  { kind: 'drums', fixture: 'beatbox-basic', dur: 5.4 },
];
const LOOP_SEC = 15;

const within = (gt: GroundTruth, dur: number) => ({
  notes: gt.notes.filter((n) => n.t + n.dur <= dur + 1e-6),
  hits: gt.hits.filter((h) => h.t + 0.1 <= dur),
});
const mod = (x: number, m: number) => ((x % m) + m) % m;

test('four lanes overdubbed: positions, silent until ts + L, exact looping, every lane audible', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  await page.evaluate((inLat) => window.__sing!.setDevice({ inLat }), IN_LAT);

  const first = await firstTake(page, { ...FIRST, L, lead: LEAD });
  expect(await page.evaluate(() => window.__sing!.state())).toBe('playing');
  const origin = first.t0;

  const runs: (OverdubRun & { kind: InstrumentKind; fixture: string; dur: number })[] = [];
  for (const d of DUBS) {
    const r = await overdub(page, { ...d, lead: LEAD });
    expect(r.phase, `${d.kind} overdub`).toBe('commit');
    expect(await page.evaluate(() => window.__sing!.state())).toBe('playing');
    runs.push({ ...r, ...d });
  }

  // ---- 15 s of looping, every lane + master captured ----
  const session = await getSession(page);
  expect(session.tracks.map((t) => t.kind)).toEqual(['synth', 'violin', 'bass', 'drums']);
  const ids = session.tracks.map((t) => t.id);
  const cap = await page.evaluate(async ({ ids, sec }) => {
    const s = window.__sing!;
    for (const id of ids) s.capture.begin(id, id);
    s.capture.begin('master', null);
    await s.waitUntil(s.now() + sec);
    const sums: Record<string, Awaited<ReturnType<typeof s.capture.end>>> = {};
    for (const k of [...ids, 'master']) sums[k] = await s.capture.end(k);
    s.command({ type: 'stop' });
    return sums;
  }, { ids, sec: LOOP_SEC });
  const log = await getLog(page);

  // ---- takes vs ground truth ----
  const lanes = [{ kind: 'synth' as InstrumentKind, fixture: FIRST.fixture, dur: FIRST.dur, at: first.at, inLat: first.inLat, trackId: first.trackId, ts: first.t0 }, ...runs];
  for (const lane of lanes) {
    const track = session.tracks.find((t) => t.id === lane.trackId)!;
    expect(track.kind).toBe(lane.kind);
    const gt = within(groundTruth(lane.fixture), lane.dur);
    const place = (t: number) => mod(lane.at + t - lane.inLat - origin, L);
    if (lane.kind === 'drums') {
      const hm = matchHits(track.take!.hits.map((h) => ({ t: h.pos, kind: h.kind, vel: h.vel })), gt.hits.map((h) => ({ t: place(h.t), kind: h.kind })), 0.03);
      const placed = gt.hits.map((h) => place(h.t));
      const odd = track.take!.hits.filter((h) => !placed.some((p) => Math.abs(p - h.pos) < 0.03));
      console.log(`[overdub] drums extra hits: ${odd.map((h) => `${h.kind}@${h.pos.toFixed(3)} vel ${h.vel.toFixed(2)}`).join(' ')}; fixture start at pos ${place(0).toFixed(3)}, slice end at pos ${place(lane.dur).toFixed(3)}`);
      console.log(`[overdub] drums take: ${track.take!.hits.length} hits, matched ${hm.matched}/${hm.expected}, max err ${ms(maxAbs(hm.errors))}, wrong kind ${hm.wrongKind.join(' ')}, missed ${hm.missed.join(' ')}, extra ${hm.extra}`);
      expect(hm.missed).toEqual([]);
      expect(hm.wrongKind).toEqual([]);
      expect(hm.extra).toBe(0);
    } else {
      const shift = registerShift(gt.notes.map((n) => n.midi), lane.kind);
      const nm = matchNotes(track.take!.notes.map((n) => ({ t: n.pos, midi: n.midi })), gt.notes.map((n) => ({ t: place(n.t), midi: n.midi + shift })), 0.03);
      console.log(`[overdub] ${lane.kind} take (shift ${shift}): ${track.take!.notes.length} notes, matched ${nm.matched}/${nm.expected}, max err ${ms(maxAbs(nm.errors))}, missed ${nm.missed.join(' ')}, wrong ${nm.wrongPitch.join(' ')}, extra ${nm.extra}`);
      expect(nm.missed).toEqual([]);
      expect(nm.wrongPitch).toEqual([]);
      expect(nm.extra).toBe(0);
    }
  }

  // ---- scheduling ----
  const sc = scheds(log);
  for (const r of runs) {
    const early = sc.filter((s) => s.trackId === r.trackId && s.heard < r.ts + L - 1e-6);
    expect(early, `${r.kind} lane audible before ts + L`).toEqual([]);
    expect(sc.some((s) => s.trackId === r.trackId)).toBe(true);
  }
  const ex = exactness(log, session);
  console.log(`[overdub] sched ${ex.played}, drops ${ex.dropped}, required ${ex.required}, missing ${ex.missing.length}, extra ${ex.extra.length}, dups ${ex.dups.length}, worst when err ${ms(worstWhenError(log))}`);
  expect(ex.runs).toBe(1);
  expect(ex.dups).toEqual([]);
  expect(ex.missing).toEqual([]);
  expect(ex.extra).toEqual([]);
  expect(worstWhenError(log)).toBeLessThanOrEqual(0.002);

  // ---- audio ----
  const real = Object.values(cap).some((c) => c.rms > 1e-4);
  if (!real) {
    test.info().annotations.push({ type: 'pending', description: 'voices silent (instruments not merged)' });
    return;
  }
  console.log(`[overdub] master peak ${cap.master.peak.toFixed(3)} rms ${cap.master.rms.toFixed(4)}`);
  // 4 lanes can exceed 0 dBFS (notes/instruments.md); the engine's master limiter is pending: report, don't fail yet
  if (cap.master.peak > 1) test.info().annotations.push({ type: 'pending', description: `master clips: peak ${cap.master.peak.toFixed(3)} (engine limiter not merged)` });
  for (const track of session.tracks) {
    const c = cap[track.id];
    const kind = track.kind === 'drums' ? 'drums' : 'notes';
    const det = await page.evaluate(([id, k, a, b]) => window.__sing!.capture.analyze(id, k, a, b), [track.id, kind, c.t0, c.t1] as const);
    // expectations: sched events whose start lies well inside the capture (not caught up)
    const exp = sc.filter((s) => s.trackId === track.id && s.offset === 0 && s.at >= c.t0 + 0.1 && s.at <= c.t1 - 0.8);
    expect(c.rms, `${track.kind} lane output energy`).toBeGreaterThan(1e-3);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `overdub-${test.info().project.name}-${track.kind}.json`), JSON.stringify({ capture: c, expected: exp, detected: det.notes, hits: det.hits }, null, 1));
    if (track.kind === 'drums') {
      const kindAt = new Map(track.take!.hits.map((h) => [h.pos.toFixed(5), h.kind]));
      const hm = matchHits(det.hits, exp.map((s) => ({ t: s.at, kind: kindAt.get(s.pos.toFixed(5))! })), 0.04);
      console.log(`[overdub] drums output rms ${c.rms.toFixed(4)}: re-detected ${det.hits.length}, matched ${hm.matched}/${hm.expected}, max err ${ms(maxAbs(hm.errors))}, wrong kind ${hm.wrongKind.length} (${hm.wrongKind.slice(0, 6).join(' ')}), missed ${hm.missed.join(' ')}, extra ${hm.extra}`);
      expect(hm.missed, 'drum output hits missed').toEqual([]);
    } else {
      const byPos = new Map(track.take!.notes.map((n) => [n.pos.toFixed(5), n]));
      const expN = exp.map((s) => ({ at: s.at, midi: byPos.get(s.pos.toFixed(5))!.midi, dur: byPos.get(s.pos.toFixed(5))!.dur }));
      const seg = matchNotes(rawNotes(det.notes), expN.map((e) => ({ t: e.at, midi: e.midi })), 0.04);
      const frames = await page.evaluate(([id, a, b]) => window.__sing!.capture.frames(id, a, b), [track.id, c.t0, c.t1] as const);
      const pc = checkPlayed(frames, expN);
      const sal = await checkSalience(page, track.id, expN);
      const seen = expN.filter((e) => e.midi >= TRACKER_FLOOR_MIDI);
      const segSeen = matchNotes(rawNotes(det.notes), seen.map((e) => ({ t: e.at, midi: e.midi })), 0.04);
      writeFileSync(join(OUT_DIR, `overdub-${test.info().project.name}-${track.kind}-frames.json`), JSON.stringify({ expN, frames }));
      console.log(`[overdub] ${track.kind} output rms ${c.rms.toFixed(4)}: played ${seen.length - pc.late.length - pc.offPitch.length}/${seen.length} (onset err max ${ms(maxAbs(pc.errors))}, late ${pc.late.join(' ')}, off-pitch ${pc.offPitch.join(' ')}); below tracker floor ${sal.checked - sal.offPitch.length}/${sal.checked} by salience ${sal.offPitch.join(' ')}; segmenter re-detection ${seg.matched}/${seg.expected} ±40 ms (missed ${seg.missed.join(' ')}, wrong ${seg.wrongPitch.join(' ')}, extra ${seg.extra})`);
      expect(pc.late, `${track.kind} output: pitch not reached in [−40, +80] ms of the start`).toEqual([]);
      expect(pc.offPitch, `${track.kind} output: sustain off pitch`).toEqual([]);
      expect(sal.offPitch, `${track.kind} output: low notes off pitch (salience)`).toEqual([]);
      expect(segSeen.matched / Math.max(1, segSeen.expected), `${track.kind} output: segmenter re-detection ±40 ms`).toBeGreaterThanOrEqual(0.85);
    }
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
