// [tester] The REAL recogniser (vosk) end to end: ?test&voice, a persistent profile so the 41 MB model downloads once
// (e2e/out/voice-profile), speech fixtures from dev/fixtures/out/speech/ injected into the mic during a real pointer
// hold → the expected command happened (or nothing, for negative fixtures).
// Skips (with the reason) until the voice branch is merged: recogniser status never leaves 'off', or no fixtures.
// Manifest (assumed, written by the voice agent): dev/fixtures/out/speech/manifest.json =
//   [{ "file": "x.wav", "text": "create violin track", "command": {Command} | null }]  (command null = must do nothing)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import type { Command } from '../src/types.ts';
import { FIXTURE_DIR, OUT_DIR, boot, putFixtures } from './helpers.ts';

interface SpeechCase {
  file: string;
  text?: string;
  command: Command | null;
}
const MANIFEST = join(FIXTURE_DIR, 'speech', 'manifest.json');
const SPOT = { x: 230, y: 470 };

test('real recogniser: speech fixtures during a hold → the expected command', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'voice e2e runs on Chromium only');
  test.skip(!existsSync(MANIFEST), `no speech fixtures (${MANIFEST}): voice branch not merged`);
  test.setTimeout(600_000);
  const cases = JSON.parse(readFileSync(MANIFEST, 'utf8')) as SpeechCase[];
  const context = await chromium.launchPersistentContext(join(OUT_DIR, 'voice-profile'), {
    viewport: { width: 390, height: 844 },
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await boot(page, { query: 'test&voice' });
    const status = await page.evaluate(async () => {
      const s = window.__sing!;
      for (let i = 0; i < 1800 && (s.voice.status() === 'loading' || s.voice.status() === 'off'); i++) {
        if (s.voice.status() === 'off' && i > 20) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return s.voice.status();
    });
    test.skip(status === 'off', 'recogniser is the stub (status off): voice branch not merged');
    expect(status).toBe('ready');
    const results: string[] = [];
    let failures = 0;
    for (const c of cases) {
      const name = `speech/${c.file.replace(/\.wav$/, '')}`;
      await putFixtures(page, [name]);
      const before = await page.evaluate(() => window.__sing!.log().filter((e) => e.type === 'command').length);
      await page.mouse.move(SPOT.x, SPOT.y);
      await page.mouse.down();
      await page.waitForTimeout(350);
      const dur = await page.evaluate(async (url) => {
        const s = window.__sing!;
        const at = await s.mic.play(url, s.now() + 0.05);
        const info = await s.mic.load(url);
        await s.waitUntil(at + info.duration + 0.3);
        return info.duration;
      }, `/__fixtures/${name}.wav`);
      await page.mouse.up();
      await page.waitForTimeout(1500);
      const cmds = await page.evaluate((n) => window.__sing!.log().filter((e) => e.type === 'command').slice(n).map((e) => e.data!.command), before);
      const got = (cmds[0] as Command | undefined) ?? null;
      const ok = JSON.stringify(got) === JSON.stringify(c.command) && cmds.length <= 1;
      if (!ok) failures++;
      results.push(`${ok ? 'ok  ' : 'FAIL'} ${c.file} (${dur.toFixed(1)} s) expected ${JSON.stringify(c.command)} got ${JSON.stringify(cmds)}`);
      // keep the session small: undo what a create did
      if (got?.type === 'create') await page.evaluate(() => window.__sing!.command({ type: 'undo' }));
    }
    console.log(`[voice-real]\n${results.join('\n')}`);
    expect(failures, results.filter((r) => r.startsWith('FAIL')).join('\n')).toBe(0);
  } finally {
    await context.close();
  }
});
