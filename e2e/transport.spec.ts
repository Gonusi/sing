// [tester] Round 4 transport through the real UI (bottom bar buttons, taps on the lanes) plus the log:
// count-in = one bar of clicks on the grid, then the take from the downbeat; punch in/out while playing (keeps playing,
// the new lane plays each note from its next occurrence); pause keeps the playhead and play resumes there; ⏮ jumps
// to the start while playing; a tap on a lane seeks (snapped to the beat) and never creates a lane.
import { expect, test, type Page } from '@playwright/test';
import { boot, firstTake, getLog, getSession, putFixtures, scheds, stateWord } from './helpers.ts';

const press = (page: Page, button: 'toStart' | 'playPause' | 'record') => page.locator(`.tp-btn[data-button="${button}"]`).click();
const SPOT = { x: 230, y: 470 };

test('count-in: one bar of clicks on the grid, countdown 4→1, then recording from the downbeat; a tap creates nothing', async ({ page }) => {
  const errors = await boot(page);
  expect(await page.evaluate(() => window.__sing!.setTempo(120))).toBe(true); // beat 0.5 s, bar 2 s
  // a tap on the empty stage: no lane, no recording
  await page.mouse.click(SPOT.x, SPOT.y, { delay: 60 });
  expect(await page.evaluate(() => window.__sing!.state())).toBe('idle');
  expect((await getSession(page)).tracks).toEqual([]);
  await expect(page.locator('.toast')).toContainText('●');

  await page.evaluate(() => window.__sing!.capture.begin('m', null));
  await press(page, 'record');
  const r = await page.evaluate(async () => {
    const s = window.__sing!;
    const ci = s.log().find((e) => e.type === 'countIn')!.data!;
    const c0 = Number(ci.c0);
    const D = Number(ci.D);
    const beat = 0.5;
    const seen: (number | null)[] = [];
    const words: string[] = [];
    for (let k = 0; k < 4; k++) {
      await s.waitUntil(c0 + k * beat + 0.2);
      seen.push(s.view().countIn);
      words.push(document.querySelector('.tp-state')!.textContent ?? '');
    }
    await s.waitUntil(D + 0.05);
    const after = { state: s.state(), countIn: s.view().countIn, label: document.querySelector('.tp-btn[data-button="record"]')!.getAttribute('aria-label') };
    await s.capture.end('m');
    // the count-in bar only (the take's own first click sounds at D)
    const env = s.capture.envelope('m', c0 - s.outLat() - 0.05, D - s.outLat() - 0.02, 0.001);
    const take = s.log().find((e) => e.type === 'take' && e.data?.phase === 'start')!.data!;
    return { c0, D, seen, words, after, env, start: Number(take.start), outLat: s.outLat(), state: s.state() };
  });
  console.log(`[transport] count-in ${(r.D - r.c0).toFixed(4)} s, countdown ${r.seen.join(',')}, words ${r.words.join(' | ')}`);
  expect(r.D - r.c0).toBeCloseTo(2.0, 6);
  expect(r.seen).toEqual([4, 3, 2, 1]);
  expect(r.words).toEqual(['count-in 4', 'count-in 3', 'count-in 2', 'count-in 1']);
  expect(r.start).toBeCloseTo(r.D, 9);
  expect(r.after).toEqual({ state: 'recordingFirst', countIn: null, label: 'stop recording' });
  // 4 clicks rendered on the master at heard − outLat: envelope (1 ms) rises within 2 ms of each beat
  const clickAt = r.env.map((v, i) => ({ i, v })).filter((x, i, a) => x.v > 0.05 && (i === 0 || a[i - 1].v <= 0.05)).map((x) => x.i * 0.001 - 0.05);
  console.log(`[transport] count-in clicks at ${clickAt.map((t) => t.toFixed(3)).join(' ')} s after c0 − outLat`);
  expect(clickAt).toHaveLength(4);
  clickAt.forEach((t, k) => expect(Math.abs(t - k * 0.5)).toBeLessThanOrEqual(0.002));

  // stop recording one bar in → playing, 1 bar
  await page.evaluate((D) => window.__sing!.waitUntil(D + 2.0), r.D);
  await press(page, 'record');
  await expect(stateWord(page)).toHaveText('playing');
  expect((await getSession(page)).loopLength).toBeCloseTo(2.0, 6);
  await expect(page.locator('.tp-right')).toHaveText('1 bar');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('punch in / out while playing keeps playing; the new lane plays each note from its next occurrence', async ({ page }) => {
  const errors = await boot(page);
  await putFixtures(page, ['sing-high']);
  const first = await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  expect(await page.evaluate(() => window.__sing!.command({ type: 'create', kind: 'violin' }))).toBe(true);
  const r = await page.evaluate(async () => {
    const s = window.__sing!;
    const ts = s.now();
    await s.mic.play('/__fixtures/sing-high.wav', ts + 0.1, { dur: 1.4 }); // A4 + B4
    s.transport('record', ts);
    const lane = String(s.logSince(ts).find((e) => e.type === 'take' && e.data?.phase === 'start')!.data!.trackId);
    await s.waitUntil(ts + 1.9);
    const tOut = s.now();
    s.transport('record', tOut);
    const stateAfter = s.state();
    await s.waitUntil(ts + 2 * s.session().loopLength! + 0.3);
    return { ts, tOut, lane, stateAfter };
  });
  expect(r.stateAfter).toBe('playing');
  const log = await getLog(page);
  // no transport restart: playback just went on
  expect(log.filter((e) => e.type === 'transport' && e.t > r.ts && e.t < r.tOut + 1)).toEqual([]);
  const commit = log.find((e) => e.type === 'take' && e.data?.phase === 'commit' && e.data?.trackId === r.lane)!;
  expect(Number(commit.data!.end)).toBeCloseTo(r.tOut, 6);
  const lane = (await getSession(page)).tracks.find((t) => t.id === r.lane)!;
  expect(lane.take!.notes.map((n) => n.midi)).toEqual([69, 71]);
  const L = first.L;
  for (const n of lane.take!.notes) {
    const occ = scheds(log).filter((s) => s.trackId === r.lane && Math.abs(s.pos - n.pos) < 1e-6).sort((a, b) => a.heard - b.heard);
    expect(occ.length).toBeGreaterThan(0);
    const sung = occ[0].heard - L; // the occurrence one loop earlier = when it was sung (heard clock)
    console.log(`[transport] punched note ${n.midi}: sung at ${sung.toFixed(3)} (window ${r.ts.toFixed(3)}–${r.tOut.toFixed(3)}), first replay ${occ[0].heard.toFixed(3)}`);
    expect(sung).toBeGreaterThanOrEqual(r.ts - 1e-6);
    expect(sung).toBeLessThan(r.tOut);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('pause keeps the playhead, play resumes there; ⏮ jumps to the start while playing', async ({ page }) => {
  const errors = await boot(page);
  await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  await page.evaluate(() => window.__sing!.waitUntil(window.__sing!.now() + 1.1));
  await expect(page.locator('.tp-btn[data-button="playPause"]')).toHaveAttribute('aria-label', 'pause');
  await press(page, 'playPause');
  await expect(stateWord(page)).toHaveText('paused');
  const P = await page.evaluate(() => window.__sing!.view().playhead!);
  const posText = await page.locator('.tp-pos').textContent();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.__sing!.view().playhead)).toBeCloseTo(P, 9);
  await expect(page.locator('.tp-pos')).toHaveText(posText!);
  const t = await page.evaluate(() => window.__sing!.now());
  await press(page, 'playPause');
  await expect(stateWord(page)).toHaveText('playing');
  const L = (await getSession(page)).loopLength!;
  const st = (await page.evaluate((t) => window.__sing!.logSince(t), t)).find((e) => e.type === 'transport' && e.data?.action === 'start')!.data!;
  const resumed = (((Number(st.from) - Number(st.origin)) % L) + L) % L;
  console.log(`[transport] paused at ${P.toFixed(4)} (${posText}), resumed from ${resumed.toFixed(4)}`);
  expect(resumed).toBeCloseTo(P, 3);

  await page.evaluate(() => window.__sing!.waitUntil(window.__sing!.now() + 0.8));
  const t2 = await page.evaluate(() => window.__sing!.now());
  await press(page, 'toStart');
  const jump = (await page.evaluate((t) => window.__sing!.logSince(t), t2)).find((e) => e.type === 'seek')!.data!;
  expect(jump).toMatchObject({ to: 0, why: 'toStart', state: 'playing' });
  expect(await page.evaluate(() => window.__sing!.state())).toBe('playing');
  const ph = await page.evaluate(() => window.__sing!.view().playhead!);
  expect(ph).toBeLessThan(0.35);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a tap on a lane seeks to the nearest beat (playing and paused) and never creates a lane', async ({ page }) => {
  const errors = await boot(page);
  await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 }); // 80 bpm: beat 0.75 s, 1 bar
  const beat = 0.75;
  const tracks = (await getSession(page)).tracks.length;
  const box = (await page.locator('.lanes').boundingBox())!;
  for (const [frac, state] of [[0.55, 'playing'], [0.3, 'stopped']] as const) {
    if (state === 'stopped') await press(page, 'playPause');
    const t = await page.evaluate(() => window.__sing!.now());
    // lane body: x from the lanes area's left + 12 (margin) + 64 (strip) to its right − 12 − 12
    const x = box.x + 76 + frac * (box.width - 100);
    await page.mouse.click(x, box.y + 60, { delay: 50 });
    const sk = (await page.evaluate((t) => window.__sing!.logSince(t), t)).find((e) => e.type === 'seek')!.data!;
    const pos = Number(sk.pos);
    const to = Number(sk.to);
    console.log(`[transport] tap at ${(frac * 100).toFixed(0)}% (${state}) → pos ${pos.toFixed(3)} → snapped ${to.toFixed(3)}`);
    expect(pos).toBeCloseTo(frac * 3.0, 1);
    expect(Math.abs(to / beat - Math.round(to / beat))).toBeLessThan(1e-6);
    expect(Math.abs(to - pos)).toBeLessThanOrEqual(beat / 2 + 1e-6);
    expect(sk.state).toBe(state);
    const ph = await page.evaluate(() => window.__sing!.view().playhead!);
    if (state === 'stopped') expect(ph).toBeCloseTo(to, 6);
    else expect((((ph - to) % 3) + 3) % 3).toBeLessThan(0.3);
  }
  expect((await getSession(page)).tracks.length).toBe(tracks);
  expect(await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'take' && e.t > 0).length)).toBe(2); // the first take's start + commit only
  expect(errors, errors.join('\n')).toEqual([]);
});
