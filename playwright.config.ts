// [tester] Playwright e2e config. One production build + `vite preview` on a free port (e2e/global-setup.ts), URL in
// process.env.SING_URL (workers inherit it). Env: SING_URL=<url> uses a running server, SING_SKIP_BUILD=1 reuses dist/,
// PORT=<n> fixes the preview port. One worker: real-time audio specs must not compete for CPU.
// Projects: chromium (everything) and webkit (everything except voice-real / fake-mic, which need Chromium flags).
import { defineConfig } from '@playwright/test';

const IPHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true };

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/out/results',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // audio runs in real time: a 4-lane overdub spec takes ~60 s
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['json', { outputFile: 'e2e/out/results.json' }]],
  use: { trace: 'retain-on-failure', actionTimeout: 20_000 },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        ...IPHONE,
        isMobile: true,
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
    },
    {
      name: 'webkit',
      use: { browserName: 'webkit', ...IPHONE },
      testIgnore: [/voice-real\.spec/, /fake-mic\.spec/],
    },
  ],
});
