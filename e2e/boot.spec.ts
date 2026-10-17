// [tester] Boot: start screen → stage, no console errors / page errors, state idle, service worker registered
// (production preview), manifest valid with fetchable icons, fixtures reachable through page.route even once the SW
// controls the page.
import { expect, test } from '@playwright/test';
import { boot, singUrl, watchErrors } from './helpers.ts';

test('start screen → stage, idle, no errors', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(singUrl('test'));
  await expect(page.locator('.start')).toBeVisible();
  await expect(page.locator('.start-text')).toContainText(/tap/i);
  await boot(page, { navigate: false });
  await expect(page.locator('.start')).toHaveCount(0, { timeout: 5000 });
  expect(await page.evaluate(() => window.__sing!.state())).toBe('idle');
  await expect(page.locator('.pill')).toHaveClass(/idle/);
  await expect(page.locator('.hint.on')).toBeVisible();
  const s = await page.evaluate(() => ({ sr: window.__sing!.sampleRate(), outLat: window.__sing!.outLat(), now: window.__sing!.now() }));
  console.log(`[boot] sampleRate ${s.sr}, outLat ${(s.outLat * 1000).toFixed(1)} ms, ctx time ${s.now.toFixed(3)}`);
  expect(s.sr).toBeGreaterThan(0);
  const boots = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'boot').map((e) => e.data));
  expect(boots).toHaveLength(1);
  await page.waitForTimeout(500);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('service worker registered and controlling; manifest valid', async ({ page }) => {
  await boot(page);
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) await new Promise((r) => setTimeout(r, 100));
    return { scope: reg.scope, active: !!reg.active, controlled: !!navigator.serviceWorker.controller };
  });
  expect(sw.active).toBe(true);
  expect(sw.scope).toMatch(/\/sing\/$/);
  expect(sw.controlled).toBe(true);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifestUrl = new URL(href!, page.url()).href;
  const res = await page.request.get(manifestUrl);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m.name).toBe('Sing');
  expect(m.start_url).toBe('/sing/');
  expect(m.scope).toBe('/sing/');
  expect(m.display).toBe('standalone');
  expect(m.icons.length).toBeGreaterThanOrEqual(3);
  for (const icon of m.icons as { src: string }[]) {
    const r = await page.request.get(new URL(icon.src, manifestUrl).href);
    expect(r.ok(), `icon ${icon.src}`).toBe(true);
  }
  // fixtures still reach the page through page.route while the SW controls it
  const info = await page.evaluate(() => window.__sing!.mic.load('/__fixtures/sing-cmaj.wav'));
  expect(info.duration).toBeGreaterThan(11);
});
