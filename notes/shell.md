# shell — notes (UI, gestures, icons, deploy workflow)

Checks: `npx tsc` clean, `npx vite build` ok, `node dev/ui/shots.ts` passes (screenshots + gesture/strip/sheet checks).

## Files
- `src/ui/start.ts` — start screen (`mountStart`): tap-to-start, progress, error + retry, fade-out.
- `src/ui/input.ts` — gesture layer (`mountInput`): tap / holdStart / holdEnd, Space key, no-gesture zones.
- `src/ui/lanes.ts` — canvas lanes + DOM strip buttons (`mountLanes`).
- `src/ui/status.ts` — pill, toast, command overlay, empty hint, flash (`mountStatus`).
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
- Status: `.pill` (class `idle|recordingFirst|playing|overdubbing|stopped`), `.toast`, `.cmd-overlay.on`, `.hint.on`.
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
