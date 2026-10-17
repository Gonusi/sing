// Shared by every dev/e2e script: launch a Playwright browser set up for Web Audio without a human.
import { chromium, webkit, type Browser } from '@playwright/test';

export type Engine = 'chromium' | 'webkit';

export interface LaunchOptions {
  /** feed this WAV (16-bit PCM or float) as the real getUserMedia mic (chromium only) */
  fakeMicWav?: string;
  headless?: boolean;
}

export async function launch(engine: Engine = 'chromium', opts: LaunchOptions = {}): Promise<Browser> {
  const headless = opts.headless ?? true;
  if (engine === 'webkit') return webkit.launch({ headless });
  const args = ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'];
  if (opts.fakeMicWav) {
    args.push('--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${opts.fakeMicWav}%noloop`);
  }
  // Playwright adds --mute-audio: the Web Audio graph still renders, only the speakers stay silent.
  return chromium.launch({ headless, args });
}
