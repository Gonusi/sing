# Sing — progress and plan

## Progress
- [x] Research (mic/pitch, playback/drums/legato, PWA/deploy/vosk) and reviewed plan — 2026-10-17
- [x] Scaffold: deps, configs, `src/types.ts` contract, stubs, wired `main.ts`, dev helpers (`dev/lib/`) — boots in Chromium + WebKit
- [ ] Wave 1 — dsp: analysis + fixtures + `dev/analyze.ts` passing
- [ ] Wave 1 — engine: context, mic, worklet, ring, latency, capture, probe, scheduler, take, controller, session
- [ ] Wave 1 — instruments: synth, bass, drums, violin phrase voice, blip, samples
- [ ] Wave 1 — shell: UI (start, input, lanes, status, sheets), icons, deploy workflow
- [ ] Wave 1 merged, `tsc` + build green
- [ ] Wave 2 — voice: fetch-model, check-grammar, recognizer, hold-to-talk
- [ ] Wave 2 — tester: test hooks + e2e suite
- [ ] Wave 3 — fix rounds until the e2e suite passes on Chromium (+ WebKit non-voice)
- [ ] Final report for the owner (push + Pages steps, iPhone checklist, spec deviations)
- [ ] Owner: "Push please" → push `main`, enable Pages, deploy, iPhone session 1


## Context
- **Spec:** `sing/SPEC.md` (copied from `~/Projects/personal/SPEC.md`). This file is the progress file (Progress section on top).
- **What the MVP does:** a universal PWA. You say "create drum / violin / synth / bass track", sing (beatbox for drums), and every track loops together. It runs on iPhone (the first test device), Android and desktop.
- **Hosting:** https://kasparasanusauskas.com/sing/ from `Gonusi/sing` (public, empty, `main`). Pages is **not enabled yet** (the API returns 404).
- **The owner is away and expects a working prototype on return**, with a minimal UI. Claude tests it end to end itself with a mocked mic. The owner's "no tests while prototyping" rule gives way to this ask.
- **Because the owner is away:**
  - **No push and no deploy** (pushing needs "Push please"). Everything is committed locally on `main`.
  - **No specialists this session**: agent files only load after a restart. Use general-purpose agents with exact briefs (`model` per agent); propose `/specialists` on return.
- **Decided:** iPhone first, beatbox drums, legato violin.

