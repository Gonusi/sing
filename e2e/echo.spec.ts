// [tester] Echo (global FX bus, Session.fx.echo, notes/engine.md "echo"): strips → send (amount) → 0.33 s feedback delay
// + short reverb → master. A single hi-hat on a drums lane (short, sharp) makes the repeat stand alone.
// Asserts: echo 0 → the master is silent after the hat's own decay; echo 1 → a repeat 0.33 s ± 15 ms after the hat;
// the top-bar slider sets session.fx.echo, it survives a reload, and undo never changes it.
import { expect, test, type Page } from '@playwright/test';
import { boot, firstTake, getSession, ms, putFixtures, scheds } from './helpers.ts';

const BLOCK = 0.005;

/** capture the master over one cycle from the next hat; envelope around it */
async function hatCycle(page: Page, trackId: string): Promise<{ at: number; env: number[] }> {
  return page.evaluate(
    async ([id, block]) => {
      const s = window.__sing!;
      const L = s.session().loopLength!;
      const t = s.now();
      s.capture.begin('m', null);
      await s.waitUntil(t + L + 0.6);
      await s.capture.end('m');
      const hat = s.logSince(t).filter((e) => e.type === 'sched' && e.data!.trackId === id).map((e) => Number(e.data!.at)).find((a) => a > t + 0.05 && a < t + L - 0.5)
        ?? s.logSince(t - L).filter((e) => e.type === 'sched' && e.data!.trackId === id).map((e) => Number(e.data!.at) + L).find((a) => a > t + 0.05)!;
      return { at: hat, env: s.capture.envelope('m', hat - 0.05, hat + 1.0, block) };
    },
    [trackId, BLOCK] as const,
  );
}

const slice = (env: number[], a: number, b: number) => env.slice(Math.round((a + 0.05) / BLOCK), Math.round((b + 0.05) / BLOCK));
const peakAt = (env: number[], a: number, b: number) => {
  const xs = slice(env, a, b);
  const i = xs.reduce((m, x, k) => (x > xs[m] ? k : m), 0);
  return { t: a + i * BLOCK, v: xs[i] ?? 0 };
};

test('echo 0 → dry; echo 1 → a repeat 0.33 s later', async ({ page }) => {
  // no noise bed: at −45 dBFS an empty drum first take records phantom hats (bugs.spec.ts); the faded slice needs none
  const errors = await boot(page, { noise: null });
  expect((await getSession(page)).fx?.echo ?? 0).toBe(0);
  await putFixtures(page, ['beatbox-basic']);
  // one hat: beatbox-basic 0.7–1.05 s holds only the hat at 0.8 (faded edges: the cut is not an onset)
  const run = await firstTake(page, { fixture: 'beatbox-basic', from: 0.72, dur: 0.33, fade: 0.06, L: 2.0, lead: 0.3, kind: 'drums' });
  const lane = (await getSession(page)).tracks.find((t) => t.id === run.trackId)!;
  console.log(`[echo] take hits ${lane.take!.hits.map((h) => `${h.kind}@${h.pos.toFixed(3)}`).join(' ')}`);
  expect(lane.take!.hits.map((h) => h.kind)).toEqual(['hat']);

  const dry = await hatCycle(page, run.trackId);
  const dryHat = peakAt(dry.env, 0, 0.05);
  const dryTail = peakAt(dry.env, 0.2, 0.9);
  await page.evaluate(() => window.__sing!.setEcho(1));
  await page.evaluate(() => window.__sing!.waitUntil(window.__sing!.now() + 0.3));
  const wet = await hatCycle(page, run.trackId);
  const wetHat = peakAt(wet.env, 0, 0.05);
  const repeat = peakAt(wet.env, 0.2, 0.5);
  const second = peakAt(wet.env, 0.55, 0.8);
  console.log(`[echo] echo 0: hat ${dryHat.v.toFixed(4)}, max 0.2–0.9 s after ${dryTail.v.toExponential(2)} | echo 1: hat ${wetHat.v.toFixed(4)}, repeat at +${ms(repeat.t)} level ${repeat.v.toFixed(4)} (${(repeat.v / wetHat.v).toFixed(2)}×), 2nd at +${ms(second.t)} ${second.v.toFixed(4)}`);
  expect(dryHat.v).toBeGreaterThan(1e-3);
  expect(dryTail.v).toBeLessThan(dryHat.v * 0.01);
  expect(Math.abs(repeat.t - 0.33)).toBeLessThanOrEqual(0.015);
  expect(repeat.v).toBeGreaterThan(wetHat.v * 0.1);
  expect(Math.abs(second.t - 0.66)).toBeLessThanOrEqual(0.02);
  expect(second.v).toBeLessThan(repeat.v);
  expect((await getSession(page)).fx?.echo).toBe(1);
  expect(scheds(await page.evaluate(() => window.__sing!.log())).length).toBeGreaterThan(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('slider sets session.fx.echo, survives reload; undo keeps it', async ({ page }) => {
  const errors = await boot(page);
  const slider = page.locator('input.echo-slider[type="range"]');
  await expect(slider).toBeVisible();
  expect(Number(await slider.inputValue())).toBe(0);
  expect(await page.evaluate(() => window.__sing!.command({ type: 'create', kind: 'synth' }))).toBe(true);
  await slider.fill('0.6');
  await expect.poll(async () => (await getSession(page)).fx?.echo).toBeCloseTo(0.6, 6);
  // undo (removes the lane) keeps the echo
  expect(await page.evaluate(() => window.__sing!.command({ type: 'undo' }))).toBe(true);
  const s = await getSession(page);
  expect(s.tracks).toEqual([]);
  expect(s.fx?.echo).toBeCloseTo(0.6, 6);
  expect(Number(await slider.inputValue())).toBeCloseTo(0.6, 6);
  // strip/slider taps never reach the gesture layer
  expect(await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'gesture').length)).toBe(0);
  await page.evaluate(() => window.__sing!.flush());
  await page.reload();
  await boot(page, { navigate: false });
  expect((await getSession(page)).fx?.echo).toBeCloseTo(0.6, 6);
  expect(Number(await page.locator('input.echo-slider').inputValue())).toBeCloseTo(0.6, 6);
  await page.locator('input.echo-slider').fill('0');
  await expect.poll(async () => (await getSession(page)).fx?.echo).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
