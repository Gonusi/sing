// [shell] node dev/ui/shots.ts — screenshots of every UI scene + start screen, and checks of the gesture layer.
// Output: dev/ui/out/<name>.png (iPhone 15 viewport 390x844 @3x). Exit code 1 when any check fails.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CDPSession, Page } from '@playwright/test';
import { launch } from '../lib/browser.ts';
import { startDev } from '../lib/serve.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('./out/', import.meta.url));
const VIEWPORT = { width: 390, height: 844 };
const SCENES = ['empty', 'four', 'five', 'recording', 'recording-vocals', 'overdub', 'command', 'toast', 'settings', 'plus', 'menu', 'many'];
const FROZEN_T = 1.6; // loop position for stable screenshots
const SETTLE_MS = 1100; // transitions (sheet 200 ms, overlay 120 ms) finished; toast still fully visible
const HOLD_MS = 500;
const FREE_SPOT = { x: 195, y: 650 }; // empty part of the lanes area in the `four` scene

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// ---------- page helpers ----------
const gestureTypes = (page: Page): Promise<string[]> => page.evaluate(() => window.__gestures.map((g) => g.type));
const actions = (page: Page): Promise<string[]> => page.evaluate(() => [...window.__actions]);
const resetLogs = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__gestures.length = 0;
    window.__actions.length = 0;
  });

async function center(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function tap(page: Page, selector: string): Promise<void> {
  const { x, y } = await center(page, selector);
  await page.touchscreen.tap(x, y);
}

const touch = (cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

async function openScene(page: Page, url: string, scene: string): Promise<void> {
  await page.goto(`${url}dev/ui/index.html?s=${scene}&t=${FROZEN_T}`);
  await page.waitForFunction(() => window.__ready);
}

// ---------- screenshots ----------
async function shootScenes(page: Page, url: string): Promise<void> {
  for (const scene of SCENES) {
    await openScene(page, url, scene);
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: `${OUT_DIR}${scene}.png` });
    console.log(`shot ${scene}`);
  }
}

/** calibration with 400 ms clicks: 4 listen clicks take 1.6 s, so ~2.8 s in it is mid-measure (clap or say “ta” · ~3/12) */
async function shootCalibrating(page: Page, url: string): Promise<void> {
  await page.goto(`${url}dev/ui/index.html?s=calibrating&t=${FROZEN_T}&ci=400`);
  await page.waitForFunction(() => window.__ready);
  await page.waitForFunction(() => document.body.textContent?.includes('clap or say “ta” ·'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT_DIR}calibrating.png` });
  console.log('shot calibrating');
}

async function shootStart(page: Page, url: string): Promise<void> {
  const shots: Array<[string, string]> = [['start', ''], ['start-progress', '?p=0.6'], ['start-error', '?e=Microphone%20permission%20denied']];
  for (const [name, query] of shots) {
    await page.goto(`${url}dev/ui/start.html${query}`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT_DIR}${name}.png` });
    console.log(`shot ${name}`);
  }
}

// ---------- checks ----------
async function checkStart(page: Page, url: string): Promise<void> {
  await page.goto(`${url}dev/ui/start.html`);
  await page.touchscreen.tap(FREE_SPOT.x, FREE_SPOT.y);
  await page.touchscreen.tap(FREE_SPOT.x, FREE_SPOT.y);
  const taps = await page.evaluate(() => window.__taps);
  const text = await page.locator('.start-text').textContent();
  check('start: first tap calls onTap once, later taps ignored', taps === 1, `taps=${taps}`);
  check('start: text changes to "starting…"', text === 'starting…', `text=${text}`);
}

