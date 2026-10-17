// [shell] Icon generation config: `npx pwa-assets-generator --config dev/ui/icons.config.ts` turns public/logo.svg
// into the PNGs/ICO in public/. Same as `--preset minimal-2023`, except the maskable and apple icons get a dark
// background instead of sharp's default white (those two are full-bleed: the OS masks the corners itself).
import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

const BACKGROUND = '#0b0b0f';
const MASKABLE_PADDING = 0.1;
const APPLE_PADDING = 0.05;

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: MASKABLE_PADDING, resizeOptions: { background: BACKGROUND } },
    apple: { ...minimal2023Preset.apple, padding: APPLE_PADDING, resizeOptions: { background: BACKGROUND } },
  },
  images: ['public/logo.svg'],
});
