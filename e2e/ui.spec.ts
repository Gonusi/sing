// [tester] UI at the iPhone viewport: screenshots (e2e/out/<project>-*.png) of empty, ＋ sheet, settings sheet,
// command overlay (real pointer hold ≥ 300 ms), recording (real pointer tap → first take with live notes), 4 lanes
// playing (session seeded into IndexedDB from fixture ground truth). Interactions: ＋ sheet creates + selects a lane;
// a strip tap selects, a second tap toggles on/off; a real tap records and stops.
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DrumHit, Note, Session, Track } from '../src/types.ts';
import { OUT_DIR, boot, getSession, groundTruth, putFixtures, stateWord } from './helpers.ts';

const recordButton = (page: Page) => page.locator('.tp-btn[data-button="record"]');
/** the downbeat of the count-in that just started */
const downbeat = (page: Page): Promise<number> =>
  page.evaluate(() => Number(window.__sing!.log().filter((e) => e.type === 'countIn').pop()!.data!.D));

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT_DIR, `${test.info().project.name}-${name}.png`) });
/** an empty spot of the gesture layer (below the top bar, right of the strips) */
const SPOT = { x: 230, y: 470 };

test('empty, sheets, command overlay, count-in + recording via the transport buttons', async ({ page }) => {
  const errors = await boot(page);
  await page.waitForTimeout(700);
  await expect(page.locator('.hint.on')).toBeVisible();
  await shot(page, 'empty');

  // ＋ sheet → violin lane, selected
  await page.locator('[data-action="new-track"]').click();
  await expect(page.locator('.sheet-layer.open')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'plus');
  await page.locator('.kind-btn[data-kind="violin"]').click();
  await expect(page.locator('.sheet-layer.open')).toHaveCount(0);
  await expect(page.locator('.lane-strip')).toHaveCount(1);
  await expect(page.locator('.lane-strip').first()).toHaveAttribute('aria-label', 'violin lane');
  let s = await getSession(page);
  expect(s.tracks.map((t) => t.kind)).toEqual(['violin']);
  expect(s.selectedId).toBe(s.tracks[0].id);

  // settings sheet
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator('.sheet-layer.open')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'settings');
  await page.locator('.sheet-layer.open .sheet-done').click();
  await expect(page.locator('.sheet-layer.open')).toHaveCount(0);
  await page.waitForTimeout(300); // a press during the 200 ms close transition is swallowed (bugs.spec.ts)

  // command overlay: a real pointer hold
  await page.mouse.move(SPOT.x, SPOT.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__sing!.ui().holding)).toBe(true);
  await shot(page, 'command');
  await page.mouse.up();
  await expect(page.locator('.cmd-overlay.on')).toHaveCount(0);
  const gestures = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'gesture').map((e) => e.data!.type));
  expect(gestures).toEqual(['holdStart', 'holdEnd']);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('idle');

  // recording: ● counts in one bar, then records; the fixture is sung from the downbeat
  await putFixtures(page, ['sing-cmaj']);
  await recordButton(page).click();
  await expect(stateWord(page)).toHaveText(/count-in/);
  await shot(page, 'count-in');
  const D = await downbeat(page);
  await page.evaluate((D) => window.__sing!.mic.play('/__fixtures/sing-cmaj.wav', D + 0.1), D);
  await page.evaluate((D) => window.__sing!.waitUntil(D + 3.3), D);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('recordingFirst');
  await expect(stateWord(page)).toHaveText('recording');
  expect((await page.evaluate(() => window.__sing!.view().liveNotes)).length).toBeGreaterThanOrEqual(2);
  await shot(page, 'recording');
  await recordButton(page).click(); // stop recording, keep playing
  await expect(stateWord(page)).toHaveText('playing');
  s = await getSession(page);
  expect(s.tracks[0].take!.notes.length).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(600);
  await shot(page, 'first-take-playing');
  expect(errors, errors.join('\n')).toEqual([]);
});

