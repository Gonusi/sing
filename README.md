# Sing

Sing a melody, hear it back on an instrument, and loop it. Beatbox for drums. A PWA for iPhone, Android and desktop, served at https://kasparasanusauskas.com/sing/.

- **Use:** tap to record; tap again to stop, and the loop starts. Hold anywhere and say a command, then release.
- **Commands:** `create drum|violin|synth|bass track`, `record`, `stop`, `play`, `undo`, `mute <instrument>`, `<instrument> back`.
- **＋** adds a track without voice. **⋯** opens settings: echo cancellation, latency calibration, audio probe, export the last take as WAV, clear the session.
- Wear wired headphones when overdubbing.

Spec: [SPEC.md](SPEC.md). Plan and progress: [PLAN.md](PLAN.md). Per-area notes: [notes/](notes/).

## Run
```
npm ci
npm run fetch-model      # 41 MB speech model → public/vosk/ (gitignored); VOSK_MODEL_CACHE=<file> copies a local copy
npm run dev              # http://localhost:5173/sing/  (phone on the LAN: the mic needs HTTPS, so use the deployed site)
npm run build && npm run preview
```

## Check
| what | command | time |
|---|---|---|
| types | `npx tsc` | seconds |
| note/drum detection on synthetic fixtures | `node dev/make-fixtures.ts && node dev/analyze.ts` | seconds |
| any WAV (e.g. a take exported from the phone) | `node dev/analyze.ts take.wav [--drums]` | seconds |
| engine timing/state checks | `node dev/engine/check.ts all` | ~2 min |
| instrument renders (WAVs land in `dev/instruments/out/`) | `node dev/instruments/check.ts` | ~1 min |
| UI screenshots (fake data) | `node dev/ui/shots.ts` → `dev/ui/out/` | ~30 s |
| voice accuracy (needs `node dev/voice/make-speech.ts`) | `node dev/voice/check.ts --fast` | ~70 s |
| full app end to end, mocked mic, Chromium + WebKit | `npx playwright test` → screenshots in `e2e/out/` | ~6 min |

Every server takes a free port (`PORT` overrides it).

## Deploy (GitHub Pages)
1. Push `main` to `git@github.com-gonusi:Gonusi/sing.git`.
2. Pages is not enabled for the repo yet. Enable it once, with GitHub Actions as the source:
   `GH_TOKEN=$(gh auth token --user Gonusi) gh api -X POST repos/Gonusi/sing/pages -f build_type=workflow`
   (or Settings → Pages → Source: GitHub Actions).
3. `.github/workflows/deploy.yml` builds on every push to `main`: `npm ci`, `fetch-model`, `build`, then deploy.
4. Re-run the workflow from the Actions tab.

## iPhone checklist (first session)
1. Open https://kasparasanusauskas.com/sing/ in Safari → Share → Add to Home Screen → open the installed app.
2. Tap to start and allow the mic. iOS asks again on every cold launch; that is a known WebKit behaviour.
3. ⋯ → Audio probe, with and without wired headphones, and with echo cancellation on and off. Is the tone loud and clean, or quiet, coming from the earpiece, or crackling? (WebKit bug 326286 on iOS 27.)
4. ⋯ → Calibrate latency (clap on each click, wearing headphones).
5. Sing a first take, then overdub violin, bass and beatboxed drums. Does the loop sound in time?
6. Hold and say "create violin track". Watch the voice % in the status pill on first launch; the model download is 41 MB.
7. ⋯ → Export last take (WAV): send a few takes back. They become real test fixtures for retuning detection.
