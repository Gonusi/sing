// [tester] The real getUserMedia path (no ?test): Chromium's fake capture device plays a WAV as the microphone
// (--use-file-for-fake-audio-capture=<wav>%noloop, --use-fake-ui-for-media-stream). The WAV = 3 s of room noise +
// sing-cmaj, so the singing starts after the record tap. Recording through the real transport buttons (● count-in, ● stop).
// State is read the way a user's device holds it: the session in IndexedDB (idb-keyval 'keyval-store'/'keyval',
// key sing.session.v1, saved 250 ms after a change) plus the DOM status pill. No product debug hooks.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Session } from '../src/types.ts';
import { readWavMono, writeWav } from '../dev/wav.ts';
import { launch } from '../dev/lib/browser.ts';
import { FIXTURE_DIR, OUT_DIR, SESSION_KEY, boot, groundTruth, idbGet, stateWord, watchErrors } from './helpers.ts';

const LEAD_SEC = 3;

test('fake capture device → real mic path → a take with the sung notes', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium-only flags');
  test.setTimeout(120_000);
  const src = readWavMono(join(FIXTURE_DIR, 'sing-cmaj.wav'));
  const lead = Math.round(LEAD_SEC * src.sampleRate);
  const x = new Float32Array(lead + src.samples.length);
  for (let i = 0; i < lead; i++) x[i] = src.samples[i % Math.round(0.4 * src.sampleRate)]; // the fixture's own room noise
  x.set(src.samples, lead);
  mkdirSync(OUT_DIR, { recursive: true });
  const wav = join(OUT_DIR, 'fake-mic.wav');
  writeWav(wav, x, src.sampleRate);

  const browser = await launch('chromium', { fakeMicWav: wav });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = watchErrors(page);
    const t0 = Date.now();
    // real mic path without the first-launch setup wizard; ?mute keeps the Mac speakers silent
    await boot(page, { query: 'nosetup&mute' });
    await page.waitForTimeout(300);
    await page.locator('.tp-btn[data-button="record"]').click(); // ● → one-bar count-in → recording
    await expect(stateWord(page)).toHaveText(/count-in/);
    await expect(stateWord(page)).toHaveText('recording', { timeout: 5000 });
    const recordedAt = (Date.now() - t0) / 1000;
    await page.waitForTimeout(8500);
    await page.locator('.tp-btn[data-button="record"]').click(); // stop recording (whole bars)
    await expect(stateWord(page)).toHaveText('playing');
    await page.waitForTimeout(1000); // debounced save (250 ms)
    const s = await idbGet<Session>(page, SESSION_KEY);
    expect(s).toBeTruthy();
    const notes = s!.tracks[0]?.take?.notes ?? [];
    console.log(`[fake-mic] record tapped ${recordedAt.toFixed(1)} s after boot start; loop ${s!.loopLength?.toFixed(2)} s; ${notes.length} notes: ${notes.map((n) => `${n.midi}@${n.pos.toFixed(2)}`).join(' ')}`);
    // the take covers ~3 bars (8 s at 90 bpm) of the 11.4 s line: at least 7 notes, all from the sung scale, in order
    expect(notes.length).toBeGreaterThanOrEqual(7);
    const scale = new Set(groundTruth('sing-cmaj').notes.map((n) => n.midi));
    expect(notes.every((n) => scale.has(n.midi))).toBe(true);
    const line = groundTruth('sing-cmaj').notes.map((n) => n.midi).join(',');
    expect(line).toContain(notes.map((n) => n.midi).join(','));
    expect(errors.filter((e) => !/vosk|voice/i.test(e)), errors.join('\n')).toEqual([]);
  } finally {
    await browser.close();
  }
});
