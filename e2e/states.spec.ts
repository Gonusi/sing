// [tester] Round 4 state-table walk (src/app/controller.ts header: transport table). Real dsp + voices.
// Each step asserts state, `accepted`, the session shape and the take / error / countIn log events it must produce.
// Voice commands map onto the transport: record = record, stop = pause, play = play (from the playhead).
import { expect, test, type Page } from '@playwright/test';
import type { Command, LogEvent, TransportAction } from '../src/types.ts';
import { boot, getLog, getSession, getState, groundTruth, matchNotes, maxAbs, ms, putFixtures, scheds } from './helpers.ts';

const cmd = (page: Page, c: Command): Promise<boolean | null> => page.evaluate((c) => window.__sing!.command(c), c);
const tp = (page: Page, a: TransportAction): Promise<boolean> => page.evaluate((a) => window.__sing!.transport(a), a);
const since = (page: Page, t: number): Promise<LogEvent[]> => page.evaluate((t) => window.__sing!.logSince(t), t);
const now = (page: Page): Promise<number> => page.evaluate(() => window.__sing!.now());
const takeEvents = (log: LogEvent[]) => log.filter((e) => e.type === 'take').map((e) => `${e.data?.phase}${e.data?.reason ? `:${e.data.reason}` : ''}`);
const errorsIn = (log: LogEvent[]) => log.filter((e) => e.type === 'error').map((e) => String(e.data?.message));
/** record → count-in; returns the downbeat D (the take's start) */
const recordD = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const s = window.__sing!;
    const t = s.now();
    if (!s.transport('record', t)) throw new Error(`record refused in ${s.state()}`);
    return Number(s.logSince(t).find((e) => e.type === 'countIn')!.data!.D);
  });

/** 80 bpm 4/4: one bar = 3.0 s */
const BPM = 80;
const BAR = 3.0;

