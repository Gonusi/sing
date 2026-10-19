# shell — notes (UI, gestures, icons, deploy workflow)

Checks: `npx tsc` clean, `npx vite build` ok, `node dev/ui/shots.ts` passes (screenshots + gesture/strip/sheet checks).

## Files
- `src/ui/start.ts` — start screen (`mountStart`): tap-to-start, progress, error + retry, fade-out.
- `src/ui/input.ts` — gesture layer (`mountInput`): tap / holdStart / holdEnd, Space key, no-gesture zones.
- `src/ui/lanes.ts` — canvas lanes + DOM strip buttons (`mountLanes`).
- `src/ui/status.ts` — toast, command overlay, empty hint, flash (`mountStatus`; the pill is gone, round 4).
- `src/ui/transport.ts` — bottom transport bar (`mountTransport`); `src/ui/tempo.ts` — tempo control (`mountTempo`).
- `src/ui/sheet.ts` — top bar, ＋ sheet, ⋯ settings sheet (`mountSheets`).
- `src/ui/style.css` — all styles; the colour tokens in `:root` are the single source (lanes.ts reads them at mount).
- `index.html` — only added `<meta name="color-scheme" content="dark">`.
- `public/logo.svg` + `favicon.ico`, `pwa-64x64.png`, `pwa-192x192.png`, `pwa-512x512.png`, `maskable-icon-512x512.png`, `apple-touch-icon-180x180.png`.
- `.github/workflows/deploy.yml` — exactly as briefed.
- `dev/ui/index.html` + `fake.ts` (fake-view page), `start.html` + `start-page.ts`, `shots.ts`, `icons.config.ts`.

## Screenshots (iPhone 15 viewport, 3x) — `dev/ui/out/` (gitignored; regenerate with `node dev/ui/shots.ts`)
Absolute folder: `/Users/kasparasanusauskas/Projects/personal/sing-worktrees/shell/dev/ui/out/`
`empty.png` `four.png` `five.png` `recording-vocals.png` `recording.png` `overdub.png` `command.png` `toast.png` `settings.png` `plus.png` `many.png` (12 lanes, scrolls) `start.png` `start-progress.png` `start-error.png`.
Dev pages: `${url}dev/ui/index.html?s=<scene>[&t=<loopPos seconds>]`, `${url}dev/ui/start.html[?p=0.6|?e=message]`.

## Selectors for tests (stable)
- Top bar: `[data-action="new-track"]` (＋), `[data-action="settings"]` (⋯).
- Sheets: `.sheet-layer.open` (one open sheet), `.kind-btn[data-kind="violin"]`, rows `.row` (`.row.danger` = clear), `.sheet-done`, `.sheet-backdrop`.
- Lanes: `.lanes` canvas, strip buttons `.lane-strip[data-id="<trackId>"]` (aria-label `<kind> lane`).
- Status: `.toast`, `.cmd-overlay.on`, `.hint.on`.
- Start: `.start`, `.start-text`.
- Gesture layer ignores anything inside `[data-no-gesture]` (top bar, sheets, strip buttons).

