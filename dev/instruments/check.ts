// [instruments] `node dev/instruments/check.ts [chromium|webkit …]` — renders every instrument offline in headless
// Chromium and WebKit (dev/instruments/page.ts), prints a PASS/FAIL table, writes the renders to
// dev/instruments/out/<engine>/<name>.wav (gitignored) for listening, and exits 1 when any check fails.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, type Engine } from '../lib/browser.ts';
import { startDev } from '../lib/serve.ts';
import type { CheckRun } from './page.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const picked = process.argv.slice(2).filter((a): a is Engine => a === 'chromium' || a === 'webkit');
const engines: Engine[] = picked.length ? picked : ['chromium', 'webkit'];

const served = await startDev(root);
let failed = 0;
try {
  for (const engine of engines) {
    const browser = await launch(engine);
    try {
      const page = await browser.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') console.log(`  [${engine} console.error] ${m.text()}`);
      });
      page.on('pageerror', (e) => console.log(`  [${engine} pageerror] ${e.message}`));
      await page.goto(`${served.url}dev/instruments/index.html`);
      await page.waitForFunction(() => typeof window.runInstrumentChecks === 'function');
      const run: CheckRun = await page.evaluate(() => window.runInstrumentChecks());
      run.results.push(...(await page.evaluate(() => window.runRealtimeSmoke())));
      const outDir = path.join(here, 'out', engine);
      await mkdir(outDir, { recursive: true });
      await Promise.all(
        Object.entries(run.wavs).map(([name, b64]) => writeFile(path.join(outDir, `${name}.wav`), Buffer.from(b64, 'base64'))),
      );
      console.log(`\n${engine} — ${run.results.length} checks in ${(run.ms / 1000).toFixed(1)} s, WAVs in ${path.relative(root, outDir)}/`);
      for (const r of run.results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await served.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
