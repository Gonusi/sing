# Engine notes (area: engine)

Owner files: `src/audio/{context,mic,mic-worklet,latency,capture,probe,wav-encode}.ts`, `src/loop/{clock,take}.ts`,
`src/app/{controller,session}.ts`, `dev/engine/*`. Check: `node dev/engine/check.ts [chromium|webkit|all]` (~70 s per engine;
needs dsp's fixtures from `node dev/make-fixtures.ts`; `ONLY=r,f` runs a subset).

## Module APIs as built

| module | exports | notes |
|---|---|---|
| `audio/context.ts` | `createAudioEngine(): Promise<AudioEngine>`, `MASTER_GAIN`, `LIMITER`, `LIMITER_MAKEUP`, `LIMITER_DELAY_SEC` | `AudioEngine` = contract fields + **`sink`** (zero-gain → destination; worklet taps connect here to stay pulled) + **`limiter`** + **`onTick(cb)`** (Tone's worker ticker, 15 ms nominal / 18 ms measured, try/catch per callback). Output path: voices → strip gains → `master` → `limiter` (DynamicsCompressor: −3 dB, ratio 20, knee 0, attack 3 ms, release 150 ms) → destination. Net gain below the threshold = `MASTER_GAIN` 0.5 (−6 dB headroom): the master gain is 0.5 / `LIMITER_MAKEUP`, because the spec's compressor adds automatic makeup gain (1/0.721)^0.6 = ×1.217 (+1.7 dB, measured ×1.215). The compressor delays everything by a fixed 6 ms look-ahead (288 frames at 48 kHz, both engines) → included in `outLat()`. Sync part (inside the gesture): `audioSession.type='play-and-record'`, `new AudioContext({latencyHint:'interactive'})`, `resume()`, master + sink. Then `Tone.setContext(ctx, true)` (disposes the stray context that `import 'tone'` creates at module load), `lookAhead = 0.03`, `audioWorklet.addModule(micWorkletUrl)`. Lifecycle: `statechange` (addEventListener — Tone owns `onstatechange`) / `visibilitychange` → `resume()`; 1 s watchdog: running but `currentTime` frozen → `suspend()` + `resume()`; emits `'interrupted'`/`'resumed'` on transitions. |
| `audio/mic-worklet.ts` | processors `mic-tap`, `capture-tap` | `mic-tap`: 512-sample blocks of input channel 0, `frame` = context frame of `samples[0]`; no input → zeros. Frames come from our own counter (`FrameClock`: +n per `process()`, re-synced to `currentFrame` only when it is ≥ 256 frames off): under load Chromium's `currentFrame` sometimes reads one quantum behind for a single call while the samples are contiguous (measured with frame-encoded audio: content = stamp + 128). The wrong stamp overlapped blocks, the take feed dropped 128 real samples, and dsp's tracker/detector restarted, so notes and hits were lost in ~1 of 3 real-analysis runs. Fixed; 0 bad stamps in 3 × 20 s under load since. `capture-tap`: mono mix (mean of channels), 8192-frame chunks, `{type:'stop'}` → flush + `{type:'end'}`. Transferable buffers, no SAB. |
| `audio/mic.ts` | `createMic(engine, {test, ec}): Promise<Mic>` | `Mic` = contract + **`loopback(delaySec)`** (speaker feed = `engine.limiter` output → DelayNode → mic input; returns undo) + **`latest()`** (time after the newest sample) + **`stats()`** (blocks, discontinuities, frames missing; one real +256 jump at boot is normal). Real: `getUserMedia({audio:{echoCancellation, noiseSuppression:false, autoGainControl:false, channelCount:1}})` → MediaStreamSource → tap. Test: never calls getUserMedia; `inject(buf, at)` = BufferSource → tap only (not to speakers), `start(at)`. Ring: 2 s, frame-addressed, gaps filled with zeros. Re-acquires the device when the track ended (on `'resumed'`, on visible, on track `ended`; ≥ 2 s apart). |
| `audio/latency.ts` | `defaultInLat`, `calibrate(engine, mic, {clicks=8, onClick})`, `playClick`, `matchOnsets`, `evaluate`, `createOnsetDetector` | Result = contract + `matched`, `offsets`. `onClick(i, n)` with **i = 1..n**, when click i is heard. Clicks: 2 kHz, peak 0.9 before the master gain (≈ −7 dBFS out), 30 ms decay, 0.6 s apart, first heard 0.5 s + outLat after start. Detector: sample-precise first sample over max(0.02, 6 × floor), 150 ms refractory. |
| `audio/capture.ts` | `createCapture(engine): Capture` | `start(node)`: node → capture-tap → sink. `stop()` → `{frame, sampleRate, pcm}` (frame of `pcm[0]`). Measured: click onset within 2 frames of its scheduled frame. |
| `audio/probe.ts` | `startProbe(engine, mic): Probe`, `blockRms` | 440 Hz at −24 dBFS on master (20 ms fades), `level()` = smoothed linear mic RMS (−24 dBFS sine reads 0.0446). |
| `audio/wav-encode.ts` | `encodeWav16(f32, sr): Uint8Array`, `wavBlob` | mono 16-bit PCM. |
| `loop/clock.ts` | `createScheduler(engine, {onEvent, onDrop, onTransport}): LoopScheduler`, pure helpers `forEachOccurrence`, `lateDecision`, `eventKey`, `rampParam`, constants | `LoopScheduler` = `Scheduler` + `origin`, `loopLength`, `tick()`, `resync()`, `trackOutput(id)`, `dispose()`. Owns one GainNode per track: `voice.output → strip gain → master`. |
| `loop/take.ts` | `createTakeRecorder(opts): TakeRecorder`, `REAL_ANALYSIS`, `placeNote`, `placeHit`, constants | No Web Audio: needs only a `MicFeed`. `opts.analysis` (Partial) replaces any of the 6 analysis functions. Recorder: `liveNotes/liveHits/openNote/pendingTake/onUpdate/beginExclusion/endExclusion/addExclusion/finish(end)/discard/rawAudio`. Window ends: overdub analysis is fed to window end + `PITCH_TAIL_SEC` 35 ms (a frame centred at t needs audio to t + 1024 samples) / + `DRUM_TAIL_SEC` 100 ms, then `segmenter.close(windowEnd)` at once (the last notes never wait for their 140 ms finalisation). `finish(end)` clamps an overdub end to ts + L, calls `segmenter.close(end + inLat)` if still open and **`onsets.close(end + inLat)`** (hit right before a stop), then post-filters every note/hit to the window (dsp's `close` doesn't clip notes already returned by `push`). `MIN_NOTE_SEC` = 80 ms (dsp's minimum). |
| `app/session.ts` | `loadDevice`, `saveDevice`, `loadSession`, `isSession`, `emptySession`, `createSessionStore(initial, {persist})`, keys, `DEFAULT_DEVICE` | Keys `sing.session.v1`, `sing.device.v1`. Store: immutable sessions, `set(next, undoPoint?)`, `undo()`, `clear()`, `flush()`; saves debounced 250 ms, flushed on `pagehide`/hidden; every idb call try/catch. Undo max 50. |
| `app/controller.ts` | `createController(deps): Promise<EngineController>` | Deps = contract + optional `analysis`, `createVoice`, `restore`, `persist`. `EngineController` = `Controller` + `command()` returns **boolean** (accepted), `logs()`, `flush()`, `scheduler`, `dispose()`. |

## MVP+: vocal tracks and echo (2026-10-17)
| piece | where | how |
|---|---|---|
| vocal take | `loop/take.ts` `buildVocalLoop` | kind 'vocals' runs no analysis; raw mic samples (from the pre-roll on) → `rec[d]` = audio sung at corrected `ws + d/sr` (stamp − inLat), d < Ls + X (Ls = round(L·sr), X = 20 ms); exclusions zeroed with 5 ms ramps (holds; the record-start beep's 80 ms, as for drums); rotated so loop pos q ↔ d = (q − ps) mod Ls (first take ps = 0, overdub ps = pos of ts); the window seam at ps is a linear crossfade over X between the window start and the audio recorded just after the window end; buffer = Ls + X with the tail = copy of samples [0, X). An early (tap) commit leaves the unrecorded part silent. |
| peaks | take.ts `loopPeaks`, `livePeaks(displayLen)` | 256 bins, bin i = pos [i·L/256, (i+1)·L/256); value = peak on a dB scale (−50 dBFS → 0, 0 dBFS → 1). Live: from 128-sample chunk peaks; first take spans max(elapsed, 4 s) = the shell's FIRST_TAKE_MIN_LENGTH; exclusions show as 0. |
| storage | `audio/audio-store.ts` | Int16 under `sing.audio.<takeId>` = `Take.audio.key` (`{sampleRate, pcm: Int16Array}`); the cache holds the Int16-decoded buffer (bit-identical before and after a reload). Loaded at boot before voices sync. GC invariant: after gc, stored keys ⊆ keys referenced by the session + undo stack; gc runs at boot, after a commit with an undo point (stack trim), after undo and after clear. |
| voice | `audio/vocal-voice.ts` | one event per cycle from the scheduler (`vocalEvent`: Note {pos 0, dur L, midi 0}); `start(when, offset)`; cycle start fades in over X (complementary to the previous cycle's tail fade-out on identical samples → exact sum, no click); catch-up start fades in over 10 ms; stopAll fades in 15 ms. |
| scheduler | `loop/clock.ts` | vocals: late = exact offset always (`vocalDecision`, audio never shifts); an occurrence straddling `activeFrom` starts at activeFrom with offset activeFrom − heard. |
| commit | controller | vocal overdubs commit at window end + inLat + 0.05 s (`VOCAL_COMMIT_MARGIN_SEC`: 20 ms tail + a block); the first replay therefore starts ≈ 0.13 s after ts + L (inLat + 50 ms + tick + outLat; measured 134–139 ms), caught up with an offset. |
| echo | `audio/context.ts` `createFxBus` | strips → `engine.fxSend` (gain = amount) → delay 0.33 s (feedback 0.2 + 0.3·a through a 3.5 kHz lowpass, return 0.5) + convolver (seeded 1.6 s decaying noise, τ 0.23 s, return 0.35) → wet (on when a > 0) → master → limiter. Clicks, blips, probe, beep connect to master only. `controller.setEcho(a)` ramps (50 ms) and stores `Session.fx.echo` with no undo point; undo and clear keep the current echo; boot: `fx.echo ?? (test ? 0 : 0.2)`. |

Measured (check v1–v7, Chromium + WebKit): vocal first take and overdub audio = injected samples at lag 0 (mean error 8e-6 = Int16), tail = loop start;
seams on a 330 Hz sine with phase jumps: max sample jump 0.0130 = steady 0.0130; reload restores bit-exact audio, echo and exactly the 3
referenced keys; echo 0: tail 0, echo 1: repeat at 330 ms at 0.5 × the click; calibration with echo 1 unchanged (0.1 ms off).

## Timing formulas (context seconds)

- `outLat = baseLatency + outputLatency + LIMITER_DELAY_SEC (0.006)` (missing → 0), read live on every tick.
- Scheduler: event at loop pos `p`, cycle `k` is **heard** at `heard = origin + p + k·L`, scheduled at `when = heard − outLat`.
- Each tick (15 ms) schedules, per eligible track (on, has take), the half-open **heard** window `[scheduledUntil, now + 0.12 + outLat)`; then `scheduledUntil` = that bound. Heard-domain windows: a drifting outLat can never double-schedule or skip.
- Late (`when < now`): note ≤ 20 ms late → starts now, full; later note whose end is ahead (> 30 ms left) → starts now with `offset = now − when`; drum ≤ 30 ms late → now; anything else dropped (`drop` log). Enumeration is bounded per event, so a stale `scheduledUntil` costs nothing.
- Mic: `stamp = frame / sampleRate`; corrected `tc = stamp − inLat` (inLat captured at take start).
- First take: window `[t0, t0+L)`, `pos = clamp(tc − t0, 0, L)`; a note starting in the 0.2 s pre-roll is clipped to t0 (end kept).
- Overdub: window `tc ∈ [ts, ts+L)`, `pos = (tc − origin) mod L`; a note starting up to 0.5 s before ts is clipped to ts, earlier ones dropped; the note open at the window end is closed there; notes < 50 ms after clipping are dropped.
- Exclusion (hold): corrected span `[tDown, tUp)`: samples zeroed before analysis; post-filter drops notes/hits starting inside it and cuts a note open at `tDown`.

**Worked example** (outLat 0.0433 = Chromium headless base 0.0053 + output 0.032 + limiter 0.006; inLat 0.030):
1. Tap at `t0 = 10.000` → recordingFirst. A note's onset reaches the mic tap with stamp 10.530 → `tc = 10.500` → `pos = 0.500`.
2. Stop tap touched at 12.400, released 12.550 → `L = 2.400`; `scheduler.start(origin 10.000, L 2.4, from 12.400)`.
   - pos 0.500, k=1: heard 12.900, when 12.8567 (normal).
   - pos 0.050 (dur 0.5), k=1: heard 12.450, when 12.4067 < now 12.550 → late 0.1433 → `play(note, 12.550, offset 0.1433)`.
3. Overdub tap at `ts = 15.000` (heard pos 0.200). The singer sings with what they hear at 15.600 (pos 0.800): stamp 15.630 → `tc = 15.600` → `pos = (15.6 − 10) mod 2.4 = 0.800` — lands exactly on what was heard. `activeFrom = 17.400`; first replay heard 18.000 (k=3), when 17.9567; it is scheduled as soon as the note is final (well before the commit at ≥ 17.400 + 0.030 + 0.15 = 17.580).
4. Calibration with `mic.loopback(0.120)` (taps the limiter output = the speaker feed): click heard at 20.000 is rendered into master at 19.9567, leaves the limiter at 19.9627, passes the 120 ms delay → stamp 20.0827 → `inLat = 0.0827 = d − (base + output) = d − outLat + 0.006`. Consistency: with that loopback, a loop event heard at H enters the mic at H + 0.0827 → `tc = H`.

**Commit margin** (`COMMIT_MARGIN_SEC` 0.15, kept): the overdub commit runs at window end + inLat + 0.15 (stamp clock: window end + 0.15). By then it needs the drum tail (0.100) + one 512-sample block (0.011) + message latency (a few ms) ≈ 0.115 s. dsp's 140 ms note-finalisation delay doesn't apply at the window end because the take closes the segmenter itself once the 35 ms pitch tail is in; notes that end earlier inside the window are flushed by that same `close`. If the tail is late anyway (main-thread jank), `finish()` closes with what it has: the take ends a few ms short, but nothing is lost (r2/r4 check the edges).

**Legato hand-over** (instruments: a continuation must reach the voice before the previous note's end + 0.25 s): normally it is handed over 0.10–0.12 s before its own start, so the margin is 0.25 − gap + lead ≥ 0.25 − 0.12 + 0.10 = 0.23 s for any legato gap < 120 ms (measured min 248 ms, f3). On the late paths (start catch-up, switch-on, a note that became final late) a late continuation is handed over `now` while the caught-up previous note is still sounding (its end > now), so the margin is > 0.25 s (measured 255 ms, j2). Only a main-thread stall longer than ≈ 0.23 s breaks it, and then the voice falls back to a fresh attack.

## State table as implemented
Mirrored in the header of `src/app/controller.ts`. `s` = state at `tDown` (state history, transitions stamped with the action's time, monotonic); action effects apply to the current reality.

| s | input | result |
|---|---|---|
| idle | tap / record | recordingFirst (`t0 = tDown`; selected empty lane, else first empty lane, else new synth lane); start beep |
| idle | undo | pop the undo stack (→ stopped if the snapshot has a loop) |
| recordingFirst | tap / stop | `L = tDown − t0`; L < 1 s → discard → idle; else commit → playing with `start(t0, L, from = tDown)` |
| recordingFirst | (auto) t0 + 60 s | as stop at `t0 + 60` |
| recordingFirst | undo | discard → idle |
| recordingFirst | other held command | applied; take continues; hold audio excluded |
| playing | tap / record | overdubbing, `ts = tDown`, selected lane if empty else a new lane of the same kind |
| playing | stop | stopped |
| playing | undo | pop (no loop left → idle) |
| overdubbing | window end | commit → playing, at `ts + L + inLat + 0.15` (tick) |
| overdubbing | tap | commit so far (window end = tDown) → playing (empty take → discarded) |
| overdubbing | stop | commit so far → stopped |
| overdubbing | undo | discard → playing; if it was committed meanwhile (`tDown` inside its window) → undo that commit |
| overdubbing | create / record | error blip (`playBlip(ctx,'err',undefined,master)`), `error` log, refused |
| stopped | tap / play | playing, `origin = now + outLat + 0.03` |
| stopped | record | playing + overdubbing with `ts = origin` (records exactly one cycle from pos 0) |
| stopped | undo | pop (no loop left → idle) |
| any but overdubbing | create X | add + select empty X lane (undoable) |
| any | toggle X on/off | every X lane on/off (not undoable) |

Ignored (logged, `accepted:false`): play/stop in idle, record/play in recordingFirst, play in playing/overdubbing, stop in stopped.
Undo granularity: a lane created for a take belongs to that take (one undo removes lane + take); `create` is its own step; on/off/select are never snapshotted.

## Deviations from PLAN.md / the brief, and why
1. `scheduler.start(origin, L, from)`: `from` is a **heard** time; the first take passes `from = tDown` of the stop (not `now`). Occurrences heard in `[tDown, now)` go through the late rules, so a sustained note at pos 0 resumes with an offset and drums ≤ 30 ms late still play (with `from = now` they'd be skipped).
2. stopped → play uses `origin = now + outLat + 0.03` instead of `origin = now`, so pos 0 is never late (drums at pos 0 would be dropped otherwise).
3. Stop ramps the **per-track strip gains** to 0 (20 ms) and calls `voice.stopAll(at + 20 ms)`; the master bus is untouched (blips stay audible; events already inside the lookahead stay silent even if a voice's `stopAll` doesn't cancel future notes).
4. The record-start beep (1320 Hz, 40 ms) is excluded from the take only for **drum** takes (80 ms); melodic takes keep the audio (the beep is shorter than any note, and an exclusion would cut a note sung right at the start).
5. Catch-up also covers: a track switched back on (its own `scheduledUntil` stood still) and events that appear after their window passed (overdub notes final late) — same late rules, each occurrence still once.
6. Pending overdub notes use the **running** register shift and phrases (notes so far); the final shift is computed at commit. An occurrence scheduled in the ~0.3 s before the commit plays with the running values.
7. Until calibrated, `inLat` = `track.getSettings().latency` when the browser reports one (applied in createController), else the stored/default 0.01.

## What the tester's e2e should assert
- Log events (`controller.logs()` / `onLog`): `sched {trackId, kind, pos, cycle, heard, when, at, offset, outLat}`, `drop {… reason}`, `transport {action: start|stop|resync, at, origin, loopLength, from, scheduledUntil{trackId: heard}}`, `take {phase: start|commit|discard|auto-stop, mode, trackId, …}`, `state {from, to, at}`, `command {command, tDown, stateAtTDown, state, accepted}`, `gesture`, `undo`, `toggle`, `device`, `error {message}`, `lifecycle {event}`, `boot`, `clear`.
- Exactness (strongest check): the set of `(trackId, pos, cycle)` in `sched` equals every occurrence with `heard ∈ [from, scheduledUntil[track])` (from the start/stop `transport` events), minus `drop`s; no duplicates.
- Alignment: `when = origin + pos + cycle·L − outLat` (±2 ms), `at = when` unless `offset > 0` or late. With real voices: capture `controller.voiceOutput(id)` (the strip gain, after on/off) or `engine.master` via `createCapture(engine)`; re-detected onset frame ≈ `at · sampleRate` + the instrument's attack.
- Inject sung audio at `stamp = tc + inLat` (the test mic has zero latency of its own) to pretend a real input latency; expect positions per the formulas above (±15 ms with real analysis tolerances on top).
- Calibration: `mic.loopback(d)` + `calibrate()` → `ok`, `inLat ≈ d − outLat(at start)` ±5 ms (measured error 0.1 ms).
- Persistence: `await controller.flush()` (or wait > 250 ms) before reload; restored state = `stopped` when the session has a loop.
- Note: `dev/engine/check.ts` covers all of the above against a fake analysis; e2e should repeat a–f with the real dsp + instruments.

## Check (`node dev/engine/check.ts`) — what it covers, measured values
Chromium 42 checks (incl. k1 real getUserMedia via `--use-file-for-fake-audio-capture`), WebKit 41; ~90 s per engine. Real instrument voices.
v1–v7: vocal takes, seams, audio persistence, echo (see MVP+ above).
r1–r4 use the REAL analysis (`?analysis=real`, src/analysis) on dsp's fixtures, injected with inLat 20 ms: r1 first take from `sing-cmaj`
(C4 starts in the pre-roll → clipped to pos 0; stop inside F4 → force-closed): 8/8 notes, worst 12.9 ms, midi exact, last end exactly L ·
r2 overdub window inside `sing-cmaj` (G4 starts 0.31 s before ts → clipped, dur 0.366/0.365; A4 open at the end → closed, 0.523/0.524):
8/8, worst 3.9 ms · r3 pending real notes play from ts + L before the commit · r4 drum overdub from `beatbox-basic`, first hit 20 ms after
ts, tap-commit 30 ms after the last hat (released 60 ms later → `close()` path): 16/16, worst 4.0 ms, kinds exact.
i2 limiter delay 288 frames · f3/j2 legato hand-over margins · e1 now expects d − outLat + 0.006 (loopback on the speaker feed).
Fake-analysis scenarios (as before):
a0 view mid-take · a1 L exact · a2 first-take positions (≤ 0.7 ms) · a3 start(origin=t0, from=tDown) · a4 when formula (0.00 ms) ·
a5 catch-up offset of pos 0.05 = start lag · a6 exactly-once · a7 WAV length · b0–b4 overdub (positions ≤ 0.8 ms incl. clipped and
force-closed notes; silent until ts+L; pending notes scheduled before commit) · c1–c3 23-step state walk, onChange, error logs ·
g1–g3 hold exclusion, state at tDown · d1 reload restore · e1 loopback calibration (0.1 ms off) · h1 probe level · i1 capture frame (2 frames) ·
f1 15 s × 4 tracks: 267/267 · f2 L = 50 ms · j1 on/off + catch-up · l1 suspend/resume resync.
Headless numbers: Chromium outLat 43.3 ms (base 5.3 + output 32 + limiter 6), WebKit 24.5 ms (2.7 + 15.8 + 6), both 48 kHz; Tone ticks every 18 ms (max 20).
WebKit quirks seen: `currentTime` is still 0 right after boot (first take at t0 = 0 has no pre-roll) and advances in coarse steps.

## Fixed after the tester's MVP+ e2e (2026-10-17)
- Vocal seam one-sample click: a source started at a fractional `when` renders its first sample one frame before the gain automation;
  the per-cycle GainNode now starts at 0 (was the default 1 → that sample doubled against the previous tail).
- Phantom hats in room noise: drum takes no longer zero excluded audio before the onset detector (zeroed noise resuming at the
  record-beep exclusion end was an onset); hits inside exclusions are dropped by placeHit. The repro's other hat was the test noise
  bed's own start (digital silence → noise, 50 ms after boot); the regression test now lets the bed run 0.5 s first.
- FrameClock: the first sync could take a glitched currentFrame (counter 128 frames off for the whole session → vocal audio 2.7 ms
  late, seen once). It now also re-syncs when currentFrame disagrees on 4 consecutive calls; a single-call glitch is still ignored.

## WebKit "one quantum off" (2026-10-17, investigated)
Root fact, measured: `currentTime` advances by 128/256 frames WITHIN one JS task (3 ms of work: 192/200 tasks on WebKit,
45/200 on Chromium). Two consequences:
- **Real (vocal output 2.67 ms late, WebKit ~1 in 5 runs):** a catch-up vocal start passed `at = now` read at the tick's start; by
  `src.start(at, offset)` a quantum had passed, so the audio began a quantum late with the old offset. Diagnosed with a per-cycle
  xcorr: only cycle 1 (the catch-up start) was off, 2/10 runs before, 0/15 after. Fix: vocal-voice starts no earlier than
  currentTime + 10 ms and adds the shift to the offset (as the instruments' LATE_MARGIN).
- **Artefact (states.spec `origin − log t`):** two separate currentTime reads. The controller now logs `play {now, outLat, origin}`
  from one read; the spec asserts `origin − now − outLat = 0.03` exactly.
Also found while measuring: a worklet node's FIRST `currentFrame` read can itself be one quantum behind. The old 4-call re-sync could follow
a multi-call glitch (misplaced audio once, v1), and a block re-stamped mid-way kept its old stamp. Now FrameClock only moves forward
(reads behind = glitch, ignored; ahead < 2 quanta = correction, the held block is re-stamped; ≥ 2 quanta = jump, new block). v8 checks
late vocal starts on fresh capture taps (20/20 exact on both engines).
Risk: a glitch that read AHEAD (never observed) would make all later stamps 2.7 ms late.

## Round 2 (2026-10-18): smoothing, key snap, calibration v2, mic choice, deleteTrack
- **Notes:** melodic takes store `take.raw` (loop positions after inLat/window clipping, fractional midi, `attack` copied from
  RawNote). `take.notes = deriveNotes(raw, smoothing, L, kind, takeId)` (loop/take.ts, the only derivation): cleanNotes →
  snap (≥ 6 notes: estimateKey + snapToKey, i.e. the singer's tuning offset removed; else snapMidi) → registerShift → assignPhrases.
  Live notes stay snapped-uncleaned. `setSmoothing(a)` clamps, writes `fx.smooth` (fx always carries both echo and smooth; no undo
  point; undo/clear keep fx and undo re-derives the restored takes), re-derives every take with raw, and re-syncs the scheduler with
  `catchUp: false` (a re-derived note that is already sounding is not started twice). Old takes without raw keep their notes.
  Real take (dev/replay-take.ts, synth): 27 raw detections → 21 committed notes for ≈ 20 syllables.
- **Device:** `DEFAULT_DEVICE.ec = true` (stored settings keep theirs); `micId` persisted and validated.
- **Calibration v2** (audio/latency.ts): 4 listen clicks (2.4 kHz) + 12 measured clicks (1.4 kHz), period 0.65 s. Every onset's
  phase vs. the grid (window [−0.05, 0.60) s → round trips up to 0.6 s, Bluetooth); pass 1 = densest 120 ms cluster over all
  phases, pass 2 = per click the phase nearest the cluster centre → median; ok when ≥ 6/12 and IQR < 60 ms. Onset detector: first
  sample over max(0.004, 5 × floor), 0.3 s warm-up, 150 ms refractory (clap, spoken "ta", suppressed headset mic).
  `onClick(i, n, phase: 'listen' | 'measure')`, i = 1..n within the phase. Result adds `heard`, `measured` (= 12).
  Checks: e1 loopback 120 ms (0.04 ms off), e2 450 ms (Bluetooth-like, 0.04 ms off), e3 200 synthetic clap sessions
  (±30 ms jitter, 3 missed, 3 spurious): all ok, 198/200 within ±20 ms, worst 24.6 ms (the median of 9 such claps alone has σ ≈ 9 ms).
- **Mic choice:** `mic.listInputs()` (enumerateDevices audioinput; [] in test mode), `mic.setInput(id | null)` → true if that input
  opened, false = it failed and the default is in use (the choice is kept for next time), `mic.inputId()`.
  `controller.setDevice({micId})` applies it; the stored micId is applied at boot. Check k2 (Chromium fake devices).
  **iOS + AirPods (research, not verified on a device):** native apps get A2DP output + built-in mic only with
  `.playAndRecord` + `.allowBluetoothA2DP` and WITHOUT `.allowBluetooth` (HFP) [Apple forums 784318, 741513]; a page can't set
  those options, and WebKit bug 282939 (open) reports getUserMedia mostly returning the iPhone mic with AirPods connected and
  sometimes moving output to the speaker; WebKit 252175 (open) AirPods stop when capture starts. **Owner to test:** with AirPods,
  (1) the default mic — which label is chosen, does playback sound full-range (A2DP) or telephone-like (HFP)?; (2) choose
  "iPhone Microphone" — does output stay on the AirPods and full-range?; (3) calibration in both cases (heard n/12, latency).
- **deleteTrack(id)** (EngineController): see its doc comment; check t1.

## Known risks
- **Vocal first replay** misses ≈ 0.13 s after an overdub window (commit latency); a provisional commit before the window end could
  close it, not built. **Beep exclusion** zeroes 80 ms of a vocal take right after the record tap (on speakers the mic hears the beep).
- **Vocal memory**: 60 s take = 2.9 M samples ≈ 11.5 MB Float32 in the cache + 5.8 MB Int16 in IndexedDB per track; undo snapshots keep
  their audio alive until trimmed.
- The e2e `fake-mic` spec needs `public/vosk/` (gitignored model) in the checkout; without it vosk logs "Unrecognized archive format".
- **Worklet `currentFrame` glitches** (Chromium under load, fixed by `FrameClock`): if a browser ever skips render quanta for the node,
  the counter re-syncs only on jumps ≥ 256 frames; a persistent 128-frame offset would go unnoticed (2.7 ms). `mic.stats()` shows gaps.
- **Main-thread stalls > ~100 ms** (GC, heavy UI) make events late: the late rules keep it musical (catch-up/drop), but drums can be dropped. Lookahead 0.12 s is the trade-off against on/off latency.
- **outputLatency jumps** (Bluetooth route change) don't double/skip events, but shift audible timing until recalibrated.
- **iOS**: re-acquiring getUserMedia without a gesture after backgrounding may fail (logged); the loop keeps playing, takes get silence. Mic ring keeps context-frame stamps across the suspend (no gap in context time).
- `Tone.setContext(ctx, true)` disposes the context created by `import 'tone'`: instruments must not use the deprecated module-level `Tone.Transport` / `Tone.Destination` / `Tone.Draw` consts (they belong to the disposed context).
- `controller.view()` recomputes live notes per call (fine for dozens of notes per frame).

## Contract changes
Done by the coordinator (2026-10-17): `command()` → boolean, `Controller.logs()`, `OnsetDetector.close(at)` — all used.
None open. FYI for the tester: `mic.loopback(d)` now feeds the speaker path (after the limiter): expect `inLat ≈ d − outLat + LIMITER_DELAY_SEC`.