async function checkGestures(page: Page, url: string, cdp: CDPSession): Promise<void> {
  await openScene(page, url, 'four');
  const { x, y } = FREE_SPOT;

  await page.touchscreen.tap(x, y);
  check('gesture: quick tap -> tap', (await gestureTypes(page)).join() === 'tap', (await gestureTypes(page)).join());

  await resetLogs(page);
  await touch(cdp, 'touchStart', x, y);
  await page.waitForTimeout(HOLD_MS);
  await touch(cdp, 'touchEnd');
  const hold = await page.evaluate(() => window.__gestures);
  check('gesture: 500 ms press -> holdStart, holdEnd', hold.map((g) => g.type).join() === 'holdStart,holdEnd', hold.map((g) => g.type).join());
  const end = hold[1];
  check('gesture: holdEnd has tDown < tUp, same tDown as holdStart', end?.type === 'holdEnd' && end.tUp > end.tDown && end.tDown === hold[0]?.tDown);

  await resetLogs(page);
  await touch(cdp, 'touchStart', x, y);
  await touch(cdp, 'touchMove', x + 40, y + 20);
  await page.waitForTimeout(HOLD_MS);
  await touch(cdp, 'touchMove', x + 80, y + 40);
  await touch(cdp, 'touchEnd');
  check('gesture: moving the finger does not cancel the hold', (await gestureTypes(page)).join() === 'holdStart,holdEnd', (await gestureTypes(page)).join());

  await resetLogs(page);
  await page.keyboard.press('Space');
  await page.keyboard.down('Space');
  await page.keyboard.down('Space'); // auto-repeat must be ignored
  await page.waitForTimeout(HOLD_MS);
  await page.keyboard.up('Space');
  check('gesture: Space tap, then Space hold (repeat ignored)', (await gestureTypes(page)).join() === 'tap,holdStart,holdEnd', (await gestureTypes(page)).join());

  await resetLogs(page);
  await tap(page, '.lane-strip[data-id="drums"]');
  await tap(page, '.lane-strip[data-id="violin"]');
  check('strip: tap other lane = select, tap selected lane = toggle', (await actions(page)).join() === 'select:drums,toggle:violin', (await actions(page)).join());
  check('strip: no gesture emitted', (await gestureTypes(page)).length === 0);
}

async function press(cdp: CDPSession, x: number, y: number, ms: number): Promise<void> {
  await touch(cdp, 'touchStart', x, y);
  await page_wait(ms);
  await touch(cdp, 'touchEnd');
}
const page_wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function checkLaneMenu(page: Page, url: string, cdp: CDPSession): Promise<void> {
  await openScene(page, url, 'four');
  const strip = await center(page, '.lane-strip[data-id="violin"]');
  const open = (): Promise<number> => page.locator('.lane-menu').count();

  await resetLogs(page);
  await page.touchscreen.tap(strip.x, strip.y);
  await page.waitForTimeout(100);
  check('menu: short strip tap still acts (toggle on the selected lane), no menu', (await open()) === 0 && (await actions(page)).join() === 'toggle:violin', (await actions(page)).join());

  await resetLogs(page);
  await press(cdp, strip.x, strip.y, 600);
  await page.waitForTimeout(100);
  check('menu: 600 ms strip press opens the menu', (await open()) === 1);
  check('menu: hold emits no gesture, no select/toggle', (await gestureTypes(page)).length === 0 && (await actions(page)).length === 0, `${(await gestureTypes(page)).join()} ${(await actions(page)).join()}`);
  check('menu: title and items', (await page.locator('.lane-menu-title').textContent()) === 'violin track' && (await page.locator('.lane-menu-item').allTextContents()).join() === 'mute,delete');

  await page.locator('.lane-menu-item.danger').tap();
  await page.waitForTimeout(100);
  check('menu: delete calls onDelete with the track id and closes', (await actions(page)).join() === 'delete:violin' && (await open()) === 0, (await actions(page)).join());
  check('menu: deleted lane is gone', (await page.locator('.lane-strip[data-id="violin"]').count()) === 0);

  await openScene(page, url, 'four');
  await page.locator('.lane-strip[data-id="violin"]').waitFor(); // strips appear after the first frame
  await resetLogs(page);
  await press(cdp, strip.x, strip.y, 600);
  await page.waitForTimeout(100);
  await page.touchscreen.tap(300, 700); // backdrop
  await page.waitForTimeout(100);
  check('menu: backdrop tap closes without action or gesture', (await open()) === 0 && (await actions(page)).length === 0 && (await gestureTypes(page)).length === 0, `open=${await open()} actions=${(await actions(page)).join()} gestures=${(await gestureTypes(page)).join()}`);

  await resetLogs(page);
  await page.touchscreen.tap(strip.x, strip.y);
  check('menu: strip tap works again after a hold', (await actions(page)).join() === 'toggle:violin', (await actions(page)).join());

  await press(cdp, strip.x, strip.y, 600);
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  check('menu: Escape closes', (await open()) === 0);
}

