// [tester] Product bugs found by the suite, one minimal repro each, marked test.fail() (the suite stays green while the
// bug exists; once fixed, Playwright reports "expected to fail but passed": remove the marker then). See notes/tester.md.
import { expect, test } from '@playwright/test';
import { boot, firstTake } from './helpers.ts';

test('BUG engine: undo right after record-from-stopped pops the first take instead of discarding the overdub', async ({ page }) => {
  test.fail(true, 'src/app/controller.ts: startOverdub stamps overdubbing at ts = origin (future); stateAt(tDown < origin) = playing → popUndo');
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

test('BUG shell: a press right after closing a sheet is swallowed by the closing sheet layer', async ({ page }) => {
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