test('state table walk (round 4 transport)', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  await putFixtures(page, ['sing-cmaj', 'sing-high']);
  expect(await page.evaluate((b) => window.__sing!.setTempo(b), BPM)).toBe(true);
  const inLat = await page.evaluate(() => window.__sing!.device().inLat);

  await test.step('idle: play / pause / toStart / undo / seek refused; a tap does nothing', async () => {
    expect(await tp(page, 'play')).toBe(false);
    expect(await tp(page, 'pause')).toBe(false);
    expect(await tp(page, 'toStart')).toBe(false);
    expect(await cmd(page, { type: 'undo' })).toBe(false);
    expect(await page.evaluate(() => window.__sing!.seek(1))).toBe(false);
    await page.evaluate(() => window.__sing!.gesture({ type: 'tap', tDown: window.__sing!.now() }));
    expect(await getState(page)).toBe('idle');
    expect((await getSession(page)).tracks).toEqual([]);
  });

  await test.step('idle → record → countIn (lane exists); record again cancels → idle, lane gone', async () => {
    const t = await now(page);
    const D = await recordD(page);
    expect(await getState(page)).toBe('countIn');
    const ci = (await since(page, t)).find((e) => e.type === 'countIn')!.data!;
    expect(D - Number(ci.c0)).toBeCloseTo(BAR, 6);
    expect((await getSession(page)).tracks.map((x) => x.kind)).toEqual(['synth']);
    expect(await page.evaluate(() => window.__sing!.view().countIn)).toBe(4);
    expect(await tp(page, 'record')).toBe(true);
    expect(await getState(page)).toBe('idle');
    expect((await getSession(page)).tracks).toEqual([]);
    expect(takeEvents(await since(page, t))).toEqual(['start', 'discard:count-in cancelled']);
  });

  await test.step('countIn: undo / pause cancel too; recordingFirst: undo discards → idle', async () => {
    await recordD(page);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('idle');
    await recordD(page);
    expect(await tp(page, 'pause')).toBe(true);
    expect(await getState(page)).toBe('idle');
    const D = await recordD(page);
    await page.evaluate((t) => window.__sing!.waitUntil(t), D + 0.2);
    expect(await getState(page)).toBe('recordingFirst');
    expect(await page.evaluate(() => window.__sing!.view().countIn)).toBeNull();
    expect(await cmd(page, { type: 'play' })).toBe(false);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('idle');
    expect((await getSession(page)).tracks).toEqual([]);
  });

  let violinId = '';
  await test.step('create violin; record → count-in → sing → record at 1.2 bars → L = 1 bar, notes after L clipped', async () => {
    expect(await cmd(page, { type: 'create', kind: 'violin' })).toBe(true);
    violinId = (await getSession(page)).tracks[0].id;
    const r = await page.evaluate(async (BAR) => {
      const s = window.__sing!;
      const t = s.now();
      s.transport('record', t);
      const D = Number(s.logSince(t).find((e) => e.type === 'countIn')!.data!.D);
      const at = await s.mic.play('/__fixtures/sing-cmaj.wav', D + 0.1, { dur: 4.0 });
      await s.waitUntil(D + 1.2 * BAR + 0.1);
      const ok = s.transport('record', D + 1.2 * BAR);
      return { D, at, ok };
    }, BAR);
    expect(r.ok).toBe(true);
    expect(await getState(page)).toBe('playing');
    const s = await getSession(page);
    expect(s.tracks.map((x) => x.id)).toEqual([violinId]);
    expect(s.loopLength).toBeCloseTo(BAR, 6);
    // sing-cmaj notes that start inside the first bar (pos < L); the one open at L is cut there
    const gt = groundTruth('sing-cmaj').notes.filter((n) => r.at - r.D + n.t - inLat < BAR - 0.08);
    const notes = s.tracks[0].take!.notes;
    const m = matchNotes(notes.map((n) => ({ t: n.pos, midi: n.midi })), gt.map((n) => ({ t: r.at - r.D + n.t - inLat, midi: n.midi + 12 })), 0.03);
    console.log(`[states] violin first take: ${m.matched}/${m.expected} (register +12), max err ${ms(maxAbs(m.errors))} ${m.missed.join(' ')} ${m.wrongPitch.join(' ')}`);
    expect(m.matched).toBe(m.expected);
    expect(notes.every((n) => n.pos + n.dur <= BAR + 1e-6)).toBe(true);
  });

  await test.step('playing: play refused; pause → stopped at the heard position; pause refused; play resumes there', async () => {
    expect(await tp(page, 'play')).toBe(false);
    const t = await now(page);
    expect(await tp(page, 'pause')).toBe(true);
    expect(await getState(page)).toBe('stopped');
    expect(await tp(page, 'pause')).toBe(false);
    const P = await page.evaluate(() => window.__sing!.view().playhead!);
    expect(P).toBeGreaterThanOrEqual(0);
    await page.evaluate(() => window.__sing!.waitUntil(window.__sing!.now() + 0.5));
    expect(await page.evaluate(() => window.__sing!.view().playhead)).toBeCloseTo(P, 9);
    expect(await cmd(page, { type: 'play' })).toBe(true); // voice play = transport play
    expect(await getState(page)).toBe('playing');
    const start = (await since(page, t)).filter((e) => e.type === 'transport' && e.data?.action === 'start').pop()!.data!;
    const resumedAt = ((Number(start.from) - Number(start.origin)) % BAR + BAR) % BAR;
    console.log(`[states] paused at ${P.toFixed(4)}, resumed from ${resumedAt.toFixed(4)}`);
    expect(resumedAt).toBeCloseTo(P, 3);
  });

  await test.step('overdubbing: create refused (error log); undo discards → playing', async () => {
    const t = await now(page);
    expect(await tp(page, 'record')).toBe(true); // punch in now
    expect(await getState(page)).toBe('overdubbing');
    expect((await getSession(page)).tracks.map((x) => x.kind)).toEqual(['violin', 'violin']);
    expect(await cmd(page, { type: 'create', kind: 'synth' })).toBe(false);
    expect(errorsIn(await since(page, t))).toEqual(['create while overdubbing']);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('playing');
    expect((await getSession(page)).tracks.map((x) => x.id)).toEqual([violinId]);
    expect(takeEvents(await since(page, t))).toEqual(['start', 'discard:discarded']);
  });

  await test.step('punch in → sing → record again = punch out (commit so far, keep playing); undo removes it', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const ts = s.now();
      const at = await s.mic.play('/__fixtures/sing-high.wav', ts + 0.1, { dur: 1.4 });
      s.transport('record', ts);
      await s.waitUntil(ts + 1.9);
      const tOut = s.now();
      s.transport('record', tOut);
      return { ts, at, tOut };
    });
    expect(await getState(page)).toBe('playing');
    const s = await getSession(page);
    expect(s.tracks).toHaveLength(2);
    expect(s.tracks[1].take!.notes.map((n) => n.midi)).toEqual([69, 71]);
    const ev = (await since(page, r.ts)).filter((e) => e.type === 'take' && e.data?.phase === 'commit');
    expect(ev).toHaveLength(1);
    expect(Number(ev[0].data!.end)).toBeCloseTo(r.tOut, 6);
    expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect((await getSession(page)).tracks.map((x) => x.id)).toEqual([violinId]);
    expect(await getState(page)).toBe('playing');
  });

  await test.step('stopped at 0 → record → count-in → overdub of exactly one cycle from the playhead → commit', async () => {
    expect(await cmd(page, { type: 'stop' })).toBe(true); // voice stop = pause
    expect(await tp(page, 'toStart')).toBe(true);
    expect(await page.evaluate(() => window.__sing!.view().playhead)).toBe(0);
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const t = s.now();
      s.transport('record', t);
      const D = Number(s.logSince(t).find((e) => e.type === 'countIn')!.data!.D);
      const st = s.logSince(t).find((e) => e.type === 'transport' && e.data?.action === 'start')!.data!;
      const at = await s.mic.play('/__fixtures/sing-high.wav', D + 0.05, { dur: 2.4 });
      for (let i = 0; i < 200; i++) {
        if (s.logSince(t).some((e) => e.type === 'take' && e.data?.phase === 'commit')) break;
        await s.waitUntil(s.now() + 0.05);
      }
      return { t, D, origin: Number(st.origin), from: Number(st.from), at, L: s.session().loopLength!, state: s.state() };
    });
    expect(r.state).toBe('playing');
    expect(r.origin).toBeCloseTo(r.D, 9); // playback begins exactly at the downbeat, at pos 0
    expect(r.from).toBeCloseTo(r.D, 9);
    const log = await since(page, r.t);
    expect(Number(log.find((e) => e.type === 'take' && e.data?.phase === 'start')!.data!.start)).toBeCloseTo(r.D, 9);
    const commit = log.find((e) => e.type === 'take' && e.data?.phase === 'commit')!;
    expect(Number(commit.data!.end)).toBeCloseTo(r.D + r.L, 6);
    const lane = (await getSession(page)).tracks.find((x) => x.id === commit.data!.trackId)!;
    const gt = groundTruth('sing-high').notes.filter((n) => n.t + n.dur <= 2.4);
    const m = matchNotes(lane.take!.notes.map((n) => ({ t: n.pos, midi: n.midi })), gt.map((n) => ({ t: r.at - r.D + n.t - inLat, midi: n.midi })), 0.03);
    console.log(`[states] one-cycle overdub from stopped: ${m.matched}/${m.expected}, max err ${ms(maxAbs(m.errors))} ${m.missed.join(' ')} ${m.wrongPitch.join(' ')}`);
    expect(m.matched).toBe(m.expected);
  });

  await test.step('mute violin (voice) silences every violin lane; violin back brings them back', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__sing!;
      const tOff = s.now();
      const off = s.voice.inject('mute violin');
      const offOn = s.session().tracks.map((t) => t.on);
      await s.waitUntil(tOff + 2.5);
      const tOn = s.now();
      const on = s.voice.inject('violin back');
      await s.waitUntil(tOn + 2 * s.session().loopLength!);
      return { tOff, tOn, off, on, offOn, onOn: s.session().tracks.map((t) => t.on) };
    });
    expect(r.off).toBe(true);
    expect(r.on).toBe(true);
    expect(r.offOn).toEqual([false, false]);
    expect(r.onOn).toEqual([true, true]);
    const log = await getLog(page);
    const outLat = await page.evaluate(() => window.__sing!.outLat());
    // nothing STARTS while muted (switching back on catches up a note still sounding: heard before tOn, at ≥ tOn)
    expect(scheds(log).filter((s) => s.heard >= r.tOff + 0.12 + outLat + 0.02 && s.at < r.tOn)).toEqual([]);
    expect(new Set(scheds(log).filter((s) => s.heard >= r.tOn).map((s) => s.trackId)).size).toBe(2);
  });

  await test.step('seek: playing → jump to the snapped beat; stopped → new resume position', async () => {
    const beat = 60 / BPM;
    const t = await now(page);
    expect(await page.evaluate((p) => window.__sing!.seek(p), 1.3 * beat)).toBe(true);
    const sk = (await since(page, t)).find((e) => e.type === 'seek')!.data!;
    expect(Number(sk.to)).toBeCloseTo(beat, 6);
    const ph = await page.evaluate(() => window.__sing!.view().playhead!);
    expect(ph).toBeGreaterThan(beat - 0.05);
    expect(ph).toBeLessThan(beat + 0.25);
    expect(await tp(page, 'pause')).toBe(true);
    expect(await page.evaluate((p) => window.__sing!.seek(p), 2.6 * beat)).toBe(true);
    expect(await page.evaluate(() => window.__sing!.view().playhead!)).toBeCloseTo(3 * beat, 6);
  });

  await test.step('undo in stopped pops back to idle', async () => {
    for (let i = 0; i < 10 && (await getState(page)) !== 'idle'; i++) expect(await cmd(page, { type: 'undo' })).toBe(true);
    expect(await getState(page)).toBe('idle');
    expect((await getSession(page)).loopLength).toBeNull();
  });
  expect(errors, errors.join('\n')).toEqual([]);
});
