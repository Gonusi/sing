// [tester] State-table walk (PLAN.md "State machine", notes/engine.md "State table as implemented"), real dsp + voices.
// Each step asserts state, `accepted`, the session shape and the take/error log events it must produce.
import { expect, test, type Page } from '@playwright/test';
import type { Command, LogEvent } from '../src/types.ts';
import { boot, getLog, getSession, getState, groundTruth, matchNotes, maxAbs, ms, putFixtures, scheds } from './helpers.ts';

const cmd = (page: Page, c: Command): Promise<boolean | null> => page.evaluate((c) => window.__sing!.command(c), c);
/** a 100 ms tap: tDown = now, delivered on release */
const tap = (page: Page): Promise<number> =>
  page.evaluate(async () => {
    const s = window.__sing!;
    const t = s.now();
    await s.waitUntil(t + 0.1);
    s.gesture({ type: 'tap', tDown: t });
    return t;
  });
const since = (page: Page, t: number): Promise<LogEvent[]> => page.evaluate((t) => window.__sing!.logSince(t), t);
const takeEvents = (log: LogEvent[]) => log.filter((e) => e.type === 'take').map((e) => `${e.data?.phase}${e.data?.reason ? `:${e.data.reason}` : ''}`);
const errorsIn = (log: LogEvent[]) => log.filter((e) => e.type === 'error').map((e) => String(e.data?.message));

