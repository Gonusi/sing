// [tester] Playwright global setup: fixtures (dsp generator) if missing, then one production build + vite preview on a
// free port. Exports the URL as process.env.SING_URL (workers inherit it); the returned function is the teardown.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startPreview } from '../dev/lib/serve.ts';

const ROOT = join(import.meta.dirname, '..');

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (!existsSync(join(ROOT, 'dev/fixtures/out/sing-cmaj.json'))) {
    execFileSync(process.execPath, [join(ROOT, 'dev/make-fixtures.ts')], { stdio: 'inherit', cwd: ROOT });
  }
  if (process.env.SING_URL) return undefined;
  const served = await startPreview(ROOT, { skipBuild: process.env.SING_SKIP_BUILD === '1' });
  process.env.SING_URL = served.url;
  console.log(`[e2e] serving ${served.url}`);
  return () => served.close();
}