async function checkEcho(page: Page): Promise<void> {
  const initial = await page.locator('.topbar .echo-slider').inputValue();
  check('echo: slider starts at getEcho()', initial === '0.4', `value=${initial}`);
  await resetLogs(page);
  const box = await page.locator('.topbar .echo-slider').boundingBox();
  if (!box) throw new Error('no echo slider');
  await page.touchscreen.tap(box.x + box.width * 0.75, box.y + box.height / 2);
  const acts = (await actions(page)).filter((a) => a.startsWith('setEcho:'));
  const value = await page.locator('.topbar .echo-slider').inputValue();
  check('echo: tapping the slider calls setEcho, no gesture', acts.length > 0 && Math.abs(Number(value) - 0.75) < 0.1 && (await gestureTypes(page)).length === 0, `acts=${acts.join()} value=${value} gestures=${(await gestureTypes(page)).join()}`);
  await page.evaluate(() => {
    const s = document.querySelector<HTMLInputElement>('.topbar .echo-slider')!;
    s.value = '0.2';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  check('echo: input event calls setEcho with the value', (await actions(page)).includes('setEcho:0.2'));
}

async function checkSmoothing(page: Page): Promise<void> {
  const slider = page.locator('.smooth-slider');
  const initial = await slider.inputValue();
  check('smoothing: slider starts at getSmoothing()', initial === '0.5', `value=${initial}`);
  await resetLogs(page);
  const box = await slider.boundingBox();
  if (!box) throw new Error('no smoothing slider');
  await page.touchscreen.tap(box.x + box.width * 0.9, box.y + box.height / 2);
  const acts = (await actions(page)).filter((a) => a.startsWith('setSmoothing:'));
  const value = await slider.inputValue();
  check('smoothing: moving the slider calls setSmoothing, no gesture', acts.length > 0 && Math.abs(Number(value) - 0.9) < 0.1 && (await gestureTypes(page)).length === 0, `acts=${acts.join()} value=${value} gestures=${(await gestureTypes(page)).join()}`);
}

async function checkMic(page: Page): Promise<void> {
  const select = page.locator('.mic-select');
  const options = await select.locator('option').allTextContents();
  check('mic: select lists default + 2 mics', options.join('|') === 'default|iPhone Microphone|AirPods Pro', options.join('|'));
  const box = await select.boundingBox();
  check('mic: select fits inside the 390 px screen', !!box && box.x >= 0 && box.x + box.width <= VIEWPORT.width, JSON.stringify(box));
  await resetLogs(page);
  await select.selectOption('airpods');
  await page.waitForTimeout(50);
  check('mic: change calls setMic(id)', (await actions(page)).join() === 'setMic:airpods', (await actions(page)).join());
  await select.selectOption('');
  check('mic: default calls setMic(null)', (await actions(page)).includes('setMic:null'));
}

async function checkCalibrate(page: Page): Promise<void> {
  const title = page.locator('[data-row="calibrate"]').locator('.row-title');
  const idleSub = await page.locator('[data-row="calibrate"]').locator('.row-sub').textContent();
  check('calibrate: idle sub-line', idleSub === 'clap or say “ta” along with 16 clicks', `sub=${idleSub}`);
  await resetLogs(page);
  // record every title text the row shows (clicks come 100 ms apart, faster than polling is reliable)
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-row="calibrate"]')!;
    const seen: string[] = [];
    (window as unknown as { __titles: string[] }).__titles = seen;
    new MutationObserver(() => seen.push(row.querySelector('.row-title')!.textContent ?? '')).observe(row, { subtree: true, childList: true, characterData: true });
  });
  await page.locator('[data-row="calibrate"]').tap();
  const sub = await page.locator('[data-row="calibrate"] .row-sub', { hasText: 'wear your headphones' }).count();
  await page.waitForFunction(() => document.body.textContent?.includes('latency 312 ms · heard 9/12'), undefined, { timeout: 5000 });
  const seen = await page.evaluate(() => (window as unknown as { __titles: string[] }).__titles);
  const listenAt = seen.findIndex((t) => /^listen… 1\/4$/.test(t));
  const measureAt = seen.findIndex((t) => /^clap or say “ta” · 1\/12$/.test(t));
  check('calibrate: shows "listen… i/4", then "clap or say “ta” · i/12", with the headphones line', listenAt >= 0 && measureAt > listenAt && sub === 1, `listen@${listenAt} measure@${measureAt} sub=${sub}`);
  check('calibrate: ends with the result text', (await title.textContent()) === 'latency 312 ms · heard 9/12', (await title.textContent()) ?? '');
}

