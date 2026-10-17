# Tester notes (area: tester)

Owner files: `src/app/test-hooks.ts`, `playwright.config.ts`, `e2e/` (specs, `helpers.ts`, `global-setup.ts`), this file.
Last full run: 2026-10-17, branch `tester2` from main 0f5f3c9 (MVP+: vocal tracks, echo bus, voice merged).

## How to run
- Everything (Chromium + WebKit, ≈ 7.5 min without voice-real, + 4.1 min with it): `npx playwright test`
- voice-real needs the model (`npm run fetch-model`, VOSK_MODEL_CACHE=<tar.gz> copies a local one) and the speech
  fixtures (`node dev/voice/make-speech.ts`, ≈ 80 s, gitignored); without them it skips with the reason.
- One engine: `npx playwright test --project=chromium` (≈ 3.9 min without voice-real) · one spec: `npx playwright test overdub --project=webkit`
- Headed: `npx playwright test ui --project=chromium --headed`
- Fast iteration: `SING_SKIP_BUILD=1` reuses `dist/` (run `npx vite build` after product changes); `SING_URL=<url>` uses a
  running server; `PORT=<n>` fixes the preview port (default: a free port).
- Global setup generates `dev/fixtures/out/` if missing (`node dev/make-fixtures.ts`), builds once, serves `vite preview`.
- Output: `e2e/out/` (gitignored): screenshots `<project>-<name>.png`, `results.json`, per-lane dumps
  `overdub-<project>-<kind>[-frames].json`, traces of failures in `e2e/out/results/`.
- Flakiness check: `npx playwright test overdub first-take states --project=chromium --repeat-each=3`.

## Status (2026-10-17, tester2 = main 0f5f3c9 + MVP+ specs)

| spec | Chromium | WebKit | what it proves |
|---|---|---|---|
| boot | pass (2) | pass (2) | start → stage, idle, no console/page errors; SW active + controlling, scope `/sing/`; manifest + icons |
| first-take | pass | pass | 16/16 notes, midi exact, pos err ≤ 13 ms; sched `when` err 0.0 ms; exactly once; synth output re-detected 16/16 |
| overdub | pass | pass | synth + violin + bass + drums takes exact; new lanes silent until ts + L; 148/148 exactly once; every lane audible and on pitch |
| states | pass | pass | state-table walk (toggles are now `mute X` / `X back`) |
| calibration | pass (4) | pass (4) | loopback → inLat = d − outLat + 6 ms within 0.1 ms; echo overdub of the loop within 8.7 ms |
| persist | pass | pass | reload restores; offline reload boots from the SW, violin audible |
| ui | pass (3) | pass (3) | screenshots incl. vocals waveform + 5-kind ＋ sheet; `create vocal track` by voice |
| **vocals** | pass (3) | pass (3) | first take: lane output = injected audio at lag 0.0 ms, NCC 0.9992; exactly-once sched; overdub: 7/7 stored onsets at their loop pos (≤ 0.7 ms), lane exactly silent (peak 0) until ts + L, audible after; reload: audible, lag 0.0 ms NCC 0.9992; clear session → no `sing.audio.*` keys |
| **echo** | pass (2) | pass (2) | echo 0: nothing after the hat (0 rms); echo 1: repeat at +330.0 ms at 0.50×, 2nd weaker at +665 ms; slider → `session.fx.echo`, survives reload, undo keeps it, no gesture |
| voice (logic) | pass (2) | pass (2) | hold + inject; non-grammar → nothing; every phrase |
| voice-real | pass (4.1 min) | n/a | real vosk on generated speech fixtures (Samantha clean, Daniel noisy, negatives) |
| fake-mic | pass | n/a | real getUserMedia → 9 notes in order |
| bugs | 2 regressions pass, 2 expected failures | 2 regressions pass, 2 expected failures | see below |