/** a 4-lane session built from fixture ground truth (positions as sung, register fit as the app would) */
function fourLaneSession(): Session {
  const L = 6.4;
  const notes = (name: string, shift: number, until: number, id: string): Note[] =>
    groundTruth(name).notes.filter((n) => n.t + n.dur <= until).map((n, i, a) => ({
      pos: n.t, dur: n.dur, midi: n.midi + shift, vel: 0.7, phrase: `${id}:${i}`, legatoNext: i + 1 < a.length && a[i + 1].t - (n.t + n.dur) < 0.12,
    }));
  const hits: DrumHit[] = groundTruth('beatbox-basic').hits.filter((h) => h.t < 5.4).map((h) => ({ pos: h.t, kind: h.kind, vel: 0.8 }));
  const track = (id: string, kind: Track['kind'], n: Note[], h: DrumHit[] = []): Track => ({ id, kind, on: true, take: { id: `k${id}`, notes: n, hits: h } });
  return {
    v: 1,
    loopLength: L,
    tempo: { bpm: 75, beatsPerBar: 4 }, // 6.4 s = 2 bars
    selectedId: 'tv',
    tracks: [
      track('ts', 'synth', notes('sing-cmaj', 0, 6.2, 'ks')),
      track('tv', 'violin', notes('sing-high', 0, 5.7, 'kv')),
      track('tb', 'bass', notes('sing-low', -12, 5.6, 'kb')),
      track('td', 'drums', [], hits),
    ],
  };
}

test('4 lanes playing (seeded session); strip tap selects, second tap toggles', async ({ page }) => {
  const errors = await boot(page, { seed: fourLaneSession() });
  expect(await page.evaluate(() => window.__sing!.state())).toBe('stopped');
  await expect(page.locator('.lane-strip')).toHaveCount(4);
  await page.waitForTimeout(500);
  await shot(page, 'four-stopped');
  // stopped → ▶ (a tap on the stage only seeks)
  await page.locator('.tp-btn[data-button="playPause"]').click();
  await expect(stateWord(page)).toHaveText('playing');
  await page.waitForTimeout(1800);
  await shot(page, 'four-playing');

  const bass = page.locator('.lane-strip[data-id="tb"]');
  await bass.click();
  expect((await getSession(page)).selectedId).toBe('tb');
  expect((await getSession(page)).tracks.find((t) => t.id === 'tb')!.on).toBe(true);
  await bass.click();
  expect((await getSession(page)).tracks.find((t) => t.id === 'tb')!.on).toBe(false);
  await page.waitForTimeout(400);
  await shot(page, 'four-bass-off');
  await bass.click();
  expect((await getSession(page)).tracks.find((t) => t.id === 'tb')!.on).toBe(true);
  // strip and transport presses never reach the gesture layer
  const gestures = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'gesture').length);
  expect(gestures).toBe(0);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('playing');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('vocals: ＋ sheet has 5 kinds; "create vocal track" by voice; waveform lane recording + playing', async ({ page }) => {
  const errors = await boot(page);
  await page.locator('[data-action="new-track"]').click();
  await expect(page.locator('.sheet-layer.open .kind-btn')).toHaveCount(5);
  await expect(page.locator('.kind-btn[data-kind="vocals"]')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'plus-five');
  await page.locator('.sheet-layer.open .sheet-done').click();
  await page.waitForTimeout(300);

  await page.mouse.move(SPOT.x, SPOT.y);
  await page.mouse.down();
  await expect(page.locator('.cmd-overlay.on')).toBeVisible();
  expect(await page.evaluate(() => window.__sing!.voice.inject('create vocal track'))).toBe(true);
  await page.mouse.up();
  const s = await getSession(page);
  expect(s.tracks.map((t) => t.kind)).toEqual(['vocals']);
  expect(s.selectedId).toBe(s.tracks[0].id);
  await expect(page.locator('.lane-strip').first()).toHaveAttribute('aria-label', 'vocals lane');

  await putFixtures(page, ['sing-cmaj']);
  await recordButton(page).click();
  const D = await downbeat(page);
  await page.evaluate((D) => window.__sing!.mic.play('/__fixtures/sing-cmaj.wav', D + 0.1), D);
  await page.evaluate((D) => window.__sing!.waitUntil(D + 2.5), D);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('recordingFirst');
  expect((await page.evaluate(() => window.__sing!.view().livePeaks))?.some((p) => p > 0.3)).toBe(true);
  await shot(page, 'vocals-recording');
  await page.evaluate((D) => window.__sing!.waitUntil(D + 4.0), D);
  await recordButton(page).click();
  await expect(stateWord(page)).toHaveText('playing');
  const lane = (await getSession(page)).tracks[0];
  expect(lane.take!.peaks!.filter((p) => p > 0.3).length).toBeGreaterThan(50);
  await page.waitForTimeout(800);
  await shot(page, 'vocals-playing');
  expect(errors, errors.join('\n')).toEqual([]);
});
