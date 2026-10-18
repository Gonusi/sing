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


// ---------- setup wizard ----------
interface WizHooks {
  done: boolean[];
  mounts: Record<string, number>;
  cleanups: Record<string, number>;
  levelCalls: number;
  outputs: string[];
  testDrumsStops: number;
  tryCommandStops: number;
  saves: Array<Record<string, unknown>>;
}
const wiz = (page: Page): Promise<WizHooks> => page.evaluate(() => window.__wiz as unknown as WizHooks);
const wizUrl = (url: string, query: string): string => `${url}dev/ui/wizard.html?${query}`;
const waitText = (page: Page, text: string, timeout = 15000): Promise<unknown> =>
  page.waitForFunction((t) => document.querySelector('.wizard')?.textContent?.includes(t), text, { timeout });
const currentStep = (page: Page): Promise<string | undefined> => page.evaluate(() => document.querySelector<HTMLElement>('.wizard')?.dataset.step);

async function openWizard(page: Page, url: string, query: string): Promise<void> {
  await page.goto(wizUrl(url, query));
  await page.waitForFunction(() => window.__wiz?.ready);
}
const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `${OUT_DIR}${name}.png` });
  console.log(`shot ${name}`);
};
const tapText = (page: Page, text: string): Promise<void> => page.locator('.wizard button', { hasText: text }).first().tap();

async function shootWizard(page: Page, url: string): Promise<void> {
  // each step alone (also proves single-step launching)
  await openWizard(page, url, 'steps=listening');
  await page.locator('.wiz-opt[data-kind="wired"]').tap();
  await page.getByText('play test tone').tap();
  await page.waitForTimeout(300);
  await shot(page, 'wizard-listening');

  await openWizard(page, url, 'steps=mic&t=0.2');
  await waitText(page, 'now hum');
  await page.waitForTimeout(1800);
  await shot(page, 'wizard-mic');
  await waitText(page, 'your mic sounds good');
  await shot(page, 'wizard-mic-result');

  await openWizard(page, url, 'steps=latency&ms=400');
  await page.getByText('start', { exact: true }).tap();
  await waitText(page, 'clap or say “ta” · 3/12');
  await page.waitForTimeout(150);
  await shot(page, 'wizard-latency');

  await openWizard(page, url, 'steps=drums&ms=300');
  await page.getByText('start', { exact: true }).tap();
  await page.waitForFunction(() => document.querySelectorAll('.wiz-circle.on').length === 2);
  await shot(page, 'wizard-drums');
  await waitText(page, 'got 3');
  for (const _ of ['snare', 'hat']) {
    await page.getByText('start', { exact: true }).tap();
    await waitText(page, 'got 3');
    await page.waitForTimeout(900);
  }
  await page.waitForSelector('.wiz-pads');
  await page.evaluate(() => document.querySelector('.wiz-pad[data-kind="snare"]')!.classList.add('hit')); // freeze a flash
  await page.waitForTimeout(100);
  await shot(page, 'wizard-drums-pad');

  await openWizard(page, url, 'steps=voice');
  await page.getByText('start', { exact: true }).tap();
  await waitText(page, 'cents flat');
  await shot(page, 'wizard-voice');
  await tapText(page, 'your range');
  await page.waitForFunction(() => document.querySelector('.wiz-note')?.textContent === 'A2');
  await shot(page, 'wizard-voice-range');

  await openWizard(page, url, 'steps=commands&t=1');
  await page.waitForTimeout(500);
  await shot(page, 'wizard-commands-loading');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.wiz-hold')!.disabled);
  const hold = await center(page, '.wiz-hold');
  const cdp = await page.context().newCDPSession(page);
  await touch(cdp, 'touchStart', hold.x, hold.y);
  await page.waitForTimeout(400);
  await shot(page, 'wizard-commands-holding');
  await touch(cdp, 'touchEnd');
  await waitText(page, 'heard:');
  await shot(page, 'wizard-commands');
}

