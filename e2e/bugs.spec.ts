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
