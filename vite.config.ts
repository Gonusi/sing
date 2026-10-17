import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served at https://kasparasanusauskas.com/sing/ (GitHub Pages project site of Gonusi/sing).
export default defineConfig({
  base: '/sing/',
  server: { host: true },
  preview: { host: true },
  build: { target: 'es2022', rollupOptions: { input: { main: 'index.html' } } },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: '/sing/',
        name: 'Sing',
        short_name: 'Sing',
        description: 'Sing a melody, hear it back on an instrument, loop it.',
        start_url: '/sing/',
        scope: '/sing/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,mp3,webmanifest}'],
        // vosk caches its 41 MB model in IndexedDB itself; never precache it.
        globIgnores: ['vosk/**', 'dev/**'],
        // the lazily loaded vosk-browser chunk is ~5.8 MB
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
});