test('state table walk', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  await putFixtures(page, ['sing-cmaj', 'sing-high']);
  const inLat = await page.evaluate(() => window.__sing!.device().inLat);

  await test.step('idle: play / stop ignored, undo with nothing to undo', async () => {
    expect(await cmd(page, { type: 'play' })).toBe(false);
    expect(await cmd(page, { type: 'stop' })).toBe(false);
    expect(await cmd(page, { type: 'undo' })).toBe(false);
    expect(await getState(page)).toBe('idle');
  });

  await test.step('idle → tap → recordingFirst (new synth lane); record / play ignored; undo → idle, lane gone', async () => {
    const t = await tap(page);
    expect(await getState(page)).toBe('recordingFirst');
    const s = await getSession(page);
    expect(s.tracks.map((x) => x.kind)).toEqual(['synth']);
    expect(s.selectedId).toBe(s.tracks[0].id);
    expect(await cmd(page, { type: 'record' })).toBe(false);
    expect(await cmd(page, { type: 'play' })).toBe(false);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('idle');
    expect((await getSession(page)).tracks).toEqual([]);
    expect(takeEvents(await since(page, t))).toEqual(['start', 'discard:discarded']);
  });

  await test.step('first take shorter than 1 s → discarded → idle', async () => {
    const t = await tap(page);
    await page.evaluate((t) => window.__sing!.waitUntil(t + 0.5), t);
    await tap(page);
    expect(await getState(page)).toBe('idle');
    expect((await getSession(page)).tracks).toEqual([]);
    // the controller logs the discard twice ('too-short' from finishFirstTake, then 'discarded' from discardTake):
    // cosmetic, noted in notes/tester.md
    expect(takeEvents(await since(page, t)).slice(0, 2)).toEqual(['start', 'discard:too-short']);
  });

  let L = 0;
  let violinId = '';
  await test.step('create violin → selected empty lane; tap records into it; stop command → playing', async () => {
    expect(await cmd(page, { type: 'create', kind: 'violin' })).toBe(true);
    let s = await getSession(page);
    expect(s.tracks.map((x) => x.kind)).toEqual(['violin']);
    violinId = s.tracks[0].id;
    expect(s.selectedId).toBe(violinId);
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const t0 = s.now();
      const at = await s.mic.play('/__fixtures/sing-cmaj.wav', t0 + 0.1, { dur: 2.6 });
      await s.waitUntil(t0 + 0.1);
      s.gesture({ type: 'tap', tDown: t0 });
      await s.waitUntil(t0 + 3.0);
      const ok = s.command({ type: 'stop' }, t0 + 3.0);
      return { t0, at, ok };
    });
    expect(r.ok).toBe(true);
    expect(await getState(page)).toBe('playing');
    s = await getSession(page);
    expect(s.tracks).toHaveLength(1);
    L = s.loopLength!;
    expect(L).toBeCloseTo(3.0, 3);
    const gt = groundTruth('sing-cmaj').notes.filter((n) => n.t + n.dur <= 2.6);
    const m = matchNotes(s.tracks[0].take!.notes.map((n) => ({ t: n.pos, midi: n.midi })), gt.map((n) => ({ t: r.at - r.t0 + n.t - inLat, midi: n.midi + 12 })), 0.03);
    console.log(`[states] violin first take: ${m.matched}/${m.expected} (register +12), max err ${ms(maxAbs(m.errors))} ${m.missed.join(' ')} ${m.wrongPitch.join(' ')}`);
    expect(m.matched).toBe(m.expected);
  });

  await test.step('playing: play ignored; stop → stopped; stop ignored', async () => {
    expect(await cmd(page, { type: 'play' })).toBe(false);
    expect(await cmd(page, { type: 'stop' })).toBe(true);
    expect(await getState(page)).toBe('stopped');
    expect(await cmd(page, { type: 'stop' })).toBe(false);
    expect(await cmd(page, { type: 'record' }).then(() => getState(page))).toBe('overdubbing');
    // record in stopped = playing + overdubbing from origin (now + outLat + 0.03); undo after origin discards it
    // (an undo with tDown before origin is the bug in bugs.spec.ts)
    await page.evaluate(() => window.__sing!.waitUntil(window.__sing!.now() + 0.15));
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('playing');
    expect(await cmd(page, { type: 'stop' })).toBe(true);
  });

  await test.step('stopped → tap → playing, origin = now + outLat + 0.03, pos 0 never late', async () => {
    const t = await tap(page);
    expect(await getState(page)).toBe('playing');
    const ev = (await since(page, t)).find((e) => e.type === 'transport' && e.data?.action === 'start')!;
    const outLat = await page.evaluate(() => window.__sing!.outLat());
    expect(Number(ev.data!.origin) - ev.t).toBeCloseTo(outLat + 0.03, 3);
    await page.evaluate((t) => window.__sing!.waitUntil(t + 1), t);
    const late = (await since(page, t)).filter((e) => e.type === 'drop' || (e.type === 'sched' && Number(e.data?.offset) > 0));
    expect(late).toEqual([]);
  });

  await test.step('overdubbing: create / record refused with error log; undo discards → playing', async () => {
    const t = await tap(page);
    expect(await getState(page)).toBe('overdubbing');
    // the selected lane has a take → a NEW violin lane is recorded
    let s = await getSession(page);
    expect(s.tracks.map((x) => x.kind)).toEqual(['violin', 'violin']);
    expect(await cmd(page, { type: 'create', kind: 'synth' })).toBe(false);
    expect(await cmd(page, { type: 'record' })).toBe(false);
    expect(errorsIn(await since(page, t))).toEqual(['create while overdubbing', 'record while overdubbing']);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('playing');
    s = await getSession(page);
    expect(s.tracks.map((x) => x.id)).toEqual([violinId]);
    expect(takeEvents(await since(page, t))).toEqual(['start', 'discard:discarded']);
  });

  await test.step('playing → record → sing → tap commits so far → playing; undo removes that lane', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const ts = s.now();
      const at = await s.mic.play('/__fixtures/sing-high.wav', ts + 0.1, { dur: 1.4 });
      s.command({ type: 'record' }, ts);
      await s.waitUntil(ts + 1.9);
      const t = s.now();
      await s.waitUntil(t + 0.1);
      s.gesture({ type: 'tap', tDown: t });
      return { ts, at, tap: t };
    });
    expect(await getState(page)).toBe('playing');
    const s = await getSession(page);
    expect(s.tracks).toHaveLength(2);
    const lane = s.tracks[1];
    // sing-high's first 1.4 s hold two whole notes (A4, B4)
    expect(lane.take!.notes.map((n) => n.midi)).toEqual([69, 71]);
    const ev = (await since(page, r.ts)).filter((e) => e.type === 'take' && e.data?.phase === 'commit');
    expect(ev).toHaveLength(1);
    expect(Number(ev[0].data!.end)).toBeCloseTo(r.tap, 6);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect((await getSession(page)).tracks.map((x) => x.id)).toEqual([violinId]);
    expect(await getState(page)).toBe('playing');
  });

  await test.step('stopped → record = playing + overdub of exactly one cycle from pos 0 → window-end commit', async () => {
    expect(await cmd(page, { type: 'stop' })).toBe(true);
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const t = s.now();
      s.command({ type: 'record' }, t);
      const start = s.logSince(t).find((e) => e.type === 'transport' && e.data?.action === 'start')!;
      const origin = Number(start.data!.origin);
      const at = await s.mic.play('/__fixtures/sing-high.wav', origin + 0.05, { dur: 2.4 });
      const L = s.session().loopLength!;
      for (let i = 0; i < 200; i++) {
        if (s.logSince(t).some((e) => e.type === 'take' && e.data?.phase === 'commit')) break;
        await s.waitUntil(s.now() + 0.05);
      }
      return { t, origin, at, L, state: s.state() };
    });
    expect(r.state).toBe('playing');
    const log = await since(page, r.t);
    const start = log.find((e) => e.type === 'take' && e.data?.phase === 'start')!;
    expect(Number(start.data!.start)).toBeCloseTo(r.origin, 9);
    const commit = log.find((e) => e.type === 'take' && e.data?.phase === 'commit')!;
    expect(Number(commit.data!.end)).toBeCloseTo(r.origin + r.L, 6);
    const lane = (await getSession(page)).tracks.find((x) => x.id === commit.data!.trackId)!;
    const gt = groundTruth('sing-high').notes.filter((n) => n.t + n.dur <= 2.4);
    const m = matchNotes(lane.take!.notes.map((n) => ({ t: n.pos, midi: n.midi })), gt.map((n) => ({ t: r.at - r.origin + n.t - inLat, midi: n.midi })), 0.03);
    console.log(`[states] one-cycle overdub from stopped: ${m.matched}/${m.expected}, max err ${ms(maxAbs(m.errors))} ${m.missed.join(' ')} ${m.wrongPitch.join(' ')}`);
    expect(m.matched).toBe(m.expected);
  });

  await test.step('violin off (voice) silences every violin lane; violin on brings them back', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const tOff = s.now();
      const off = s.voice.inject('violin off');
      const offSession = s.session();
      await s.waitUntil(tOff + 2.5);
      const tOn = s.now();
      const on = s.voice.inject('violin on');
      await s.waitUntil(tOn + 2 * s.session().loopLength!);
      return { tOff, tOn, off, on, offOn: offSession.tracks.map((t) => t.on), onOn: s.session().tracks.map((t) => t.on) };
    });
    expect(r.off).toBe(true);
    expect(r.on).toBe(true);
    expect(r.offOn).toEqual([false, false]);
    expect(r.onOn).toEqual([true, true]);
    const log = await getLog(page);
    const outLat = await page.evaluate(() => window.__sing!.outLat());
    // nothing newly scheduled while off (beyond what was already inside the look-ahead at the toggle)
    const whileOff = scheds(log).filter((s) => s.heard >= r.tOff + 0.12 + outLat + 0.02 && s.heard < r.tOn);
    expect(whileOff).toEqual([]);
    const afterOn = scheds(log).filter((s) => s.heard >= r.tOn);
    expect(new Set(afterOn.map((s) => s.trackId)).size).toBe(2);
  });

  await test.step('undo in stopped pops back to idle', async () => {
    expect(await cmd(page, { type: 'stop' })).toBe(true);
    for (let i = 0; i < 10 && (await getState(page)) !== 'idle'; i++) expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('idle');
    const s = await getSession(page);
    expect(s.loopLength).toBeNull();
  });
  expect(errors, errors.join('\n')).toEqual([]);
});