async function checkWizard(page: Page, url: string, cdp: CDPSession): Promise<void> {
  await openWizard(page, url, 'ms=30&t=0.1');
  const dots = await page.locator('.wiz-dot').count();
  const on = await page.locator('.wiz-dot.on').count();
  const vis = (sel: string): Promise<string> => page.locator(sel).evaluate((e) => getComputedStyle(e).visibility);
  check('wizard: 6 dots, first one filled', dots === 6 && on === 1 && (await page.locator('.wiz-dot').first().getAttribute('class'))!.includes('on'));
  check('wizard: first step has no back; next disabled until a result', (await vis('[data-wiz="back"]')) === 'hidden' && (await page.locator('[data-wiz="next"]').isDisabled()));
  check('wizard: layer is a no-gesture zone above everything', (await page.locator('.wizard[data-no-gesture]').count()) === 1 && (await page.evaluate(() => Number(getComputedStyle(document.querySelector('.wizard')!).zIndex))) > 100);
  check('listening: guess outlined and tagged "looks like"', (await page.locator('.wiz-opt.guess[data-kind="bluetooth"] .wiz-opt-tag').textContent()) === 'looks like');

  // gestures must not leak: a 600 ms press on the card, taps on buttons
  await touch(cdp, 'touchStart', 195, 300);
  await page.waitForTimeout(600);
  await touch(cdp, 'touchEnd');
  await page.locator('.wiz-opt[data-kind="wired"]').tap();
  await page.getByText('play test tone').tap();
  await tapText(page, 'no, it’s quiet');
  check('listening: choosing applies the output; "no" shows the tip and allows next', (await wiz(page)).outputs.join() === 'wired' && (await page.locator('.wiz-result').textContent())!.includes('turn echo cancellation on in ⋯') && !(await page.locator('[data-wiz="next"]').isDisabled()));
  await tapText(page, 'yes');
  check('listening: "yes" says good', (await page.locator('.wiz-result').textContent()) === 'good — all set');

  await tap(page, '[data-wiz="next"]');
  check('next goes to mic; listening cleanup ran once', (await currentStep(page)) === 'mic' && (await wiz(page)).cleanups.listening === 1);
  check('back is visible now', (await vis('[data-wiz="back"]')) === 'visible');
  await tap(page, '[data-wiz="back"]');
  check('back returns to listening (mic cleaned up), next stays enabled (has a result)', (await currentStep(page)) === 'listening' && (await wiz(page)).cleanups.mic === 1 && !(await page.locator('[data-wiz="next"]').isDisabled()));
  await tap(page, '[data-wiz="skip-step"]');
  await waitText(page, 'your mic sounds good');
  check('mic: a loud hum reads "your mic sounds good", next enabled', !(await page.locator('[data-wiz="next"]').isDisabled()));
  await tap(page, '[data-wiz="skip-step"]'); // mic -> latency (skip works even with a result)
  const before = (await wiz(page)).levelCalls;
  await page.waitForTimeout(300);
  check('mic: cleanup stops the level meter', (await wiz(page)).levelCalls === before && (await wiz(page)).cleanups.mic === 2, `calls ${before} -> ${(await wiz(page)).levelCalls}`);

  await page.getByText('start', { exact: true }).tap();
  await waitText(page, 'latency 312 ms');
  check('latency: result text shown, next enabled', !(await page.locator('[data-wiz="next"]').isDisabled()));
  await tap(page, '[data-wiz="next"]');

  for (const kind of ['kick', 'snare', 'hat']) {
    await page.getByText('start', { exact: true }).tap();
    check(`drums: "${kind}" is the highlighted sound`, (await page.locator('.wiz-chip.on').textContent()) === kind);
    await waitText(page, 'got 3');
    await page.waitForTimeout(800);
  }
  await page.waitForSelector('.wiz-pads');
  check('drums: after three sounds the test pad shows kick/snare/hat', (await page.locator('.wiz-pad').allTextContents()).join() === 'kick,snare,hat');
  await page.waitForSelector('.wiz-pad.hit', { timeout: 3000 });
  check('drums: pad flashes on testDrums hits', true);
  await tapText(page, 'sounds right');
  await waitText(page, 'saved');
  const saved = (await wiz(page)).saves.find((p) => 'drums' in p);
  check('drums: "sounds right" saves all 9 templates; testDrums stopped', Array.isArray(saved?.drums) && (saved!.drums as unknown[]).length === 9 && (await wiz(page)).testDrumsStops === 1);
  await tap(page, '[data-wiz="next"]');
  check('voice step reached; drums cleanup ran', (await currentStep(page)) === 'voice' && (await wiz(page)).cleanups.drums === 1);

  await page.getByText('start', { exact: true }).tap();
  await waitText(page, 'you sing 33 cents flat — I’ll correct for that');
  check('voice: offset saved as tuningOffset', (await wiz(page)).saves.some((p) => p.tuningOffset === -0.33));
  await tapText(page, 'your range');
  await waitText(page, 'range A2 – E4 saved');
  const range = (await wiz(page)).saves.find((p) => 'range' in p)?.range as { lo: number; hi: number } | undefined;
  check('voice: range saved', range?.lo === 45 && range?.hi === 64, JSON.stringify(range));
  await tap(page, '[data-wiz="next"]');

  await waitText(page, 'voice is still downloading');
  check('commands: shows download progress, hold disabled', (await page.locator('.wiz-hold').isDisabled()));
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.wiz-hold')!.disabled);
  check('commands: next says "done"', (await page.locator('[data-wiz="next"]').textContent()) === 'done');
  const hold = await center(page, '.wiz-hold');
  await touch(cdp, 'touchStart', hold.x, hold.y);
  await page.waitForTimeout(400);
  check('commands: holding shows listening…', (await page.locator('.wiz-hold').textContent()) === 'listening…');
  await touch(cdp, 'touchEnd');
  await waitText(page, 'heard: “create violin track” ✓');
  check('commands: heard text shown, tryCommand stopped once', (await wiz(page)).tryCommandStops === 1);
  check('no gesture leaked to the stage during the whole wizard', (await gestureTypes(page)).length === 0, (await gestureTypes(page)).join());
  await tap(page, '[data-wiz="next"]');
  await page.waitForTimeout(100);
  const h = await wiz(page);
  check('finishing calls onDone(true) once and removes the layer; commands cleaned up', h.done.join() === 'true' && (await page.locator('.wizard').count()) === 0 && h.cleanups.commands === 1, h.done.join());

  // skip setup
  await openWizard(page, url, 'ms=30');
  await tap(page, '[data-wiz="skip-setup"]');
  const h2 = await wiz(page);
  check('skip setup calls onDone(false); current step cleaned up', h2.done.join() === 'false' && h2.cleanups.listening === 1 && (await page.locator('.wizard').count()) === 0);

  // a failed command hold, leaving mid-hold stops listening
  await openWizard(page, url, 'steps=commands&voice=ready&miss=1');
  const hold2 = await center(page, '.wiz-hold');
  await touch(cdp, 'touchStart', hold2.x, hold2.y);
  await page.waitForTimeout(150);
  await touch(cdp, 'touchEnd');
  await waitText(page, 'didn’t catch that — try again');
  check('commands: nothing heard -> "didn’t catch that", next stays disabled', await page.locator('[data-wiz="next"]').isDisabled());
  await openWizard(page, url, 'steps=commands&voice=error');
  check('commands: voice error -> "voice isn’t available…" and next allowed', (await page.locator('.wiz-result').textContent())!.startsWith('voice isn’t available on this device') && !(await page.locator('[data-wiz="next"]').isDisabled()));
  await openWizard(page, url, 'steps=mic&quiet=1&t=0.1');
  await waitText(page, 'too quiet', 8000);
  check('mic: a quiet hum reads "too quiet — …iPhone mic in ⋯" and allows next', (await page.locator('.wiz-result').textContent())!.startsWith('too quiet') && !(await page.locator('[data-wiz="next"]').isDisabled()));
}

async function checkSetupRow(page: Page, url: string): Promise<void> {
  await openScene(page, url, 'four');
  await resetLogs(page);
  await tap(page, '[data-action="settings"]');
  await page.waitForTimeout(350);
  const sub = await page.locator('[data-row="setup"] .row-sub').textContent();
  await page.locator('[data-row="setup"]').tap();
  await page.waitForTimeout(350);
  check('settings: Setup row calls openSetup and closes the sheet', sub === 'listening, mic, latency, drums, voice' && (await actions(page)).join() === 'openSetup' && (await page.locator('.sheet-layer.open').count()) === 0, (await actions(page)).join());
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
    await shootWizard(page, dev.url);
    await checkStart(page, dev.url);
    await checkGestures(page, dev.url, cdp);
    await checkSheets(page, dev.url);
    await checkLaneMenu(page, dev.url, cdp);
    await checkSetupRow(page, dev.url);
    await checkWizard(page, dev.url, cdp);
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
