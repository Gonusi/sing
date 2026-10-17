# Engine notes (area: engine)

Owner files: `src/audio/{context,mic,mic-worklet,latency,capture,probe,wav-encode}.ts`, `src/loop/{clock,take}.ts`,
`src/app/{controller,session}.ts`, `dev/engine/*`. Check: `node dev/engine/check.ts [chromium|webkit|all]` (~50 s per engine).

## Module APIs as built

| module | exports | notes |
|---|---|---|
| `audio/context.ts` | `createAudioEngine(): Promise<AudioEngine>` | `AudioEngine` = contract fields + **`sink`** (zero-gain → destination; worklet taps connect here to stay pulled) + **`onTick(cb)`** (Tone's worker ticker, 15 ms, try/catch per callback). Sync part (inside the gesture): `audioSession.type='play-and-record'`, `new AudioContext({latencyHint:'interactive'})`, `resume()`, master + sink. Then `Tone.setContext(ctx, true)` (disposes the stray context that `import 'tone'` creates at module load), `lookAhead = 0.03`, `audioWorklet.addModule(micWorkletUrl)`. Lifecycle: `statechange` (addEventListener — Tone owns `onstatechange`) / `visibilitychange` → `resume()`; 1 s watchdog: running but `currentTime` frozen → `suspend()` + `resume()`; emits `'interrupted'`/`'resumed'` on transitions. |
| `audio/mic-worklet.ts` | processors `mic-tap`, `capture-tap` | `mic-tap`: 512-sample blocks of input channel 0, `frame` = context frame of `samples[0]` (4 quanta accumulated, first quantum's `currentFrame`); no input → zeros. `capture-tap`: mono mix (mean of channels), 8192-frame chunks, `{type:'stop'}` → flush + `{type:'end'}`. Transferable buffers, no SAB. |
| `audio/mic.ts` | `createMic(engine, {test, ec}): Promise<Mic>` | `Mic` = contract + **`loopback(delaySec)`** (master → DelayNode → mic input; returns undo) + **`latest()`** (time after the newest sample). Real: `getUserMedia({audio:{echoCancellation, noiseSuppression:false, autoGainControl:false, channelCount:1}})` → MediaStreamSource → tap. Test: never calls getUserMedia; `inject(buf, at)` = BufferSource → tap only (not to speakers), `start(at)`. Ring: 2 s, frame-addressed, gaps filled with zeros. Re-acquires the device when the track ended (on `'resumed'`, on visible, on track `ended`; ≥ 2 s apart). |
| `audio/latency.ts` | `defaultInLat`, `calibrate(engine, mic, {clicks=8, onClick})`, `playClick`, `matchOnsets`, `evaluate`, `createOnsetDetector` | Result = contract + `matched`, `offsets`. Clicks: 2 kHz, 30 ms decay, 0.6 s apart, first heard 0.5 s + outLat after start. Detector: sample-precise first sample over max(0.02, 6 × floor), 150 ms refractory. |
| `audio/capture.ts` | `createCapture(engine): Capture` | `start(node)`: node → capture-tap → sink. `stop()` → `{frame, sampleRate, pcm}` (frame of `pcm[0]`). Measured: click onset within 2 frames of its scheduled frame. |
| `audio/probe.ts` | `startProbe(engine, mic): Probe`, `blockRms` | 440 Hz at −24 dBFS on master (20 ms fades), `level()` = smoothed linear mic RMS (−24 dBFS sine reads 0.0446). |
| `audio/wav-encode.ts` | `encodeWav16(f32, sr): Uint8Array`, `wavBlob` | mono 16-bit PCM. |
| `loop/clock.ts` | `createScheduler(engine, {onEvent, onDrop, onTransport}): LoopScheduler`, pure helpers `forEachOccurrence`, `lateDecision`, `eventKey`, `rampParam`, constants | `LoopScheduler` = `Scheduler` + `origin`, `loopLength`, `tick()`, `resync()`, `trackOutput(id)`, `dispose()`. Owns one GainNode per track: `voice.output → strip gain → master`. |
| `loop/take.ts` | `createTakeRecorder(opts): TakeRecorder`, `REAL_ANALYSIS`, `placeNote`, `placeHit`, constants | No Web Audio: needs only a `MicFeed`. `opts.analysis` (Partial) replaces any of the 6 analysis functions. Recorder: `liveNotes/liveHits/openNote/pendingTake/onUpdate/beginExclusion/endExclusion/addExclusion/finish(end)/discard/rawAudio`. |
| `app/session.ts` | `loadDevice`, `saveDevice`, `loadSession`, `isSession`, `emptySession`, `createSessionStore(initial, {persist})`, keys, `DEFAULT_DEVICE` | Keys `sing.session.v1`, `sing.device.v1`. Store: immutable sessions, `set(next, undoPoint?)`, `undo()`, `clear()`, `flush()`; saves debounced 250 ms, flushed on `pagehide`/hidden; every idb call try/catch. Undo max 50. |
| `app/controller.ts` | `createController(deps): Promise<EngineController>` | Deps = contract + optional `analysis`, `createVoice`, `restore`, `persist`. `EngineController` = `Controller` + `command()` returns **boolean** (accepted), `logs()`, `flush()`, `scheduler`, `dispose()`. |

## Timing formulas (context seconds)

- `outLat = baseLatency + outputLatency` (missing → 0), read live on every tick.
- Scheduler: event at loop pos `p`, cycle `k` is **heard** at `heard = origin + p + k·L`, scheduled at `when = heard − outLat`.
- Each tick (15 ms) schedules, per eligible track (on, has take), the half-open **heard** window `[scheduledUntil, now + 0.12 + outLat)`; then `scheduledUntil` = that bound. Heard-domain windows: a drifting outLat can never double-schedule or skip.
- Late (`when < now`): note ≤ 20 ms late → starts now, full; later note whose end is ahead (> 30 ms left) → starts now with `offset = now − when`; drum ≤ 30 ms late → now; anything else dropped (`drop` log). Enumeration is bounded per event, so a stale `scheduledUntil` costs nothing.
- Mic: `stamp = frame / sampleRate`; corrected `tc = stamp − inLat` (inLat captured at take start).
- First take: window `[t0, t0+L)`, `pos = clamp(tc − t0, 0, L)`; a note starting in the 0.2 s pre-roll is clipped to t0 (end kept).
- Overdub: window `tc ∈ [ts, ts+L)`, `pos = (tc − origin) mod L`; a note starting up to 0.5 s before ts is clipped to ts, earlier ones dropped; the note open at the window end is closed there; notes < 50 ms after clipping are dropped.
- Exclusion (hold): corrected span `[tDown, tUp)`: samples zeroed before analysis; post-filter drops notes/hits starting inside it and cuts a note open at `tDown`.

**Worked example** (outLat 0.0373 = Chromium headless 0.0053 + 0.032; inLat 0.030):
1. Tap at `t0 = 10.000` → recordingFirst. A note's onset reaches the mic tap with stamp 10.530 → `tc = 10.500` → `pos = 0.500`.
2. Stop tap touched at 12.400, released 12.550 → `L = 2.400`; `scheduler.start(origin 10.000, L 2.4, from 12.400)`.
   - pos 0.500, k=1: heard 12.900, when 12.8627 (normal).
   - pos 0.050 (dur 0.5), k=1: heard 12.450, when 12.4127 < now 12.550 → late 0.1373 → `play(note, 12.550, offset 0.1373)`.
3. Overdub tap at `ts = 15.000` (heard pos 0.200). The singer sings with what they hear at 15.600 (pos 0.800): stamp 15.630 → `tc = 15.600` → `pos = (15.6 − 10) mod 2.4 = 0.800` — lands exactly on what was heard. `activeFrom = 17.400`; first replay heard 18.000 (k=3), when 17.9627; it is scheduled as soon as the note is final (well before the commit at ≥ 17.400 + 0.030 + 0.15 = 17.580).
4. Calibration with `mic.loopback(0.120)`: click heard at 20.000 is rendered at 19.9627, passes the 120 ms delay into the mic → stamp 20.0827 → `inLat = 0.0827 = d − outLat`. Consistency: with that loopback, a loop event heard at H enters the mic at H + 0.0827 → `tc = H`.

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
Chromium 28 checks (incl. k1 real getUserMedia via `--use-file-for-fake-audio-capture`), WebKit 27; ~50 s per engine.
a0 view mid-take · a1 L exact · a2 first-take positions (≤ 0.7 ms) · a3 start(origin=t0, from=tDown) · a4 when formula (0.00 ms) ·
a5 catch-up offset of pos 0.05 = start lag · a6 exactly-once · a7 WAV length · b0–b4 overdub (positions ≤ 0.8 ms incl. clipped and
force-closed notes; silent until ts+L; pending notes scheduled before commit) · c1–c3 23-step state walk, onChange, error logs ·
g1–g3 hold exclusion, state at tDown · d1 reload restore · e1 loopback calibration (0.1 ms off) · h1 probe level · i1 capture frame (2 frames) ·
f1 15 s × 4 tracks: 267/267 · f2 L = 50 ms · j1 on/off + catch-up · l1 suspend/resume resync.
Headless numbers: Chromium outLat 37.3 ms (base 5.3 + output 32), WebKit 18.5 ms (2.7 + 15.8), both 48 kHz.
WebKit quirks seen: `currentTime` is still 0 right after boot (first take at t0 = 0 has no pre-roll) and advances in coarse steps.

## Known risks
- **Main-thread stalls > ~100 ms** (GC, heavy UI) make events late: the late rules keep it musical (catch-up/drop), but drums can be dropped. Lookahead 0.12 s is the trade-off against on/off latency.
- **First-take drum tail**: `OnsetDetector` has no flush; a hit in the last ~70 ms before the stop is lost when the stop is processed < 70 ms after its touch-down (taps are released later than that, so rare).
- **outputLatency jumps** (Bluetooth route change) don't double/skip events, but shift audible timing until recalibrated.
- **iOS**: re-acquiring getUserMedia without a gesture after backgrounding may fail (logged); the loop keeps playing, takes get silence. Mic ring keeps context-frame stamps across the suspend (no gap in context time).
- `Tone.setContext(ctx, true)` disposes the context created by `import 'tone'`: instruments must not use the deprecated module-level `Tone.Transport` / `Tone.Destination` / `Tone.Draw` consts (they belong to the disposed context).
- `controller.view()` recomputes live notes per call (fine for dozens of notes per frame).

## Proposed contract changes (for the coordinator)
1. `Controller.command(c, tDown): boolean` (accepted). Today `main.ts run()` always plays the `ok` blip, so a refused command (create during overdub) plays my `err` blip **and** `ok`. Implemented already; main.ts should use the result.
2. `Controller.logs(): LogEvent[]` (implemented on `EngineController`): `SingTestApi.log()` needs the buffered log; an `onLog` subscription installed after boot misses the boot events. `TestHookDeps.controller` could be typed `EngineController`.
3. `OnsetDetector.close(at): RawHit[]` (like `NoteSegmenter.close`) to finalise a hit awaiting classification at take end.
4. For instruments: `Voice.stopAll(at)` should also cancel notes scheduled after `at` (not required by the engine any more, see deviation 3); never connect `voice.output` anywhere (the engine connects it to the track's strip gain).
