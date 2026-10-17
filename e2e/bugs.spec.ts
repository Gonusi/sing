// [tester] Product bugs found by the suite, one minimal repro each, marked test.fail() (the suite stays green while the
// bug exists; once fixed, Playwright reports "expected to fail but passed": remove the marker then). See notes/tester.md.
import { expect, test } from '@playwright/test';
import { boot, firstTake } from './helpers.ts';

test('regression engine: undo right after record-from-stopped discards the overdub, keeps the first take', async ({ page }) => {
  await boot(page);
  await firstTake(page, { fixture: 'sing-cmaj', L: 2.6, dur: 2.4 });
  const r = await page.evaluate(() => {
    const s = window.__sing!;
    s.command({ type: 'stop' });
    const t = s.now();
    s.command({ type: 'record' }, t); // stopped → playing + overdubbing from origin = now + outLat + 0.03
    const undo = s.command({ type: 'undo' }, t + 0.01); // read against the state at tDown: should discard the overdub
    return { undo, state: s.state(), loopLength: s.session().loopLength, tracks: s.session().tracks.length };
  });
  console.log(`[bug undo-after-record-from-stopped] got ${JSON.stringify(r)}`);
  // expected: the pending overdub is discarded, the loop keeps playing, the first take survives
  expect(r).toEqual({ undo: true, state: 'playing', loopLength: expect.any(Number), tracks: 1 });
});

test('regression shell: a press right after closing a sheet starts a gesture', async ({ page }) => {
  await boot(page);
  await page.locator('[data-action="settings"]').click();
  await page.waitForTimeout(400);
  await page.locator('.sheet-layer.open .sheet-done').click();
  await page.mouse.move(230, 470);
  await page.mouse.down(); // ~immediately after close: should start a press on the stage
  await page.waitForTimeout(450);
  await page.mouse.up();
  const gestures = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'gesture').map((e) => e.data!.type));
  console.log(`[bug sheet-close press] gestures ${JSON.stringify(gestures)}`);
  expect(gestures).toEqual(['holdStart', 'holdEnd']);
});

test('BUG engine: one-sample clicks at vocal loop seams', async ({ page }) => {
  test.fail(true, 'src/audio/vocal-voice.ts: at some cycle starts exactly one sample is doubled (old tail + new cycle both at full level); suspect: the new GainNode is 1 (default) until its setValueAtTime(…, when)');
  test.slow();
  await boot(page);
  await page.evaluate(() => window.__sing!.command({ type: 'create', kind: 'vocals' }));
  // seam inside a sustained sung A4 (sing-cmaj 3.84–4.59 s), as in vocals.spec.ts
  const L = 4.29;
  const run = await firstTake(page, { fixture: 'sing-cmaj', L, lead: 0.1, captureKey: 'lane' });
  await page.evaluate((t) => window.__sing!.waitUntil(t), run.t0 + 5 * L + 0.2);
  await page.evaluate(() => window.__sing!.capture.end('lane'));
  const sched = (await page.evaluate(() => window.__sing!.log())).filter((e) => e.type === 'sched' && e.data!.trackId === run.trackId && Number(e.data!.offset) === 0);
  const spikes: string[] = [];
  for (const e of sched) {
    const at = Number(e.data!.at);
    // one-sample spike: |x[n] − (x[n−1] + x[n+1]) / 2| within ±2 ms of the cycle start vs. 20–200 ms before it
    const spike = async (a: number, b: number) => {
      const { x } = await page.evaluate(([a, b]) => window.__sing!.capture.samples('lane', a, b), [a, b] as const);
      let m = 0;
      for (let i = 1; i + 1 < x.length; i++) m = Math.max(m, Math.abs(x[i] - (x[i - 1] + x[i + 1]) / 2));
      return m;
    };
    const atSeam = await spike(at - 0.002, at + 0.002);
    const steady = await spike(at - 0.2, at - 0.02);
    spikes.push(`cycle ${e.data!.cycle} at ${at.toFixed(4)} (frame ${(at * 48000).toFixed(1)}): seam ${atSeam.toFixed(3)} steady ${steady.toFixed(3)}`);
  }
  console.log(`[bug vocal seam]\n${spikes.join('\n')}`);
  expect(sched.length).toBeGreaterThanOrEqual(3);
  for (const line of spikes) {
    const [, seam, steady] = /seam ([\d.]+) steady ([\d.]+)/.exec(line)!.map(Number);
    expect(seam, line).toBeLessThanOrEqual(steady * 2 + 0.01);
  }
});

test('BUG engine/dsp: a drum first take of room noise only (−45 dBFS) records phantom hats', async ({ page }) => {
  test.fail(true, 'src/loop/take.ts + src/analysis/drums.ts: with the fixtures\' own −45 dBFS room noise, an empty drum first take gets 2 hats (pos ≈ 0.03 and ≈ 0.23 s; the 2nd right after the 80 ms record-beep exclusion, which zeroes the noise without ramps: noise resuming from 0 is a sharp onset). −60 dBFS or silence: none.');
  await boot(page, { noise: -45 });
  const hits = await page.evaluate(async () => {
    const s = window.__sing!;
    s.command({ type: 'create', kind: 'drums' });
    const t0 = s.now();
    await s.waitUntil(t0 + 0.1);
    s.gesture({ type: 'tap', tDown: t0 });
    await s.waitUntil(t0 + 2.0);
    s.gesture({ type: 'tap', tDown: t0 + 1.9 });
    return s.session().tracks[0].take?.hits.map((h) => `${h.kind}@${h.pos.toFixed(3)}`) ?? [];
  });
  console.log(`[bug phantom hats] ${JSON.stringify(hits)}`);
  expect(hits).toEqual([]);
});
