// [voice] Recogniser memory: `node dev/voice/memory.ts [chromium|webkit]` (macOS only: uses `footprint`).
// Measures phys_footprint — the number iOS jetsam enforces (iPhone Safari kills a page at ~2 GB, owner's observation) —
// of the process that runs the page and its vosk worker (WebKit: WebContent; Chromium: the page's renderer), plus
// the kernel's phys_footprint_peak (exact lifetime high-water mark) and the main-thread JS heap (Chromium only).
// Phases: booted (audio engine, no model) → cold load (download + unpack + IndexedDB write, fresh profile) →
// steady (+5 s) → 40 holds → browser relaunched on the same profile (fresh process, like every later app launch)
// → warm load (IndexedDB) → steady. The relaunch makes phys_footprint_peak the exact warm-load peak.
// The page is dev/voice/index.html?fast (no instruments: what is measured is engine + recogniser).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, type BrowserContext, type Page } from '@playwright/test';
import { startDev } from '../lib/serve.ts';
import { MANIFEST_PATH, type SpeechManifest } from './make-speech.ts';
import type { VoicePage } from './page.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT_DIR = join(import.meta.dirname, 'out');
const SAMPLE_MS = 100;
const STEADY_WAIT_MS = 5000;
const HOLDS = 40;
const MB = 1024 * 1024;

type Engine = 'chromium' | 'webkit';
type W = { __voice: VoicePage };

/** pids of the content process(es): WebKit WebContent of Playwright's build, or the renderers under this profile's browser */
function contentPids(engine: Engine, profileDir: string): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => !!m)
    .map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
  if (engine === 'webkit') return rows.filter((r) => r.cmd.includes('ms-playwright/webkit') && r.cmd.includes('WebKit.WebContent')).map((r) => r.pid);
  const tree = new Set(rows.filter((r) => r.cmd.includes(profileDir) && !r.cmd.includes('--type=')).map((r) => r.pid));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) (tree.add(r.pid), (grew = true));
  }
  return rows.filter((r) => tree.has(r.pid) && r.cmd.includes('--type=renderer')).map((r) => r.pid);
}

/** {footprint, peak} in MB of the largest content process */
function footprint(engine: Engine, profileDir: string): { mb: number; peakMb: number } {
  let best = { mb: 0, peakMb: 0 };
  for (const pid of contentPids(engine, profileDir)) {
    try {
      const o = execFileSync('footprint', ['-p', String(pid), '-f', 'bytes'], { encoding: 'utf8' });
      const mb = Number(/phys_footprint:\s*(\d+)/.exec(o)?.[1] ?? 0) / MB;
      const peakMb = Number(/phys_footprint_peak:\s*(\d+)/.exec(o)?.[1] ?? 0) / MB;
      if (mb > best.mb) best = { mb, peakMb };
    } catch {
      /* process gone */
    }
  }
  return { mb: Math.round(best.mb), peakMb: Math.round(best.peakMb) };
}

/** sample footprint while `work` runs; returns the work's result and the max sample */
async function sampled<T>(engine: Engine, dir: string, work: () => Promise<T>): Promise<{ result: T; maxMb: number }> {
  let maxMb = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      maxMb = Math.max(maxMb, footprint(engine, dir).mb);
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
  })();
  const result = await work();
  running = false;
  await loop;
  return { result, maxMb: Math.max(maxMb, footprint(engine, dir).mb) };
}

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(`${url}dev/voice/index.html?fast`);
  await page.click('#start');
  await page.waitForFunction(() => (window as unknown as W).__voice?.booted);
}

const jsHeapMb = async (page: Page) => {
  const b = await page.evaluate(() => (window as unknown as W).__voice.jsHeap());
  return b === null ? null : Math.round(b / MB);
};

async function main(): Promise<void> {
  const engine = (process.argv[2] ?? 'webkit') as Engine;
  const served = await startDev(ROOT);
  const dir = mkdtempSync(join(OUT_DIR, `mem-profile-${engine}-`));
  const launch = (): Promise<BrowserContext> => engine === 'webkit'
    ? webkit.launchPersistentContext(dir, { headless: true })
    : chromium.launchPersistentContext(dir, { headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  let ctx = await launch();
  const rows: Record<string, unknown>[] = [];
  const row = (phase: string, extra: Record<string, unknown> = {}) => {
    const r = { phase, ...footprint(engine, dir), ...extra };
    rows.push(r);
    console.log(`  ${phase.padEnd(22)} footprint ${String(r.mb).padStart(5)} MB · lifetime peak ${String(r.peakMb).padStart(5)} MB${Object.keys(extra).length ? ' · ' + JSON.stringify(extra) : ''}`);
  };
  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(180_000);
    await boot(page, served.url);
    row('booted (no model)', { jsHeapMb: await jsHeapMb(page) });
    const cold = await sampled(engine, dir, () => page.evaluate(() => (window as unknown as W).__voice.load()));
    row('cold load done', { ms: cold.result.ms, sampledMaxMb: cold.maxMb, jsHeapMb: await jsHeapMb(page) });
    await page.waitForTimeout(STEADY_WAIT_MS);
    row('cold +5 s (steady)', { jsHeapMb: await jsHeapMb(page) });
    const fixtures = (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SpeechManifest).fixtures.filter((f) => f.kind === 'command').slice(0, HOLDS);
    await ctx.route('**/__fixtures/**', (route) => route.fulfill({ path: join(import.meta.dirname, '..', 'fixtures', 'out', 'speech', decodeURIComponent(route.request().url().split('/').pop()!)) }));
    const holds = await sampled(engine, dir, async () => {
      for (const fx of fixtures) {
        await page.evaluate((o) => (window as unknown as W).__voice.hold(o), { url: `${served.url}__fixtures/${encodeURIComponent(fx.file)}`, speechEnd: fx.speechEnd, holdDelaySec: 0.3, releaseAfterSec: 0.3 });
      }
    });
    row(`after ${HOLDS} holds`, { sampledMaxMb: holds.maxMb, jsHeapMb: await jsHeapMb(page) });
    await ctx.close();
    ctx = await launch();
    const page2 = await ctx.newPage();
    page2.setDefaultTimeout(180_000);
    await boot(page2, served.url);
    row('relaunched, booted');
    const warm = await sampled(engine, dir, () => page2.evaluate(() => (window as unknown as W).__voice.load()));
    row('warm load done', { ms: warm.result.ms, sampledMaxMb: warm.maxMb, jsHeapMb: await jsHeapMb(page2) });
    await page2.waitForTimeout(STEADY_WAIT_MS);
    row('warm +5 s (steady)', { jsHeapMb: await jsHeapMb(page2) });
    writeFileSync(join(OUT_DIR, `memory-${engine}.json`), JSON.stringify(rows, null, 1));
  } finally {
    await ctx.close();
    await served.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
