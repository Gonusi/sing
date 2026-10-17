# Voice notes (area: voice)

Owner files: `src/voice/{grammar,recognizer,load-progress}.ts`, `scripts/fetch-model.mjs`, `dev/check-grammar.ts`,
`dev/voice/*` (`make-speech.ts`, `index.html`, `page.ts`, `check.ts`, `replay.ts`, `memory.ts`, `compare-grammars.ts`). Fixtures: `dev/fixtures/out/speech/`
(generated, gitignored). Results: `dev/voice/out/*.json` (gitignored).

## Progress (voice agent, branch `voice`)
- [x] scripts/fetch-model.mjs (copy from VOSK_MODEL_CACHE or download, sha256-checked)
- [x] dev/check-grammar.ts (Gr.fst symbol table vs COMMAND_PHRASES)
- [x] src/voice/grammar.ts (GRAMMAR_JSON, EARLY_RULE, earlyCommand)
- [x] src/voice/recognizer.ts + load-progress.ts
- [x] dev/voice/make-speech.ts (say + ffmpeg fixtures, manifest)
- [x] dev/voice/ page + check (dev server, fast + real-time modes) + replay
- [x] gate on Chromium — PASS (dev, real mic path, 520 fixtures)
- [x] production build (preview, /sing/) run — PASS
- [x] WebKit attempt — loads and recognises (same accuracy)
- [x] memory: peak + steady (phys_footprint), cold/warm, both engines
- [x] notes complete
- [x] round 2: in-app on/off swaps explained; toggles are now `mute X` / `X back` (compare-grammars), gate + e2e green
- [x] round 3: `vocals` kind (vocal|vocals): 25 phrases, 664 fixtures; gate + e2e green, no vocal↔violin confusion

## Commands

```
npm run fetch-model                         # public/vosk/<model>.tar.gz, sha256-verified; VOSK_MODEL_CACHE=<file> copies a local one
node dev/check-grammar.ts [--words a,b]     # every command word in the model vocabulary (Gr.fst symbols, 152,217 words)
node dev/voice/make-speech.ts               # 520 fixtures, ~1 min (say + ffmpeg)
node dev/voice/check.ts --fast              # accuracy, 520 holds, ~70 s (fake feed, 8× real time)
node dev/voice/check.ts                     # real mic path + latency, 3 pages, ~6 min; gate → exit code
node dev/voice/check.ts --prod --filter …   # production build under /sing/ (+ main-app smoke)
node dev/voice/check.ts --engine webkit     # WebKit (report only)
node dev/voice/replay.ts [results.json]     # score EarlyRule candidates from recorded traces, no browser
node dev/voice/memory.ts [webkit|chromium]  # phys_footprint (jetsam metric) + kernel peak, cold/warm load (macOS)
node dev/voice/compare-grammars.ts          # toggle phrasings × hold conditions (~40 min; fixtures in speech-alt/)
```
Flags of check.ts: `--fast`, `--engine webkit`, `--prod`, `--filter a,b`, `--pages n`, `--release sec`, `--speedup x`,
`--tag name`, `--bed dBFS` (noise bed under the hold, e2e uses −45), `--lead sec` (speech starts later in the hold),
`--no-gate`. e2e-shaped hold: `--bed -45 --lead 0.4 --release 0.95`. The model's IndexedDB cache key is the full URL **including the dev server's free port**,
so the check wipes its profile each run (unless `PORT` is pinned): page 1 = cold load, pages 2+ = warm.

## API as built