async function checkSheets(page: Page, url: string): Promise<void> {
  await openScene(page, url, 'four');
  await resetLogs(page);
  await tap(page, '[data-action="new-track"]');
  await page.waitForTimeout(350);
  check('plus: opens the sheet, no gesture', (await page.locator('.sheet-layer.open').count()) === 1 && (await gestureTypes(page)).length === 0);
  check('plus: five kind buttons incl. vocals', (await page.locator('.kind-btn').count()) === 5 && (await page.locator('.kind-btn[data-kind="vocals"]').textContent()) === 'Mvocalsyour voice');
  await tap(page, '.kind-btn[data-kind="violin"]');
  await page.waitForTimeout(350);
  check('plus: kind button creates and closes the sheet', (await actions(page)).join() === 'create:violin' && (await page.locator('.sheet-layer.open').count()) === 0, (await actions(page)).join());

  await checkEcho(page);

  await tap(page, '[data-action="settings"]');
  await page.waitForTimeout(350);
  await page.touchscreen.tap(195, 60); // backdrop
  await page.waitForTimeout(350);
  check('settings: backdrop tap closes, no gesture', (await page.locator('.sheet-layer.open').count()) === 0 && (await gestureTypes(page)).length === 0);

  await tap(page, '[data-action="settings"]');
  await page.waitForTimeout(350);
  await checkSmoothing(page);
  await checkMic(page);
  await checkCalibrate(page);
  const download = page.waitForEvent('download', { timeout: 3000 });
  await page.getByText('Export last take (WAV)').tap();
  const file = (await download).suggestedFilename();
  check('settings: export downloads sing-take-<date>.wav', /^sing-take-\d{8}-\d{6}\.wav$/.test(file), file);

  await page.getByText('Clear session').tap();
  const armed = await page.locator('.row.danger .row-title').textContent();
  await page.getByText('tap again to clear').tap();
  await page.waitForTimeout(350);
  check('settings: clear needs two taps, then clears and closes', armed === 'tap again to clear' && (await actions(page)).includes('clear') && (await page.locator('.sheet-layer.open').count()) === 0, `armed=${armed}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dev = await startDev(REPO_ROOT);
  const browser = await launch('chromium');
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => check('no page error', false, e.message));
    const cdp = await context.newCDPSession(page);

    await shootScenes(page, dev.url);
    await shootCalibrating(page, dev.url);
    await shootStart(page, dev.url);
    await checkStart(page, dev.url);
    await checkGestures(page, dev.url, cdp);
    await checkSheets(page, dev.url);
    await checkLaneMenu(page, dev.url, cdp);
  } finally {
    await browser.close();
    await dev.close();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed; screenshots in dev/ui/out/');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