## Decisions I took (brief did not settle)
- Icons are generated with `npx pwa-assets-generator --config dev/ui/icons.config.ts`, not bare `--preset minimal-2023`: the preset gives the maskable and apple icons a white background with 30% padding (white frame around a dark rounded square). The config sets background `#0b0b0f`, padding 0.1 (maskable) / 0.05 (apple). Same output names. Transparent icons (`pwa-*.png`, favicon) are unchanged.
- Lane geometry: lane rect = x 12 .. width−12; the brief's strip/body numbers are lane-local (circle centre 28, body 64 .. laneWidth−12), so on screen the circle is at x 40 and the body starts at x 76.
- Stage is a CSS grid (rows 52px / 1fr / 72px) and children are placed by class, so the mount order in main.ts does not matter. Lanes area scrolls (`overflow-y: auto`) only when 56px lanes do not fit.
- Strip letter colour is `--bg` (#0b0b0f) on the filled circle (brief says "white-ish … (#0b0b0f)", contradictory; a dark letter reads on all four colours). Off lane: ring + letter in the instrument colour, whole lane at 35%.
- Input: pointer capture on the stage (the release is seen even if the finger leaves); `touchstart.preventDefault` is skipped inside `[data-no-gesture]`, otherwise strip/sheet buttons would never get `click` on touch. Space key listened on `window`, ignored when the target is inside a no-gesture zone; window `blur` ends a press like `pointercancel`. Right/middle mouse buttons ignored.
- Start screen: a `div role=button`, pointer only (no keyboard activation). If `onTap` throws synchronously the error state is shown.
- Probe level bar draws `sqrt(level())` (mic RMS of speech is ~0.01–0.1; linear would be invisible).
- Toast fully visible when `toast.at` is slightly in the future; no flash for state/toast already present at mount.
- Added a caption "SETTINGS" to the ⋯ sheet (brief only names the ＋ caption; the "done" button needs a header row). Switch "on" colour is `--cmd`.
- Extra dev-only: scene `many`, start page `?e=`, `dev/ui/icons.config.ts`.

## Open questions
1. Touch scroll of the lanes area when > ~11 lanes: `touchstart.preventDefault` on the stage blocks it (wheel works). Fine for a prototype, or should the lanes area opt out?
2. Dashed centre line of an empty lane uses `--line` as briefed; it is very faint on the tinted lane. Use `--dim` at low alpha instead?
3. Calibrate counter shows `i/n` exactly as `onClick(i, n)` passes it; if the engine passes `i` 0-based it will read 0/n … (n-1)/n.
4. Whole 52px top bar is a no-gesture zone (taps there do nothing), so a stray tap near ＋/⋯ never records.
5. PLAN.md says "tap the small dot = on/off"; the brief (followed) says tap letter = select, tap again = on/off.

## MVP+ additions (branch shell2)
- Vocals: `--vocals: #5ad17a`, letter M, in `KINDS` (lanes.ts). Vocals lane = mirrored waveform bars (`drawWaveform`, lanes.ts) from `take.peaks`, or `view.livePeaks` while recording; bins span `axis.length` (loop, or Ldisp on a first take). Empty lane = dashed line.
- Echo slider in the top bar (sheet.ts `createEchoControl`): label "echo" + range 0..1 step 0.01, 96 px, no-gesture; `input` -> `setEcho`; re-read from `getEcho()` at mount and whenever either sheet closes. Label hidden under 340 px width. Slider fill is a CSS var `--fill` set from JS (webkit has no progress pseudo); the Firefox pseudo is styled separately.
- `SheetActions` gains `getEcho(): number` and `setEcho(amount: number): void`. main.ts must wire them (tsc fails there until it does).
- ＋ sheet: 2x2 grid (`GRID_KINDS` = INSTRUMENTS minus vocals) + full-width vocals button below (`.kind-btn-wide`, sub-label "your voice").
- dev/ui scenes `five`, `recording-vocals`; fake actions log `setEcho:<v>`; shots.ts checks: five kind buttons, echo initial value, tap on slider calls setEcho and emits no gesture, input event.
- Screenshots (abs): `/Users/kasparasanusauskas/Projects/personal/sing-worktrees/shell2/dev/ui/out/{five,recording-vocals,plus}.png`

### Questions
1. While the sheet is open the slider is behind the backdrop, so `getEcho()` on close only matters for changes made by voice/engine; fine to keep or drop.
2. The hint's second line was left unchanged as briefed.
3. During a first vocal take the waveform's empty tail draws 1 px baseline bars (min height), looks like a flat line; kept.

## Note smoothing row (branch shell3)
- ⋯ sheet: row "Note smoothing" right after Echo cancellation (`createSmoothingRow`, sheet.ts): div `.row.row-slider`, range 0..1 step 0.05, classes `echo-slider smooth-slider` (same CSS as the echo slider, width 100% via `.row-slider .smooth-slider`). Re-read from `getSmoothing()` on every sheet open (row `reset`); `input` -> `setSmoothing` live.
- `SheetActions` gains `getSmoothing(): number` and `setSmoothing(amount: number): void`. main.ts must wire them (tsc fails there until it does).
- Echo cancellation sub-line is now "on: phone speaker · off: headphones (cleanest vocals)" (wraps to two lines at 390 px).
- Selector note: top-bar echo slider is `.topbar .echo-slider` (`.echo-slider` alone now matches both); smoothing is `.smooth-slider`. shots.ts: `checkSmoothing`.

## Lane menu (branch shell4)
- Hold a strip button >= 450 ms (`HOLD_MS`, lanes.ts) -> popover from `src/ui/lanemenu.ts` (`openLaneMenu`): title "<kind> track", "mute"/"unmute" -> `onToggle`, "delete" (--rec) -> `onDelete`. Release of the hold does not select/toggle; pointerleave/pointercancel cancel the timer; `navigator.vibrate?.(10)`.
- `LanesOptions` gains `onDelete(trackId: string): void`. main.ts must wire it (tsc fails there until it does).
- Backdrop closes only on a click that started with a pointerdown on it (the opening press ends on the backdrop, its click must not close the menu). Escape closes.
- Selectors: `.lane-menu`, `.lane-menu-title`, `.lane-menu-item` (`.danger` = delete), `.lane-menu-backdrop`. dev scene `menu` (hold on the violin strip); shots.ts `checkLaneMenu`. Screenshot: `dev/ui/out/menu.png`.

## Calibration v2 + microphone row (branch shell5)
- `SheetActions.calibrate(onClick(i, n, phase 'listen'|'measure'))`: row title shows "listen… i/4" / "clap or say “ta” · i/12" then the result text; sub-line "wear your headphones; any mic works" while running (idle: "clap or say “ta” along with 16 clicks"); dot --fg in listen, --rec in measure. Row has `data-row="calibrate"`.
- New row "Microphone" (`createMicRow`, div `.row.row-mic`, `.mic-select`) after Echo cancellation; list refreshed on every sheet open; `SheetActions` gains `listMics()`, `getMic()`, `setMic(id|null): Promise<boolean>`; false -> select back to default, sub-line "couldn’t switch — using default" for 2 s. main.ts must wire them (tsc fails there until it does).
- dev/ui: scene `calibrating` (`?ci=<ms>` fake click period, default 100), fake mics "iPhone Microphone"/"AirPods Pro"; shots.ts `checkMic`, `checkCalibrate`, shot `calibrating.png`. Screenshots: `/Users/kasparasanusauskas/Projects/personal/sing-worktrees/shell5/dev/ui/out/{settings,calibrating}.png`.

## Setup wizard (branch shell6)
- `src/ui/wizard.ts` `mountWizard(root, api, {steps?, onDone(completed)})` returns an idempotent unmount. Full-screen `.wizard` (z 200, `data-no-gesture`, safe areas): dots + "skip setup" on top, centred `.wiz-card` (wizard writes the step title, the step fills the rest), bottom grid back (visibility-hidden on step 1) / "skip this step" / next ("done" on the last). `onDone` runs the current step's cleanup first; the caller still unmounts.
- Steps: `src/ui/setup/{listening,mic,latency,drums,voice,commands}.ts`, order in `setup/index.ts` (`ALL_STEPS`); shared contract + helpers (`SetupStep`, `buildCard`, `setResult`, `createLife` = cleanup + "still alive?" guard for async results, `frames`, `wait`, `midiName`) in `setup/kit.ts`. `done(ok)` enables "next" (ok=false = tried, problems shown; next still allowed). A step already done keeps next enabled when revisited with back.
- ⋯ sheet row "Setup" (`data-row="setup"`): closes the sheet, calls `SheetActions.openSetup()` (main.ts must wire it; tsc fails there until it does).
- Selectors: `.wizard[data-step=<id>]`, `[data-wiz="skip-setup|back|skip-step|next"]`, `.wiz-opt[data-kind]`, `.wiz-circle(.on)`, `.wiz-pad[data-kind](.hit)`, `.wiz-hold`, `.wiz-meter`, `.wiz-result(.bad|.dim)`.
- Dev: `dev/ui/wizard.html` + `wizard-fake.ts` (fake SetupApi; params `steps=`, `ms=` click/hit period, `t=` wait scale, `voice=loading|ready|error|off`, `miss=1`, `quiet=1`; hooks `window.__wiz`, `window.__gestures`). shots.ts: `shootWizard`, `checkWizard`, `checkSetupRow`.
- Screenshots (abs): `/Users/kasparasanusauskas/Projects/personal/sing-worktrees/shell6/dev/ui/out/wizard-{listening,mic,mic-result,latency,drums,drums-pad,voice,voice-range,commands-loading,commands-holding,commands}.png`

### Decisions I took (brief did not settle)
- Step titles: "What are you listening on?", "Mic check", "Latency", "Teach me your drums", "Your voice", "Voice commands"; the brief's sentences are the instruction line.
- Mic: starts by itself on mount; hum window 4 s; "good" = peak >= 0.05 AND >= 3x the noise floor; meter is sqrt-scaled (mark at sqrt(0.05)); "try again" only after a bad result.
- Listening: "play test tone" appears after a choice, the "hear it clearly?" question after the tone is pressed; "no" shows the tip and allows next.
- Drums: >= 1 heard hit accepts a sound (0 -> "didn't hear that", retry); "teach again" restarts from kick and drops templates; "sounds right" stops the pad and saves.
- Voice: the engine's `singAlong` plays the reference note (UI does not); display is octave-folded; "right on pitch" under 10 cents; `tuningOffset` saved on every ok result; range sub-step is a "your range" button (3 s per note, saved when hi > lo).
- Commands: hold button needs status 'ready'; 'off'/'error' stop polling and allow next; first "heard" result = done(true).
- `ALL_STEPS` objects are plain mutable, the dev page wraps their `mount` in place to count cleanups.

### Questions
1. Is a 4 s hum window / 3x floor rule right for the mic check, or should the engine return a verdict?
2. The wizard lets the user finish with nothing done (every step skippable); setupDone is set on both onDone(true/false) in main.ts as today.

## Round 4: transport, tempo, seek (branch shell7)
Signatures for main.ts (tsc fails there until wired):
- `mountLanes(root, opts): LanesApi` where `LanesApi = { posAt(clientX: number): Sec | null; destroy(): void }` (exported type). `posAt` maps the lane body (screen x = area left + 12 + 64 .. width - 12 - 12) to 0..L, clamped to [0, L - 1e-6]; null without a loop. The tap gesture carries `x`, `y` (absent for the Space key): main calls `lanes.posAt(g.x)` and `controller.seek(pos)`.
- `mountTransport(root, { view, onAction(a: TransportAction) }): () => void` (mount on the stage; it is `position: fixed`).
- `mountTempo(slot, { view, onToggleClick, onSetTempo(bpm), clickOn }): () => void`; slot = `document.querySelector('.topbar-left')` (created by mountSheets, so mount the tempo after mountSheets).
- Selectors: `.transport`, `.transport [data-button="toStart|playPause|record"]` (aria-label play/pause, record/stop recording), `.tp-pos`, `.tp-state`, `.tp-right`; `.tempo`, `.tempo-num`, `.tempo-val`, `[data-tempo="down|up"]`, `.tempo-select` (`.shown` when visible), classes `.tempo.locked|muted|picking`.
- Dev scenes: `transport-stopped`, `transport-countin`, `transport-recording`, `tempo-muted`, `tempo-locked`, `tempo-picker`; fake tempo 96 bpm, loop 4 bars = 10 s (`FROZEN_T` 3.8 s = bar 2 beat 3 just after the beat). `window.__lanes` exposes posAt. shots.ts runs the tempo checks in Chromium and WebKit.

### Decisions I took (brief did not settle)
- Transport buttons act on `pointerdown` (no release latency); keyboard clicks (detail 0) also act. ⏮ is also disabled in idle without a loop. ▶ is disabled only in idle without a loop.
- Seek geometry: `posAt` uses the real drawn body (76 .. width-24), not the brief's literal 64..width-12 (those are lane-local).
- Tempo number: the hold arms at 450 ms (outline + haptic) and the picker opens on RELEASE (touch release grants the user activation `showPicker()` needs). WebKit (Playwright) has no `select.showPicker`: the select appears in place and is focused.
- Locked tempo (!tempoEditable): -/+ and the number-hold still call `onSetTempo` once (no repeat; hold passes the current bpm) so main can toast why; buttons are dimmed. Short tap on the number always toggles the click.
- Top bar at < 400 px: echo slider 72 px; echo label hidden < 360 px (fits to 320 px, checked).
- Pulse flash strength: rec 60%/32% (downbeat/other), fg 24%/11%, decays over 60% of the beat. Record button swell 7% (downbeat 1.8x).
- During countIn the playhead is drawn in --rec at `view.playhead ?? 0`.
