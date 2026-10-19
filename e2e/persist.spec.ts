// [tester] Persistence + offline. Two lanes (synth first take, violin overdub) → flush → reload → session restored
// (state stopped, same session) → play schedules both lanes. Then offline (context.setOffline) + reload → the app
// boots from the service worker (incl. violin samples) → play → the violin lane is audible.
import { expect, test, type Page } from '@playwright/test';
import { boot, firstTake, getSession, overdub, scheds, stateWord } from './helpers.ts';

async function playAndCapture(page: Page, trackId: string): Promise<{ state: string; sched: number; rms: number; tracks: string[] }> {
  return page.evaluate(async (id) => {
    const s = window.__sing!;
    const t = s.now();
    s.command({ type: 'play' }, t);
    s.capture.begin('lane', id);
    await s.waitUntil(t + s.session().loopLength! + 0.3);
    const c = await s.capture.end('lane');
    const sc = s.logSince(t).filter((e) => e.type === 'sched');
    return { state: s.state(), sched: sc.length, rms: c.rms, tracks: [...new Set(sc.map((e) => String(e.data!.trackId)))] };
  }, trackId);
}

test('session survives reload; app + violin work offline', async ({ page, context }) => {
  test.slow();
  const errors = await boot(page);
  const first = await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  const dub = await overdub(page, { kind: 'violin', fixture: 'sing-high', dur: 2.4 });
  expect(dub.phase).toBe('commit');
  await page.evaluate(async () => {
    window.__sing!.command({ type: 'stop' });
    await window.__sing!.flush();
  });
  const before = await getSession(page);
  expect(before.tracks.map((t) => t.kind)).toEqual(['synth', 'violin']);
  expect(before.tracks.every((t) => (t.take?.notes.length ?? 0) > 0)).toBe(true);

  await test.step('reload → restored, stopped, plays both lanes', async () => {
    await page.reload();
    await boot(page, { navigate: false });
    expect(await page.evaluate(() => window.__sing!.state())).toBe('stopped');
    expect(await getSession(page)).toEqual(before);
    const bootEv = await page.evaluate(() => window.__sing!.log().find((e) => e.type === 'boot')!.data);
    expect(bootEv).toMatchObject({ restored: true, tracks: 2, state: 'stopped' });
    await expect(stateWord(page)).toHaveText('paused');
    await expect(page.locator('.lane-strip')).toHaveCount(2);
    const r = await playAndCapture(page, dub.trackId);
    expect(r.state).toBe('playing');
    expect(r.tracks.sort()).toEqual([first.trackId, dub.trackId].sort());
    console.log(`[persist] after reload: ${r.sched} events, violin rms ${r.rms.toFixed(4)}`);
    expect(r.rms).toBeGreaterThan(1e-3);
    await page.evaluate(() => window.__sing!.command({ type: 'stop' }));
  });

  await test.step('offline reload → boots from the service worker, violin plays', async () => {
    const cached = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const k of keys) for (const req of await (await caches.open(k)).keys()) urls.push(req.url);
      return { controlled: !!navigator.serviceWorker.controller, violin: urls.filter((u) => u.includes('/samples/violin/')).length, total: urls.length };
    });
    console.log(`[persist] precache: ${cached.total} entries, ${cached.violin} violin samples, controlled ${cached.controlled}`);
    expect(cached.controlled).toBe(true);
    expect(cached.violin).toBe(8);
    await context.setOffline(true);
    try {
      await page.reload();
      await boot(page, { navigate: false });
      expect(await page.evaluate(() => window.__sing!.state())).toBe('stopped');
      expect(await getSession(page)).toEqual(before);
      const r = await playAndCapture(page, dub.trackId);
      console.log(`[persist] offline: ${r.sched} events, violin rms ${r.rms.toFixed(4)}`);
      expect(r.state).toBe('playing');
      expect(r.rms).toBeGreaterThan(1e-3);
      const log = await page.evaluate(() => window.__sing!.log());
      expect(scheds(log).some((s) => s.trackId === dub.trackId)).toBe(true);
    } finally {
      await context.setOffline(false);
    }
  });
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)), errors.join('\n')).toEqual([]);
});