| module | exports | notes |
|---|---|---|
| `voice/grammar.ts` | `COMMAND_PHRASES`, `UNK`, `GRAMMAR_JSON`, `normalizeText`, `displayText`, `parseCommand`, `canFireEarly`, `EarlyRule`, `EARLY_RULE`, `earlyCommand`, `describeCommand` | 25 phrases: `create drum|drums|violin|synth|bass|vocal|vocals track`, `record`, `stop`, `play`, `undo`, `mute <drum|drums|violin|synth|bass|vocal|vocals>` (→ `{toggle, on:false}`), `<same words> back` (→ `{toggle, on:true}`). `vocal|vocals` → kind `vocals`. `GRAMMAR_JSON` = phrases + `"[unk]"`. `parseCommand` is exact (one phrase, nothing else; any `[unk]` → null; `Object.hasOwn`, so "constructor" can't match). `displayText` drops `[unk]` for the screen. `EARLY_RULE` = ∞ (off), see below. |
| `voice/recognizer.ts` | `createRecognizer({ctx, mic, modelUrl, onTrace?}): Recognizer`, `TraceEvent`, `CHUNK_SEC`, `RELEASE_TAIL_SEC` | Contract unchanged. `onTrace` (optional, dev only) gets every reply `{kind: partial|endpoint|final, text}`. |
| `voice/load-progress.ts` | `constructWithProgress(modelUrl, construct)`, `PROGRESS_EVENT`, `ProgressDetail` | Real byte progress of the one model download (see Progress). |

### Behaviour per hold
1. `begin(fromT)`: takes the warm spare `KaldiRecognizer` (created right after load and after every hold, with
   `GRAMMAR_JSON`), feeds `mic.read(fromT, now)` (the ~300 ms since touch-down) and then every mic block, batched into
   80 ms chunks (`acceptWaveformFloat`). The ring read and the subscription happen in one task; a frame cursor
   trims overlap and survives gaps.
2. Each chunk gets exactly one reply. Partials → `onPartial(displayText)` (only on change).
   If vosk closes an utterance itself (endpoint: ≥ 0.5–1.0 s trailing silence, model.conf rules 2–4), that result
   is final-quality: if the text heard so far is a command, it fires at once (long holds get feedback before release).
3. `end()`: (a) keeps feeding **100 ms of audio after the release** (`RELEASE_TAIL_SEC`, push-to-talk "hang time"),
   (b) flushes, `retrieveFinalResult()`, waits for its reply (reply number `chunksSent + 1`; timeout 1.5 s),
   (c) fires if the heard text parses and nothing fired yet, resolves with the hold's command or null,
   (d) removes the used recogniser and creates the next spare.
4. Robustness: `begin` when not ready → no-op; `end()` without `begin` → null; `begin` twice → the first hold is
   finished; any worker error (recogniser error message, model error, worker `error` event) → status `'error'`,
   worker terminated, pending holds resolve; `load()` is idempotent and is the only promise that can reject
   (main.ts catches it). Load fails after 60 s without progress (stall watchdog, reset by every progress step).

### Invariants (in the file header)
I1 one `onCommand` per hold · I2 one reply per chunk + one for the final, in order → the final is reply
`chunksSent + 1` · I3 a recogniser serves one hold, nothing sent after `remove()` · I4 status only moves forward
· I5 `end()` always resolves.

## Decisions (with evidence)

**1. No early fire on partials (`EARLY_RULE` = ∞); commands fire on vosk's final result.** The PLAN asked for
early fire (complete, not a prefix; on/off after 2 identical partials). Replaying all 520 holds' reply traces
(`replay.ts`, fast run, release +0.3 s):

| rule: identical replies needed (all commands) | false positives /64 | wrong command /456 | fired before a +0.05 s release |
|---|---|---|---|
| 1 | 5 | 9 | 216 |
| 2 (≈ PLAN) | 5 | 9 | 149 |
| 3 | 5 | 9 | 62 |
| 4 | 0 | 3 | 25 |
| 5 | 0 | 2 | 3 |
| ∞ (final only) | 0 | 2 | 0 |

Why: at speech onset vosk's first-word partial (`record`, `violin`, `track`, `on`) typically sticks for exactly 3
replies (240 ms), sometimes 6, before it becomes `[unk]` — noisy "what a lovely day" fired `record` though the final
was empty; the sung line held `off` for 69 replies. `on`/`off` partials flip after 2–3 stable replies. The final
(lattice-based) is ~99 % right, and release→final costs only ~55 ms. What still fires *during* a hold: an endpoint
result (vosk closes the utterance after 0.5–1.0 s silence, model.conf rules 2–4) — final-quality, so long holds get
the blip before release. Re-run `replay.ts` on real-voice traces before switching partial early fire on.

**2. 100 ms release tail (`RELEASE_TAIL_SEC`).** Push-to-talk users let go while the last sound is still arriving,
and at release the ring lacks the ~15 ms in flight (more on iOS: input latency). Fast-mode sweep, final-only:

| release relative to speech end | clean | noisy | false positives |
|---|---|---|---|
| +0.3 s | 100 % | 98.7 % | 0 |
| +0.05 s | 100 % | 98.7–99.1 % | 0 |
| 0 s | 100 % | 98.7 % | 0 |
| −0.1 s, no tail | 93.9 % | 85.5 % (26 wrong: "off" → "on", the /f/ is cut) | 0 |
| −0.1 s, 100 ms tail | 100 % | 98.2 % | 0 |

Cost: +100 ms on every command (release→command ≈ 155 ms). Risk: a user who starts singing < 100 ms after
releasing feeds that onset into the hold; untested (a reaction that fast is unlikely).

**3. Exact parsing, no variants.** vosk emitted no harmless variants worth accepting (the `[unk]`-padded texts are
exactly the false-positive sources: "track [unk] record", "[unk] play violin"). `drum`/`drums` both stay phrases.

**5. Toggles are `mute <instrument>` / `<instrument> back`, not `<instrument> on|off`** (round 2).
The e2e (`voice-real.spec.ts`, full app) swapped 3/19 noisy on/off commands although my check had them right. Cause
(reproduced with `--bed -45 --lead 0.4`): not the app path or the release — the in-app hold has a −45 dBFS noise bed
and the speech starts ~0.4 s later in the hold; each change alone flips 2–6 Daniel/noisy toggles (the long release /
endpoint path alone changes nothing). vosk's online CMVN / i-vector adaptation sees different lead-in audio, and on/off
decisions — the words differ only in the weak final /n/ vs /f/ — sit on the boundary. So the phrasing was the bug.
`compare-grammars.ts`: each candidate grammar in the real recogniser, 3 hold conditions (plain; e2e-shaped; lead
0.2 s), scored by Command (drum = drums); "habit" = the other candidates' phrases spoken to this grammar:

| toggle phrasing (on / off) | noisy toggles plain / e2e / lead | false positives | habit phrase → OPPOSITE action |
|---|---|---|---|
| X on / X off (old) | 95.8 / 91.7 / 95.0 % | 0/64 | — |
| **X back / mute X** | **100 / 100 / 100 %** | 0/64 | **2–3 %** (mostly "synth off" → "synth back") |
| X back / X off | 100 / 100 / 100 % | 0/64 | 27–29 % ("X on" → "X off") |
| X on / mute X | 100 / 100 / 100 % | 0/64 | 32–33 % ("X off" → "X on") |
| X back / X off \| mute X | 100 / 100 / 100 % | 0/64 | 27–28 % |
| play X / mute X | (round 1: 100 % by command) | 0/64 | not run: `play` alone is transport |

Clean toggles 100 % everywhere; other commands 99.5–100 % (unchanged). With mute/back a habitual "violin off" mostly
does nothing (error blip → retry) instead of the opposite. After the switch (main fixtures regenerated): fast check
clean 228/228, noisy 226/228 (99.1 %), 0/64 FP; e2e-shaped fast run same; real gate 228/228, 226/228, 0 FP,
release→command 160/176 ms; `e2e/voice-real.spec.ts` 45/45 and `e2e/voice.spec.ts` pass. Remaining misses:
"mute bass" → "mute synth" (Samantha 170 noisy), "mute bass" → nothing (Fred 220 noisy, e2e-shaped), "play" →
nothing (Rishi 220 noisy).

**6. `vocals` kind (round 3).** `vocal`/`vocals` added (both in the vocabulary). Fixtures regenerated (25 phrases ×
6 voices × 2 rates × clean/noisy = 600 + 64 negatives). Fast: clean 300/300, noisy 299/300 (99.7 %), 0/64 FP;
e2e-shaped (`--bed -45 --lead 0.4 --release 0.95`): 300/300, 300/300, 0 FP. Real gate: clean 300/300, noisy
299/300, 0/64 FP, release→command 160/176 ms. Only miss: "mute synth" → nothing (Fred 220 noisy, heard "synth").
No vocal↔violin (or mute vocal↔mute violin) confusion in any run. `e2e/voice.spec.ts` (kinds list extended) and
`e2e/voice-real.spec.ts` (57 cases) pass. `compare-grammars.ts` keeps the round-2 kind list (historical tool).

**4. One warm spare recogniser.** Creation has no ack, but the worker queue is FIFO, so correctness never depends on
it; the spare only moves grammar compilation out of the hold.

## Measured (MacBook, M-series, 64 GB; localhost; TTS fixtures)

Fixtures (`make-speech.ts`): 19 phrases × 6 voices (Samantha en_US, Daniel en_GB, Karen en_AU, Moira en_IE,
Fred en_US, Rishi en_IN) × 170/220 wpm, speech normalised to −18 dBFS RMS, 0.3 s lead silence; each also with pink
noise at −30 dBFS (≈ 12 dB SNR). Negatives (64): 5 sentences × 6 voices ("hello there how are you", "what a lovely
day", "track the record player", "I like playing the violin", "turn the radio on"), sing-cmaj, silence; each clean +
noisy (noisy silence = noise alone). Hold model: touch-down = file start, `begin(tDown)` 300 ms later, `end()` after
the speech.

**Gate run, Chromium, real mic path** (`mic.inject` → worklet → ring → recogniser; 4 pages; release +0.3 s) — PASS:

| voice | 170 clean | 170 noisy | 220 clean | 220 noisy |
|---|---|---|---|---|
| Daniel | 19/19 | 18/19 | 19/19 | 18/19 |
| Fred | 19/19 | 19/19 | 19/19 | 19/19 |
| Karen | 19/19 | 19/19 | 19/19 | 19/19 |
| Moira | 19/19 | 19/19 | 19/19 | 19/19 |
| Rishi | 19/19 | 19/19 | 19/19 | 18/19 |
| Samantha | 19/19 | 19/19 | 19/19 | 19/19 |

- clean 228/228 = 100 % (gate ≥ 90 %) · noisy 225/228 = 98.7 % (gate ≥ 80 %) · false positives 0/64 · double fires 0.
- Misses (all noisy): `bass off`→`bass on` (Daniel 170), `drum on`→`drum off` (Daniel 220), `play`→nothing (Rishi 220).
- release→command: median 155 ms, p95 171 ms (gate ≤ 400 ms) = 100 ms tail + ~55 ms final. Speech end→command
  median 460 ms (release was at +300 ms).
- Tight release (+0.05 s): identical accuracy; release→command 155/165 ms; speech end→command median 208 ms, p95 220.
- Fast mode gives the same commands as real mode (same chunking → same reply sequence): use it for tuning (~70 s).

**Production build** (`--prod`): `startPreview()` main app with `?test&voice` → voice `ready` in 1.1 s, no console
errors; main chunk 298 KB, vosk lazy chunk 5,650 KB (gzip 2.4 MB; precached by the SW, the model is not). A
production build of the dev page under `/sing/` (SW blocked — see contract notes): Samantha + Daniel + negatives:
clean 76/76, noisy 74/76, false positives 0/64, release→command 171/187 ms. So the lazy import (CJS interop), the
absolute model URL and the progress wrapper all survive minification.

**WebKit** (Playwright WebKit 26.x, Safari's engine): loads (cold 0.93 s, warm 0.45 s), recognises, real mic path:
clean 57/57, noisy 56/57, false positives 0/64, release→command 171/181 ms.

**Load times** (localhost — on a phone the 41 MB download dominates: ≈ 33 s at 10 Mbit/s):

| | Chromium | WebKit |
|---|---|---|
| cold (download + unpack + IndexedDB write) | 0.89–0.98 s (download done at ~0.5 s) | 0.84–0.93 s |
| warm (IndexedDB → wasm) | 0.49–0.61 s | 0.45 s |

**Memory** — `phys_footprint` of the content process (page + vosk worker; the number iOS jetsam enforces) and the
kernel's exact lifetime peak (`dev/voice/memory.ts`; page = audio engine + test mic + recogniser, no instruments):

| | idle, no model | cold load peak | steady (+5 s, after 40 holds) | warm load peak (fresh process) | warm steady |
|---|---|---|---|---|---|
| WebKit | 56 MB | **834 MB** | 330 MB | 510 MB | 314 MB |
| Chromium | 37 MB | 480 MB | 326 MB | 315 MB | 308 MB |

Main-thread JS heap (Chromium `performance.memory`): 10 MB before load, 48 MB after (the recogniser keeps nothing
big on the main thread). Holds add nothing (330 → 330 MB over 40 holds: no leak per recogniser).
Against the owner's ~2 GB Safari kill line: the worst case — first launch in WebKit — is 834 MB ≈ 42 % of it, and
only for ~1 s; every later launch peaks at ~510 MB (25 %). Headroom for the rest of the app ≈ 1.1 GB. Caveats:
desktop WebKit, not iOS (allocator and limits differ; iPhones with 4 GB RAM may kill earlier than 2 GB).
The cold peak is the download + unpack + IndexedDB-write buffers inside vosk's worker (the tar is already unlinked
after unpacking by vosk). Tried: restarting the worker from IndexedDB right after a cold load — no gain (steady
331 vs 335 MB; transient buffers are freed within 5 s anyway), so not kept. Mitigations if a device does get
killed: (a) start `load()` on the first hold attempt instead of at boot, so the one-time peak never coincides with
a recording (costs the first user a wait); (b) never load while recordingFirst/overdubbing; (c) the lichess fork
(`@lichess-org/vosk-browser`, not installed) — measure it with `memory.ts` before switching. Releasing the tar
buffer earlier needs a vosk fork (it lives inside vosk's worker).

## Progress bar approach
vosk downloads inside its blob worker and posts nothing until ready; a second main-thread fetch could download
41 MB twice where the HTTP cache doesn't keep it (likely on iOS). So `load-progress.ts` swaps `window.Worker` for
the one synchronous `new vosk.Model()` call: vosk's worker starts from a 20-line wrapper that replaces the worker's
`fetch` with one counting the model response's bytes (posts `{event: 'sing-progress', loaded, total}`, which vosk's
Model re-dispatches as a CustomEvent), then `importScripts()` vosk's own worker blob unchanged. One download, exact
bytes. `onProgress` = 0.85 × bytes fraction during download (the rest is unpack + model creation), 1 at ready; a
cached load goes 0 → 1. Steps: Chromium ~160 (256 KB each), WebKit ~6 locally (large chunks; more on a real network).
The progress messages also feed the 60 s stall watchdog. Coupling: vosk-browser 0.0.8 internals (WorkerFactory
uses the global `Worker` at construction; the worker uses the global `fetch`); pinned by `^0.0.8`. Verified in
Chromium dev + prod build and WebKit.

## Contract / coordination notes
0. **Phrases changed (round 2):** `mute <instrument>` / `<instrument> back`; `Command` shape unchanged. Still to update
   outside my area: `e2e/states.spec.ts` lines 185–193 inject `'violin off'` / `'violin on'` (→ `'mute violin'` /
   `'violin back'`), PLAN.md ("`violin off` switches all of them"), the shell's empty-state/help hint.
   `describeCommand` toasts now say `mute violin` / `violin back`.
1. **Behaviour change vs PLAN** ("fires early on a partial … on/off needs 2 identical partials"): partials don't fire
   (decision 1); a command fires at an endpoint during the hold, else ~155 ms after release. The `Recognizer`
   interface and its docs ("fires once per hold, as soon as a command is certain") are unchanged. Please update the
   PLAN's Commands paragraph.
2. `RecognizerDeps` gained an optional `onTrace` (dev only); main.ts needs no change. New file
   `src/voice/load-progress.ts` (voice area).
3. main.ts attributes `onCommand` to the *current* `holdDown`; safe because `end()` resolves ~155 ms after release
   while the next `holdStart` is ≥ 300 ms after its touch-down. If that ever changes, `onCommand(c, tDown)` would be
   the fix (the recogniser knows each hold's `fromT`).
4. PWA (shell's `vite.config.ts`): `navigateFallback` + autoUpdate reload turn any dev page in a production build
   into the app (the check blocks service workers there). No effect on the real app.
5. PLAN says check-grammar uses `words.txt`; the small model has none — it reads `graph/Gr.fst`'s symbol table.
6. Decision for the coordinator: `navigator.storage.persist()` would protect the 71 MB IndexedDB copy from Safari's
   storage eviction (7 days without use, Safari tabs), but Firefox shows a prompt for it; not called.
7. CI: `npm run fetch-model` downloads 41 MB per deploy (7.9 s here); an `actions/cache` step with
   `VOSK_MODEL_CACHE` would skip it.

## iPhone risks to check by hand
1. **First launch memory** (834 MB peak in desktop WebKit, ~1 s during unpack): watch for a page reload/kill during
   the first model load, especially on 4 GB-RAM iPhones; Settings → info shows `voice loading NN%` / `ready`.
2. **Download on cellular**: 41 MB + 2.4 MB (gzip) lazy chunk; progress should move smoothly.
3. **Real voices**: TTS is a proxy. Try every command at normal speed, fast, mumbled; release early and late;
   say "violin off" from habit (should mostly do nothing).
4. **Loop playing through the speaker during a hold** (the mic hears the music): untested; the noise tests were pink
   noise only. With EC on (iOS voice processing) vs off.
5. **Latency**: release→command on the phone (desktop 155 ms of which 100 ms is the fixed tail).
6. **Background / interruption**: after returning from the background, a hold still recognises (the worker may have
   been suspended; any worker error turns voice to `'error'` until reload).
7. **Storage eviction**: in a Safari tab (not the home-screen app) the model may be evicted after 7 days → silent
   re-download.

## Next-run efficiency
- Tune with `--fast` + `replay.ts` (70 s + 1 s) and use the real-time run (4–6 min) only for latency/final numbers.
- Real-voice traces: record holds on the iPhone (lastTakeWav-style export of hold audio) → feed them as fixtures →
  replay EARLY_RULE / tail decisions on human speech.
