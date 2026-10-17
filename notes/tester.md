# Tester notes (area: tester)

Owner files: `src/app/test-hooks.ts`, `playwright.config.ts`, `e2e/` (specs, `helpers.ts`, `global-setup.ts`), this file.
Last full run: 2026-10-17, branch `tester` with main merged (instruments + engine follow-up), voice not merged yet.

## How to run
- Everything (Chromium + WebKit, ≈ 5.2 min): `npx playwright test`
- One engine: `npx playwright test --project=chromium` (≈ 2.6 min) · one spec: `npx playwright test overdub --project=webkit`
- Headed: `npx playwright test ui --project=chromium --headed`
- Fast iteration: `SING_SKIP_BUILD=1` reuses `dist/` (run `npx vite build` after product changes); `SING_URL=<url>` uses a
  running server; `PORT=<n>` fixes the preview port (default: a free port).
- Global setup generates `dev/fixtures/out/` if missing (`node dev/make-fixtures.ts`), builds once, serves `vite preview`.
- Output: `e2e/out/` (gitignored): screenshots `<project>-<name>.png`, `results.json`, per-lane dumps
  `overdub-<project>-<kind>[-frames].json`, traces of failures in `e2e/out/results/`.
- Flakiness check: `npx playwright test overdub first-take states --project=chromium --repeat-each=3`.

## Status (2026-10-17, after merging main with instruments + engine follow-up)

| spec | Chromium | WebKit | what it proves |
|---|---|---|---|
| boot | pass (2) | pass (2) | start → stage, idle, no console/page errors; SW active + controlling, scope `/sing/`; manifest + icons |
| first-take | pass | pass | 16/16 notes, midi exact, pos err ≤ 13 ms; sched `when` err 0.0 ms; 16/16 exactly once; synth output re-detected 16/16 ± 40 ms (max 13–29 ms) |
| overdub | pass | pass | synth + violin + bass + drums: takes 8/8, 8/8 (bass −12), 8/8, 16/16 hits (kinds right); new lanes silent until ts + L; 15 s × 4 lanes: 148/148 exactly once, 0 drops; every lane audible and on pitch; speaker-feed peak 0.505 |
| states | pass | pass | full state-table walk incl. refusals + error logs, discard, too-short, commit-so-far, one-cycle overdub from stopped, voice on/off |
| calibration | pass (4) | pass (4) | loopback 120/250 ms → inLat = d − outLat + 6 ms within 0.1 ms; no clap → not ok, device untouched; echo overdub of the looped-back loop lands within 8.7 ms of the original positions |
| persist | pass | pass | flush → reload → same session, stopped, both lanes play; offline reload → boots from the SW, violin audible |
| ui | pass (2) | pass (2) | screenshots; ＋ sheet creates + selects; strip tap selects, 2nd tap toggles; real pointer tap records/stops; real hold shows the overlay |
| voice (logic) | pass (2) | pass (2) | hold + inject → command at the hold's tDown; non-grammar text → nothing; every grammar phrase |
| voice-real | skipped | n/a | pending on the voice merge: needs `recognizer.status` → `ready` and `dev/fixtures/out/speech/manifest.json` |
| fake-mic | pass | n/a | real getUserMedia (Chromium fake capture) → 9 notes in the line's order |
| bugs | 2 expected failures | 2 expected failures | open product bugs, see below (`test.fail()`: flips to "unexpected pass" when fixed) |

Totals: 33 passed, 1 skipped, 2 expected-fail repros; 5.2 min for both engines. Flakiness: 0 failures in 3 repeats of
first-take + overdub + states after the engine merge. Seen once before it: the violin overdub take placed one of 8
notes > 30 ms off (76@2.085, "extra 1"); not reproduced since.

Screenshots (checked by eye, all render correctly): `e2e/out/chromium-{empty,plus,settings,command,recording,
first-take-playing,four-stopped,four-playing,four-bass-off}.png` (+ the same for webkit). Absolute folder:
`/Users/kasparasanusauskas/Projects/personal/sing-worktrees/tester/e2e/out/`.

## Product bugs found

1. **engine: undo right after record-from-stopped destroys the loop** (`e2e/bugs.spec.ts`, test.fail).
   Repro: stopped → `record` (tDown t) → `undo` with tDown < origin (origin = t + outLat + 0.03, ≈ 50–75 ms window).
   Got `{state: 'idle', loopLength: null, tracks: 0}`; expected the pending overdub discarded, state playing, first take kept.
   Cause: `src/app/controller.ts` `startOverdub(origin, tDown)` → `setState('overdubbing', ts)` stamps the transition
   at `ts = origin` (future); `stateAt(tDown)` then reads `playing` → `popUndo` pops the first-take commit, and the
   active overdub take stays alive in idle (would commit into a loop-less session at its window end).
   Reachable only through commands (voice), not taps; narrow window. Fix idea: stamp the overdubbing transition at
   tDown (and keep ts = origin for the window), or treat `undo` while `take?.mode === 'overdub'` as discard regardless.
2. **shell: a press within ~200 ms of closing a sheet is swallowed** (`e2e/bugs.spec.ts`, test.fail).
   `src/ui/style.css` `.sheet-layer`: `visibility` stays `visible` for `--sheet-ms` after `.open` is removed (for the
   fade-out), so the closing layer (data-no-gesture) catches the pointerdown. Fix: `pointer-events: none` on
   `.sheet-layer:not(.open)`.
3. **engine (cosmetic): a too-short first take logs `take discard` twice** (`too-short`, then `discarded` from
   `discardTake()` in `finishFirstTake`). Log consumers counting discards double-count. Not failing any spec.

## Observations (not bugs, for the owner / area agents)
- **dsp:** the segmenter's energy onset refinement can put an onset 60–70 ms early when the previous note's release tail
  still sounds (seen re-detecting the polyphonic synth output: F4/A4 after a gap). Irrelevant for dry singing; could
  matter in a reverberant room. The e2e output checks therefore use pitch frames, not only the segmenter.
- **register fit:** the bass lane plays sing-low (A2–A3) at −12 → down to A1 (55 Hz). Below the pitch tracker's 70 Hz
  floor and below phone speakers' range (harmonics carry the pitch). Worth listening to on the iPhone.
- **master level:** before the engine's limiter, 4 lanes peaked at 1.03 on the master; now the speaker feed peaks 0.505.
- **test mic:** in `?test` the mic is digital silence; a fixture starting out of it was a sharp onset (a spurious drum
  hit). Specs now inject a −45 dBFS room-noise bed (`mic.noise`). A real device delivering hard digital silence (a noise
  gate) could give a spurious first hit — low risk.

## Test hooks (`window.__sing`, `src/app/test-hooks.ts`, only with `?test`)
Contract fields + extras (type `SingE2eApi`): `command()` returns `accepted`; uncapped `log()`/`logSince(t)`; `outLat`,
`sampleRate`, `waitUntil(t)` (context clock); `mic.load/put/cached/play(url, at, {from, dur, gain})/noise(dbfs)`;
named captures `capture.begin(key, trackId | null | '__out')` / `end` / `analyze` (real dsp) / `frames` (pitch frames) /
`level` / `salience` (Goertzel harmonics, for bass below 70 Hz); `analyze(pcm, sr, frame, kind)`; `loopback(d)` /
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