Totals: full run 48 passed + 1 skipped (voice-real without fixtures) + 3 expected failures, 7.5 min (the seam repro
was then made multi-take and is an expected failure on both engines: 4 expected failures in total); voice-real alone
4.1 min (passes). Screenshots: `e2e/out/<project>-{empty,plus,plus-five,settings,command,recording,first-take-playing,
four-stopped,four-playing,four-bass-off,vocals-recording,vocals-playing}.png`, absolute folder
`/Users/kasparasanusauskas/Projects/personal/sing-worktrees/tester2/e2e/out/` (checked by eye: all fine).

## Product bugs

Open (repro in `e2e/bugs.spec.ts`, `test.fail()`):
1. **engine, both engines, intermittent: one-sample clicks at vocal loop seams.** A vocals first take with the seam
   inside a sustained note (sing-cmaj, L 4.29 s): at cycle starts 2 and/or 3 exactly one output sample is doubled
   (−0.338 → −0.693 → −0.365: old tail + new cycle both at full level), one-sample spike 0.33–0.35 vs 0.018 steady;
   cycles 4, 5 always clean; in ~3 of 4 takes on Chromium and WebKit. All cycle starts were on integer frames. The
   repro tries up to 3 fresh takes (≈ 1.5% chance of an "unexpected pass" while the bug exists). Suspect `src/audio/vocal-voice.ts` `play()`: the new
   GainNode keeps its default gain 1 until `setValueAtTime(…, when)`, so a sample the source renders at its start
   frame before the automation applies passes at full level. Fix idea: `g.gain.value = 0` (or
   `setValueAtTime(0, ctx.currentTime)`) before the start automation; check with this repro.