## Facts the design rests on (researched 2026-10-17)
- **Versions:** tone 15.1.22 · pitchy 4.1.0 (ESM, pure; depends on fft.js 4.0.4) · vite 8.3.4 · vite-plugin-pwa 2.0.0 (Vite 8 OK, Node ≥ 20.19; local Node 24.15) · typescript 7.0.2 (`tsc` works; bump the template's `~6.0` by hand) · idb-keyval 6.3.0 · vosk-browser 0.0.8 (fallback `@lichess-org/vosk-browser` 0.0.3) · @playwright/test 1.64.1 (browsers already cached) · @vite-pwa/assets-generator 2.0.0.
- **Tone Transport 15.1.22 has bugs** (double-firing #1500, bad wrap #1419) → **use Tone only for instruments; our own scheduler on the AudioContext clock.**
  - Tone's Context emits `"tick"`; setting `lookAhead` also sets `updateInterval = lookAhead/2`.
  - Create a native `AudioContext({latencyHint:'interactive'})` and call `Tone.setContext(ctx)` before any Tone node exists. **Rule: no Tone call at module scope**, only inside factories that run after `setContext`.
  - Load our worklet with `ctx.audioWorklet.addModule` directly (Tone's helper remembers only one URL).
- **Worklet import:** `import url from './mic-worklet.ts?worker&url'`.
- **iOS:**
  - Only `echoCancellation` is honoured. With EC off the mic is stereo with only the left channel live → read channel 0.
  - **WebKit 326286 (iOS 27):** EC on crackles; EC off → earpiece, quiet. Test on the device.
  - Mic permission is asked again on every cold launch; no hash routing.
  - Backgrounding → context `"interrupted"`: resume (suspend+resume if the clock is frozen) and re-acquire the mic.
  - Set `navigator.audioSession.type='play-and-record'`.
- **Pages:** no headers → no SharedArrayBuffer, so the worklet posts audio over a port. A 41 MB file is OK. Actions: checkout@v7, setup-node@v7, configure-pages@v6, upload-pages-artifact@v5, deploy-pages@v5.
- **vosk-browser:**
  - One 5.8 MB UMD file, own blob worker, no threads.
  - Model `vosk-model-small-en-us-0.15.tar.gz`: 41 MB, unpacks to 71 MB, cached by vosk in IndexedDB keyed by URL. Never precache it in the service worker. The URL must be **absolute**, including `/sing/`.
  - The grammar is a loose bigram LM → **validate results in code**; add `"[unk]"`. **"unmute" is not in the model.**
  - API: `createModel(url)`, `new model.KaldiRecognizer(sampleRate, grammarJson)`, `on('partialresult'|'result')`, `acceptWaveformFloat(f32, rate)`, `retrieveFinalResult()`.
- **Samples:** nbrosowsky/tonejs-instruments violin mp3s (VSCO 2 source; the repo says samples are CC-BY 3.0 → credit in settings).
  - Subset `G3 C4 E4 G4 C5 E5 G5 C6`, 2.64 MB.
  - Sampler-style keys are `A#3`, not `As3`.
  - Decode mono and trim to 8 s to save memory.
- **Tone.Sampler cannot do legato** → our own phrase voice on `Tone.ToneBufferSource` (with `playbackRate`, `loop`, `fadeIn`/`fadeOut`).
  - Monophonic synths do legato via `setNote` and `portamento`.
  - NoiseSynth and MetalSynth throw on same-time re-triggers → keep ≥ 10 ms per voice and try/catch.
- **Fake mic:**
  - Chromium `--use-file-for-fake-audio-capture=<wav>%noloop` (16-bit or float WAV).
  - Playwright adds `--mute-audio` (`ignoreDefaultArgs` removes it).
  - WebKit has a mock mic but no file input.

## MVP behaviour
**Gestures** (`ui/input.ts` emits `Gesture`; every time is `ctx.currentTime` at pointerdown = `tDown`):
- Tap (< 300 ms) = record / stop.
- Hold (≥ 300 ms) = command mode: tint plus live partial text, and vosk is fed from the ring buffer **from `tDown`**.
- Every action uses `tDown` as its time and is applied on release. The flash happens at touch-down, so it feels instant.
- The lane strip and buttons are outside the gesture layer.

**Commands:**
- `create drum|drums|violin|synth|bass track` · `record` · `stop` · `play` · `undo` · `<instrument> on` / `<instrument> off`.
- Matching is exact in code. A command fires early on a partial only if it is complete and not a prefix of another command; on/off needs 2 identical partials in a row. Otherwise it fires at `retrieveFinalResult()` on release.
- Fresh recognizer per hold. `dev/check-grammar.ts` checks every word against the model's `words.txt`.
- A command is read against the **state at `tDown`**.

**State machine** (`app/controller.ts`):

| State | Input → result |
|---|---|
| idle (no loop) | tap / record → **recordingFirst** (`t0 = tDown`; no lane → create a synth lane) |
| recordingFirst | tap / stop → **playing** (`L = tDown − t0`; if L < 1 s, discard and go to idle; auto-stop at 60 s)<br>undo → discard → idle<br>any other held command → apply it; the take continues, and audio from `tDown` to release is dropped from the take |
| playing | tap / record → **overdubbing** into the selected lane<br>stop → **stopped** |
| overdubbing | window end → commit → playing<br>tap → commit what was sung so far → playing<br>stop → commit so far → stopped<br>undo → discard → playing<br>create / record → error blip |
| stopped | tap / play → playing (`origin = now`)<br>record → playing + overdubbing |

`create X track` in any state adds and selects an empty lane.

**Timing model** (one rule for every take):
- `outLat = ctx.baseLatency + ctx.outputLatency`, read live.
- The scheduler plays loop position `p` at `when = origin + p + k·L − outLat`, so it is *heard* at `origin + p + k·L`.
- Mic block stamp = `frame/sampleRate`, where `frame` is the context frame of `samples[0]`.
- The corrected time of a sung event is `tc = stamp − inLat`, and its position is `pos = tc − origin`:
  - first take: clamp to [0, L], no wrap;
  - overdub: `mod L`.
- `inLat` comes from clap calibration: clicks scheduled with the outLat correction, `inLat = median(clapStamp − clickHeardTime)`. A wrong `outputLatency` cancels out.
  - Default `inLat` = `track.getSettings().latency ?? 0.01`.
  - Stored in `DeviceSettings` (not in the session, so undo can't revert it).
- **First take:** `origin = t0`; playback starts at stop, scheduled from `scheduledUntil = now`.
- **Catch-up:** if an event's time has already passed,
  - a sustained note still sounding starts now with a shortened duration;
  - a drum hit more than 30 ms late is dropped.
- **Overdub window:** exactly L long, `tc ∈ [ts, ts+L)`, with `ts = tDown`.
  - A note that started up to 0.5 s before `ts` is clipped to `ts`; the note open at the window end is force-closed.
  - Notes join a pending track **as soon as they are final**, with `activeFrom = ts + L`.
  - When re-recording a lane, its old take is switched off from `ts`.
- **Pre-roll:** the 2 s ring buffer, so a take can start analysis from `t0 − 0.2`.

**Scheduler** (`loop/clock.ts`):
- On Tone's `"tick"`, schedule the half-open window `[scheduledUntil, now + 0.12)`, looping over cycles (L can be shorter than the window).
- Late ticks: play events up to 20 ms late and drop older ones. After an interruption, set `scheduledUntil = now`.
- Every Tone call has an explicit time.
- Each track has its own Gain; on/off = a 10 ms ramp. Stop = `stopAll` plus a master ramp.
- Every scheduled event is logged (`LogEvent`) for the tests.

**Tracks:**
- One take per lane. `record` fills the selected lane when it is empty; if it already has a take, a new lane of the same instrument is created and recorded (never destructive; `undo` removes it).
- Several lanes of one instrument are allowed; `violin off` switches all of them.
- `undo` restores a session snapshot, taken on commit / create / delete (not on on/off).
- Persisted with idb-keyval.

**Analysis:**
- **Pitch:** pitchy, 2048 window, 480 hop, `minVolumeAbsolute ≈ 0.008`, our own clarity check ≥ 0.85; `t` = window centre.
- **Segmenter:** median of 5, octave fold, a change of > 0.7 semitone held for 3–4 frames, min 80 ms, gaps < 50 ms merged.
- **Autotune:** nearest semitone, then register fit by octaves (median into violin A4–E5, bass E2–A2, synth as sung).
- **Phrases** (`analysis/phrases.ts`):
  - A gap < 120 ms means legato.
  - Ids are `takeId:n`, and grouping is circular across the loop end.
  - Each note gets `legatoNext`.
- **Drums:**
  - Onsets by spectral flux (FFT 512 / hop 256 via fft.js; mean + 2σ + 0.55 over 40 frames, ±3-frame peak, ≥ 60 ms apart, RMS gate 0.004).
  - Classify on 10–70 ms after the onset:
    - kick if energy < 300 Hz is > 35%, or the centroid is < 900 Hz;
    - hat if the centroid is > 5 kHz, or energy > 6 kHz is > 45%;
    - else snare.

**Instruments** (`Voice` per track, output Gain):
- **synth:** PolySynth(Synth), triangle, short release.
- **bass:** MonoSynth with `setNote` inside phrases and portamento 0.03.
- **drums:** MembraneSynth, NoiseSynth and MetalSynth.
- **violin phrase voice:**
  - One ToneBufferSource per phrase.
  - Release only when `!legatoNext`.
  - Glide with `playbackRate` ramps of 50 ms.
  - Beyond ±2 semitones from the sample, an equal-power 70 ms crossfade to the nearest sample, starting 0.3 s in.
  - Refresh the source before the sample ends.
  - Gain follows the note velocity (the singer's loudness), plus a light lowpass and room.
  - A glide that arrives with no source starts a new one.
- **blip:** a two-note confirmation, for commands and errors.

**UI** (dark, minimal, one screen; `viewport-fit=cover` and safe-area insets; `touch-action:none`; no text selection or callout):
- **Start:** black, the "Sing" wordmark centred, "tap to start" below it, then a thin progress line while the context unlocks, the mic opens and samples preload.
- **Main screen:** lanes are horizontal bands stacked over the full height, and the playhead is a vertical line across all of them.
  - Instrument colours: drums amber, violin rose, synth cyan, bass violet.
  - **Left strip (56 px)** with the instrument letter in a coloured circle: tap = select, tap the small dot = on/off.
  - **Lane body:** notes are rounded bars (x = loop position, y = pitch within the lane's range). Drums are dots on 3 rows.
  - **States:** the selected lane is tinted, the lane being recorded has a pulsing red edge and shows notes live, and an off lane is dimmed.
- **Corner controls:** top right `＋` (a sheet with 4 instrument buttons) and `⋯` (settings sheet).
- **Settings sheet:** echo-cancellation toggle, calibrate latency, audio probe (tone while the mic is open), export last raw take as WAV, clear session, credits.
- **Status pill at the bottom centre:** `ready` · `● 3.2 s` · `▶` plus loop progress · `overdub ●`. The last command shows as a fading toast above it.
- **Command mode:** a blue tint, "listening…", and the partial text in large type.
- **Empty state:** "tap to sing · hold to speak · ‘create violin track’".

## Code layout and ownership
All relative imports end in `.ts`. tsconfig: `allowImportingTsExtensions`, `noEmit`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, so `node dev/*.ts` runs on Node 24.
```
src/types.ts            [coord]   the contract below; only the coordinator changes it
src/main.ts             [coord]   wiring (written fully wired against stubs from day 1)
src/app/controller.ts   [engine]  state machine + timing  · app/session.ts [engine] store/undo/idb
src/app/test-hooks.ts   [tester]  window.__sing (dynamic import, only with ?test)
src/audio/context.ts | mic.ts | mic-worklet.ts | latency.ts | capture.ts   [engine]
src/loop/clock.ts | take.ts                                                [engine]
src/analysis/pitch.ts | segment.ts | autotune.ts | phrases.ts | drums.ts   [dsp]  pure, no DOM/Node globals
src/instruments/index.ts | synth.ts | bass.ts | drums.ts | violin.ts | blip.ts  [instruments]
src/voice/grammar.ts | recognizer.ts                                       [voice]
src/ui/input.ts | start.ts | lanes.ts | sheet.ts | status.ts | style.css   [shell]
index.html, vite.config.ts, public/ icons, .github/workflows/deploy.yml   [shell] (scaffold by coord)
public/samples/violin/*.mp3 [instruments] · public/vosk/ (gitignored) + scripts/fetch-model.mjs [voice]
dev/wav.ts | make-fixtures.ts | analyze.ts [dsp] · dev/check-grammar.ts [voice] · e2e/ [tester]
```
Agents add no dependencies (the coordinator puts every dependency in the scaffold) and edit only their own files. A change to `types.ts` or another area's file is asked of the coordinator.

**Contract (`src/types.ts`, written by the coordinator):**
- Types:
  - `Sec`, `InstrumentKind`
  - `Note {pos,dur,midi,vel,phrase,legatoNext}`, `DrumHit {pos,kind,vel}`
  - `RawNote {t,dur,hz,vel}`, `RawHit {t,kind,vel}`
  - `Take` (drums: hits; others: notes), `Track {id,kind,take,on}`, `Session {v,loopLength,tracks,selectedId}`
  - `DeviceSettings {inLat,ec,calibrated}`
  - `MicBlock {frame,samples}`, `PitchFrame {t,hz|null,clarity,rms}`
  - `AppState`, `Command`, `Gesture`, `LogEvent`
- Interfaces:
  - `MicFeed` (subscribe, `read(from,to)`, `inject(buf,at)`)
  - `PitchTracker`, `NoteSegmenter` (push / open / close), `OnsetDetector`
  - `Voice` (output, `play(ev,when,offset?)`, stopAll, dispose)
  - `Scheduler` (start / stop / pos / setTracks with activeFrom/activeUntil)
  - `Controller` (state, gesture, command, onChange, onLog)
  - `Recognizer` (load(progress), `begin(fromT)`, end, onPartial)
  - `SingTestApi` (state / session / log / now / setDevice / `mic.play(url,at)` / `capture.start/stop` / `voice.inject(text)`)
- Rule: types and `as const` arrays only.

## Execution (agents, waves, git)
- **Coordinator scaffold** on `main` (commit 1):
  - `git init -b main`, remote `git@github.com-gonusi:Gonusi/sing.git` (no push).
  - `package.json` with every dependency installed; `tsconfig.json`; `vite.config.ts` with PWA (base, `id`/`scope` `/sing/`, `autoUpdate`, globPatterns including `mp3,png,svg,ico`, `maximumFileSizeToCacheInBytes` 8 MiB, `globIgnores ['vosk/**']`).
  - `index.html`, `src/types.ts`, a stub file for every module (correct signatures, minimal behaviour), and a fully wired `main.ts`. `tsc` and `vite build` pass.
  - Also `PLAN.md` (this plan with checkboxes) and `.gitignore`.
- **Worktrees:** `git worktree add -b <name> ../sing-worktrees/<name> main`, then `npm ci` in each.
  - Agents commit as they go; the coordinator merges into `main`, runs `tsc` and the build, and ticks `PLAN.md`.
  - Dev servers and e2e use a free port (script-picked, `PORT` env override).
- **Wave 1** (4 in parallel, independent files):
  - **dsp** (opus): analysis/* plus dev fixtures, analyzer and WAV reader.
    - Done: `node dev/analyze.ts` passes on synthesised sung fixtures (harmonics, vibrato, ±30-cent detune, glides, noise): ≥ 95% notes right, onset error < 30 ms. Beatbox fixtures: ≥ 85% classified right.
  - **engine** (opus): context, mic + worklet (512-sample blocks, channel 0), MicFeed ring, inject, latency + calibration, capture tap, scheduler, take, controller, session.
    - Done: a dev page drives tap → record → stop → playback with an injected WAV in Chromium headless; the event log shows the loop positions; `tsc` clean.
  - **instruments** (opus): the 4 voices plus blip, and the 8 violin mp3s downloaded into `public/samples/violin/`.
    - Done: an OfflineAudioContext render per instrument in headless Chromium; peak-frequency check per note; within a legato phrase the RMS never dips more than 6 dB.
  - **shell** (sonnet, exact UI spec above): input gestures, start screen, lanes canvas, sheets, status, styles, icons (assets-generator from one SVG), deploy workflow.
    - Done: iPhone-viewport screenshots of the start screen, empty, 4 lanes, recording, command mode and the settings sheet, driven by a fake session.
- **Wave 2** (after wave 1 is merged):
  - **voice** (opus): `fetch-model` script, grammar plus check-grammar, recognizer (vosk), hold-to-talk wiring. A spike first: load time, memory and partial latency in Chromium.
  - **tester** (opus): test-hooks plus the e2e suite (below).
- **Wave 3:** fix rounds from e2e failures, continuing the same agents through SendMessage. If two rounds in a row expose new edge cases in one mechanism, stop and write down its invariant.
- **Final:** the coordinator runs the full suite, reviews the screenshots, writes a report and the push and deploy steps for the owner.

## Verification (Claude runs it all)
1. **DSP in Node, seconds, every dsp change:** `node dev/analyze.ts` against ground-truth JSON.
2. **E2E with Playwright, about 1–2 min, per merge.**
   - Setup:
     - Runs against `vite build && vite preview --port $PORT --strictPort` with `?test` (tests base `/sing/` and the service worker).
     - `?test` skips `getUserMedia`; `__sing.mic.play(url, at)` injects fixture WAVs at exact context times.
     - Fixtures are served via `page.route`.
     - Output is captured per track by a frame-stamped worklet tap.
   - Scenarios:
     - First take → loop: scheduler-log alignment ≤ 2 ms; re-detected output notes = sung notes ± 40 ms.
     - 4-track overdub (drums, violin, synth, bass): every lane plays and the log shows correct positions.
     - Calibration with a simulated loopback delay → `inLat` within ±5 ms.
     - Undo, on/off, a state-table walk.
     - Reload → session restored; `setOffline` reload → the app loads and the violin plays.
     - Voice (`launchPersistentContext`, so the model downloads once): `say` WAVs in 4 voices, varied rates, with noise, injected during a held pointer → the right command. Negative fixtures (plain speech, singing) → nothing. `voice.inject(text)` covers the logic tests.
     - Screenshots at iPhone 15 viewport, checked by the coordinator.
   - Engines: Chromium for everything; WebKit for the non-voice scenarios (Safari engine: worklet, decoding, Tone).
   - One smoke test with `--use-file-for-fake-audio-capture` proves the real getUserMedia path.
3. **`tsc --noEmit` and `vite build`**, every merge.
4. **The owner's iPhone sessions after return** (they can't be automated):
   - install, offline, mic prompt;
   - the audio probe: EC on/off × wired headphones/speaker;
   - vosk memory and latency;
   - real takes exported as WAV → real fixtures to retune on.

Gate costs: Node DSP checks, `tsc` and the build are nearly free → always. E2E is 1–2 min → per merge. Voice e2e is slower (model load) → only when voice or controller changes.

## Deviations from the spec, for the owner's sign-off on return
- No tempo detection and no bar rounding: actions land on the loop boundary, not on beats. The spec calls "musical/on the beat" non-negotiable.
- No low-voice gate: hold-to-talk instead.
- Blips instead of spoken replies.
- Headphones are required for overdubs.
- `<instrument> on/off` instead of mute/unmute.

## Risks
1. iOS EC/earpiece bug (326286).
2. vosk memory and load time on iPhone → the lichess fork, then the ＋/strip buttons only (the app stays fully usable without voice).
3. Drum thresholds on phone mics → retune on real takes.
4. Headless timing jitter in e2e → assertions use the scheduler log, and audio re-detection gets a 40 ms tolerance.
