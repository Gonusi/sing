# Tester notes (area: tester)

Owner files: `src/app/test-hooks.ts`, `playwright.config.ts`, `e2e/` (specs, `helpers.ts`, `global-setup.ts`), this file.
Last full run: 2026-10-19, branch `tester3` from integration branch `tempo` (round 4 transport + mute b3d11a4).

## How to run
- Everything (Chromium + WebKit, ≈ 19 min incl. voice-real; the count-ins and whole-bar loops made specs longer): `npx playwright test`
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

## Status (2026-10-19, tester3 = tempo b3d11a4 + round-4 specs)

| spec | Chromium | WebKit | what it proves |
|---|---|---|---|
| boot | pass (2) | pass (2) | start → stage, idle ("ready"), no errors; SW + manifest |
| first-take | pass | pass | count-in → take from the downbeat: 16/16 notes ≤ 13 ms; sched exact; output played 16/16 |
| overdub | pass | pass | punch-in ×3 (violin, bass, drums wired): takes exact; silent until ts + L; 150/150 exactly once; lanes audible |
| states | pass | pass | round-4 table: count-in cancel (record/pause/undo), bar-rounded first take, pause/resume at the playhead, punch in/out, record from stopped = count-in + one cycle from the playhead, mute/back, seek |
| **transport** | pass (4) | pass (4) | count-in = one bar (D − c0 = bar), countdown 4→1 in view + `.tp-state`, 4 clicks on the grid ±2 ms; punch in/out keeps playing, each note first replays one loop after it was sung; pause holds `.tp-pos`, play resumes at P; ⏮ jumps to 0 while playing; a lane tap seeks to the nearest beat (playing + paused), never creates a lane |
| **tempo** | pass (5) | pass (5) | bars round half up (1.4→1, 1.55→2, 0.3→1, 2.6→3); 80→100 bpm rescales notes/hits ×0.8, bar position kept (0.1202→0.1202), only rescaled positions play; locked with a vocal take (toast, `.tempo.locked`), undo unlocks; bpm tap toggles fx.click (`.muted`); pulse 12 backgrounds/beat playing, 1 paused; speaker: clicks heard by the mic → 0 drum hits (wired: 8) |
| calibration | pass (4) | pass (4) | loopback outLat + 80/200 ms → inLat within 0.1 ms; echo overdub ≤ 22 ms |
| persist | pass | pass | reload → paused, same session; offline boot, violin audible |
| ui | pass (3) | pass (3) | screenshots incl. count-in; sheets; transport buttons |
| vocals | pass (3) | pass (3) | lag 0.0 ms NCC 0.999; overdub onsets ≤ 0.7 ms; persist + clear |
| echo | pass (2) | pass (2) | dry 0; repeat +330 ms at 0.50× |
| voice / voice-real | pass (2) / pass | pass (2) / n/a | logic; real vosk |
| fake-mic | pass | n/a | real getUserMedia (`?nosetup&mute`), ● count-in → 12 notes, 3 bars |
| bugs | 4 regressions pass | 4 regressions pass | undo after record-from-stopped (now: cancels the count-in), sheet-close press, vocal seam clicks, phantom hats |

Totals: full run 67 passed + 1 failed (tempo bar rounding: a float tie at exactly 2.5 bars, a test-input artefact,
fixed by not stopping exactly on a half bar; tempo.spec then passed 2× on both engines), 19.3 min incl. voice-real.
Screenshots `e2e/out/<project>-*.png` (count-in, recording, four-playing checked by eye: fine), absolute folder
`/Users/kasparasanusauskas/Projects/personal/sing-worktrees/tester3/e2e/out/`.

## Product bugs
Open: none found in round 4. All earlier bugs are fixed and run as regressions in `e2e/bugs.spec.ts` (undo after
record-from-stopped, sheet-close press, vocal seam clicks, phantom hats, double discard log).

## Observations (not bugs, for the owner / area agents)
- **bar rounding tie:** stopping exactly 2.5 bars after the downbeat rounds DOWN (stop − D is a float hair under
  2.5 bars). Round-half-up with an epsilon would make it exact; a real tap never ties, so cosmetic.
- **position display:** the count-in bar shows as 1.x and the take restarts at 1.1 from the downbeat (by design per
  notes/engine.md; the owner may expect the count-in to be bar 0).
- **segmenter vs polyphonic synth:** short slurred notes are re-detected 50–120 ms early from the synth's output (release
  tails); affects only re-detection checks, not takes from a voice.
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

## Round 4 decisions (transport, tempo, metronome) — tester3, 2026-10-19
- **Recording goes through `transport('record')`** (hook `__sing.transport(action, tDown?)`, plus `seek`, `setTempo`,
  `setClick`). helpers `firstTake` sets the tempo so the requested L is a whole number of bars (`bpmFor`, rounded to
  setTempo's 0.01 bpm; `run.L` is the real loop), records (one-bar count-in), reads t0 = the downbeat D from the take's
  start event, injects the fixture at t0 + lead and stops with `transport('record')` at t0 + run.L. `overdub` punches in
  with `transport('record')` while playing. Expected positions come from D, not from a tap.
- **A tap no longer records** anywhere; UI specs press the transport buttons (`.tp-btn[data-button=record|playPause|toStart]`)
  and read `.tp-state` (ready · count-in N · recording · playing · paused), `.tp-pos`, `.tp-right` ("n bars"). The old
  `.pill` is gone.
- **Drum takes on speakers drop hits within −10/+40 ms of each metronome click** (by design). Specs that test drum
  detection (overdub, echo, tempo rescale) set `device.output = 'wired'`; tempo.spec proves the speaker exclusion with a
  calibrated loopback (speaker: 0 hits; wired: the clicks become 8 snares).
- **Master captures** (echo) switch the metronome off: clicks go into the master (never the echo bus).
- **Host outLat**: this Mac's default output reported 0.18 s (Bluetooth?) on 2026-10-19. Calibration loopbacks are now
  `outLat + 80/200 ms` (a fixed 120 ms is shorter than outLat and calibrates on the next click).
- **Echo-overdub consistency** compares notes ≥ 0.2 s within ±25 ms: the slurred F4 cut by the slice end (0.14 s) is
  re-detected 50–120 ms early from the polyphonic synth in 1–2 of 3 runs (segmenter limitation, not timing).
- **Silence**: the engine mutes the final output under `?test`/`?mute`; captures tap before it. The fake-mic spec (no
  `?test`) loads `?nosetup&mute`.