2. **engine/dsp: phantom hats in an empty drum first take at −45 dBFS room noise** (the fixtures' own level). Got
   `hat@0.029, hat@0.227`; −60 dBFS and silence: none. The 2nd lands right after the 80 ms record-beep exclusion
   (`src/loop/take.ts` zeroExcluded zeroes analysis input without ramps; noise resuming from 0 is a sharp onset);
   the 1st is unexplained (near t0). Real rooms are often −50…−60 dBFS, so it may or may not show on the phone.

Fixed since the last report (now regression tests): undo after record-from-stopped; press swallowed by a closing
sheet; double discard log.

## Observations (not bugs, for the owner / area agents)
- **dsp:** the segmenter's energy onset refinement can put an onset 60–70 ms early when the previous note's release tail
  still sounds (seen re-detecting the polyphonic synth output: F4/A4 after a gap). Irrelevant for dry singing; could
  matter in a reverberant room. The e2e output checks therefore use pitch frames, not only the segmenter.
- **register fit:** the bass lane plays sing-low (A2–A3) at −12 → down to A1 (55 Hz). Below the pitch tracker's 70 Hz
  floor and below phone speakers' range (harmonics carry the pitch). Worth listening to on the iPhone.
- **master level:** before the engine's limiter, 4 lanes peaked at 1.03 on the master; now the speaker feed peaks 0.505.
- **vocals waveform:** the 80 ms record-beep exclusion (now applied to vocals too) shows as a thin gap at the start
  of every vocal first take (screenshot vocals-playing); the audio there is silence.
- **echo:** the 2nd repeat of a hat is 0.06× the first (feedback goes through a 3.5 kHz lowpass, hats are > 5 kHz):
  expected by design.
- **test mic:** in `?test` the mic is digital silence; a fixture starting out of it was a sharp onset (a spurious drum
  hit). Specs now inject a −45 dBFS room-noise bed (`mic.noise`). A real device delivering hard digital silence (a noise
  gate) could give a spurious first hit — low risk.

## Test hooks (`window.__sing`, `src/app/test-hooks.ts`, only with `?test`)
Contract fields + extras (type `SingE2eApi`): `command()` returns `accepted`; uncapped `log()`/`logSince(t)`; `outLat`,
`sampleRate`, `waitUntil(t)` (context clock); `mic.load/put/cached/play(url, at, {from, dur, gain})/noise(dbfs)`;
named captures `capture.begin(key, trackId | null | '__out')` / `end` / `analyze` (real dsp) / `frames` (pitch frames) /
`level` / `salience` (Goertzel harmonics, for bass below 70 Hz) / `xcorr` (NCC vs a fixture at an assumed offset,
± lag search) / `envelope` / `maxJump` / `samples`; `setEcho(a)`; `mic.play(…, {fade})` (raised-cosine slice edges); `analyze(pcm, sr, frame, kind)`; `loopback(d)` /
`loopbackOff()`; `calibrate()` (+ `outLatAtStart`); `flush()`; `voice.inject(text, tDown = open hold's tDown ?? now)` /
`status()` / `injections()`; `ui()` (DOM: overlay, toast, pill).

## Decisions and why
- **Fixtures reach the page through `mic.put(url, base64)`** (helpers `putFixtures`), not only `page.route`: once
  WebKit's service worker controls the page, its fetches bypass Playwright's routing (404 from preview). Chromium still
  routes them (boot spec logs both). The SW stays on in every spec, as in production.
- **Timing is decided in-page**: each flow (first take, overdub) is one `page.evaluate` on the AudioContext clock;
  taps are sent 100 ms after their tDown (a realistic release), never with a future tDown.
- **Output checks use pitch frames** (`checkPlayed`): the first 3-frame run at the note's pitch inside
  [at − 40, at + 80] ms (40 ms tolerance + half the 43 ms window + the violin's 50 ms legato glide) and ≥ 60% of the
  sustain at pitch; plus the segmenter re-detection ±40 ms for ≥ 85% of notes (catches systematic shifts). Notes below
  70 Hz are checked by harmonic salience (2× any neighbour within ±2 semitones).
- **Exactness** (`helpers.exactness`): per transport run, sched ∪ drop = every occurrence heard in
  [max(from, activeFrom), scheduledUntil[track]) of the final session's events, each once; occurrences in the start's
  late zone may be skipped silently (the scheduler does not enumerate what it would drop).
- **4-lane screenshot** uses a session seeded into IndexedDB from fixture ground truth (fast, deterministic); the real
  4-lane flow is proven by overdub.spec.
- **fake-mic** reads state from IndexedDB (`keyval-store`/`keyval`, `sing.session.v1`) + the DOM pill: no product hook.
- **voice-real** assumes the manifest shape `[{file, text?, command | null}]` in `dev/fixtures/out/speech/`; adjust
  `e2e/voice-real.spec.ts` if the voice agent writes another shape.

## Next run could be faster
- Shorter fixtures for overdub (L 6.4 s → 3 s) would halve overdub.spec (43 s) with the same assertions.
- Parallel workers (not tried): the audio specs mostly wait on real time, so 2 workers could cut the 5.2 min nearly in half; check timing stability first.
- WebKit could skip the audio-heavy specs on every merge and run them nightly; Chromium covers them.

## MVP+ decisions (vocals, echo)
- **Vocal alignment** is checked on the lane's own output (strip capture) by normalised cross-correlation against
  the injected fixture at the offset the timing model predicts (`at − inLat − outLat + k·L`), lag searched ±10 ms:
  measured 0.0 ms, NCC 0.9992 (Int16 storage + fades are the only differences).
- **Stored audio** is read straight from IndexedDB (`sing.audio.<takeId>` = `{sampleRate, pcm: Int16Array}`); onsets
  by a 1 ms RMS rise detector (> 3× the previous 20 ms) — plain thresholds miss hits that follow a ringing kick.
- **Seam clicks** are measured as one-sample spikes `|x[n] − (x[n−1] + x[n+1])/2|` within ±2 ms of each cycle start
  vs. the 20–200 ms before it; the seam is put inside a sustained sung note so a doubled sample is visible.
- **Echo** uses a single hi-hat on a drums lane (short, > 5 kHz) and a 5 ms master envelope; the slider is driven with
  `locator.fill()` on `input.echo-slider`. The echo spec runs without the noise bed (phantom hats, bug 2).
