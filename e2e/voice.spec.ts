// [tester] Voice command LOGIC (no recogniser): a real pointer hold on the stage + window.__sing.voice.inject(text),
// which parses with src/voice/grammar.ts and runs the command against the state at the hold's tDown.
import { expect, test } from '@playwright/test';
import { boot, getSession } from './helpers.ts';

const SPOT = { x: 230, y: 470 };

test('hold + "create violin track" → violin lane created and selected; "hello" → nothing', async ({ page }) => {
  const errors = await boot(page);
  await page.mouse.move(SPOT.x, SPOT.y);
  await page.mouse.down();
  await expect(page.locator('.cmd-overlay.on')).toBeVisible();
  const accepted = await page.evaluate(() => window.__sing!.voice.inject('create violin track'));
  await expect(page.locator('.toast')).toContainText(/violin/);
  await page.mouse.up(); // with the stub recogniser, release then shows 'voice unavailable'
  expect(accepted).toBe(true);
  let s = await getSession(page);
  expect(s.tracks.map((t) => t.kind)).toEqual(['violin']);
  expect(s.selectedId).toBe(s.tracks[0].id);
  const inj = await page.evaluate(() => window.__sing!.voice.injections());
  const hold = await page.evaluate(() => window.__sing!.log().find((e) => e.type === 'gesture' && e.data!.type === 'holdStart')!.data!.tDown as number);
  expect(inj[0].tDown).toBe(hold); // read against the state at the hold's touch-down

  // anything outside the grammar: no command at all
  const before = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'command').length);
  await page.mouse.down();
  await page.waitForTimeout(400);
  for (const text of ['hello', 'create piano track', 'violin', 'record please']) {
    expect(await page.evaluate((t) => window.__sing!.voice.inject(t), text)).toBeNull();
  }
  await page.mouse.up();
  const after = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'command').length);
  expect(after).toBe(before);
  s = await getSession(page);
  expect(s.tracks).toHaveLength(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('every grammar phrase parses to its command and applies', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const s = window.__sing!;
    const out: Record<string, boolean | null> = {};
    for (const k of ['drum', 'drums', 'violin', 'synth', 'bass']) out[`create ${k} track`] = s.voice.inject(`create ${k} track`);
    for (const k of ['drums', 'violin', 'synth', 'bass']) {
      out[`${k} off`] = s.voice.inject(`${k} off`);
      out[`${k} on`] = s.voice.inject(`${k} on`);
    }
    out['  Create   SYNTH track '] = s.voice.inject('  Create   SYNTH track ');
    out['undo'] = s.voice.inject('undo');
    return { out, kinds: s.session().tracks.map((t) => t.kind) };
  });
  for (const [k, v] of Object.entries(r.out)) expect(v, k).toBe(true);
  // drum + drums both make a drums lane; the extra spaced/upper-case synth one was undone
  expect(r.kinds).toEqual(['drums', 'drums', 'violin', 'synth', 'bass']);
});
