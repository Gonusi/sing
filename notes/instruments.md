# Instruments — design, parameters, checks

Owner: instruments area (`src/instruments/`, `public/samples/violin/`, `dev/instruments/`). Written 2026-10-17.

## Files
| File | What |
|---|---|
| `index.ts` | `preloadInstruments(ctx, onProgress)` and `createVoice(kind, ctx)` (both take `BaseAudioContext`) |
| `shared.ts` | context type, `midiToHz`, `velGain`, `noteSpan`/`earliestStart` (catch-up and late notes), the stopAll `Gate`, fixed `output` |
| `phrase.ts` | legato phrase lifecycle (one attack, legato moves, one release, provisional release, portato), used by violin and bass |
| `violin.ts` | violin phrase sound: looping sample layers, playbackRate glides, sample-switch crossfades, lowpass + room |
| `violin-assets.ts` | sample download/decode/prep (mono, trim, level, baked loop crossfade) and the room impulse, cached per sample rate |
| `bass.ts` | bass phrase sound: soft-saw oscillator, pitch-tracked lowpass, portamento |
| `synth.ts` | pool of `Tone.Synth` (plucky, polyphonic) |
| `drums.ts` | `MembraneSynth` kick, `NoiseSynth` + tonal body snare, `MetalSynth` hat |
| `tone-util.ts` | `toneContext(ctx)` (verifies the engine's `Tone.setContext`), `silenceEnvelope` |
| `blip.ts` | plain Web Audio `ok` / `err` / `click` |

## What the engine must know
- **Setup:** call `Tone.setContext(ctx)` before `createVoice('synth' | 'drums')`. If Tone is not on `ctx`, `createVoice` throws. Instruments never call `setContext`, and never use Tone globals (Transport, Destination, Draw, `context`, `toDestination`). Every Tone node gets an explicit `context` and connects to the voice's own native nodes. Violin and bass don't use Tone at all.
- **Preload:** `preloadInstruments(ctx)` must resolve before `createVoice('violin')`, which throws otherwise. Downloads 8 mp3s (2.5 MB) from `BASE_URL + 'samples/violin/'` in parallel, decodes them one at a time, and builds the room impulse. Progress is reported in 9 steps.
  - It **rejects** if a sample fails to load.
  - Cached per sample rate (module level). A second call is free.
- **`output`:** a native GainNode at a fixed trim level. Connect it, and don't automate it.
- **Levels** (vel 0.8, one note, measured):

  | Voice | Note RMS (dBFS) | Peak (dBFS) |
  |---|---|---|
  | violin | −19 to −20 | −8 |
  | synth | −22 | −12 |
  | bass | −19 | −10 |
  | kick | | −6 |
  | snare | | −9 |
  | hat | | −14 |

  Three drum hits at the same instant peak at −1.4 dBFS. **Four tracks together can exceed 0 dBFS, so the master needs about 6 dB of headroom or a limiter.**
- **Hand-over:** any lead time works. Notes can arrive any time before `when`; 0.12 s is fine.
  - **Late note** (`when` already passed): it starts at `currentTime + 10 ms` (`LATE_MARGIN`) and skips what it missed, so it still ends on time. The same rule covers `offset` catch-up. A violin note starts the sample further in by the skipped time.
  - **Legato continuation:** it must be handed over before `previous end + 0.25 s` (`LEGATO_GRACE` 0.3 − `CANCEL_SAFETY` 0.05). If it comes later, it starts a fresh phrase (an attack): a graceful fallback, not an error. With the 0.12 s look-ahead and legato gaps under 120 ms, the margin is wide.
- **Phrase boundaries need nothing from the engine.** The voice reads `phrase` and `legatoNext` only. Phrase ids must be identical across loop cycles; in a wrapped phrase the first note of the next cycle carries the same id. A different phrase id while a phrase is open releases the open one and starts a new one.
- **Open phrases end by themselves.** A note with `legatoNext` and no continuation (track off and no longer scheduled, lane re-recorded, note dropped) releases 0.3 s after its end. There is never a stuck note.
- **`stopAll(at)`:** silent by `at + 25 ms`. This includes notes handed over earlier but due after `at`. It resets phrase state: a continuation that arrives afterwards starts a fresh phrase. The next note reopens the voice; nothing needs re-creating.
- **Overlaps:**
  - Violin and bass play overlapping phrases polyphonically, e.g. a note longer than the loop overlapping its own next occurrence.
  - Synth has 8 voices and steals the one that frees up first.
  - Drums drop a second hit of the same kind within 10 ms. Drums ignore `offset`: a late hit plays at `now + 10 ms`, and the scheduler drops hits more than 30 ms late.
- **Onset latency** (−20 dB point after `when`): synth, bass and drums ≈ 0 ms; violin ≈ 5–15 ms (bow attack plus 40 ms fade-in). Optional engine trim: about −10 ms for the violin.
- **Blips:** `playBlip(ctx, kind, when?, destination?)`. A missing `when` means `now + 5 ms`. The click's first sample is exactly at `when` (peak 0.6), for calibration.

## Voices
### Violin: legato phrase voice (native Web Audio)
Graph: per phrase, [looping sample layer → layer gain]… → phrase envelope → lowpass 7 kHz → dry (1.0) + convolver room (wet 0.18) → gate → output (1.0).

The algorithm, in `phrase.ts` and `violin.ts`:
1. **New phrase** (no open phrase with this id): the gate reopens. A new envelope GainNode starts from 0, rises with `setTarget(velGain, start, τ = 13 ms)` (≈ 95 % in 40 ms), and holds.
   - One layer starts: the sample whose tuned root is nearest (ties → the lower one), `loop = true`, `playbackRate = 2^((midi − root)/12)`, buffer offset `skipped × rate`.
2. **Legato continuation** (same id, the open phrase's provisional release still in the future): the provisional release is cancelled. The level moves to the new vel (`setTarget`, τ 50 ms). No new attack.
   - Within ±2 semitones of the playing sample's root: glide `playbackRate` with an exponential ramp over 50 ms from the note start.
   - Further away: start the nearest sample at 0.3 s (past its bow attack) at the old pitch. Both layers glide to the new pitch over 50 ms while an equal-power `setValueCurveAtTime` crossfade runs over 70 ms. The old layer is then stopped and retired.
   - Same pitch again: portato. The level dips to 0.5 (−6 dB at the envelope, ≈ −3.5 dB heard after the room) 40 ms before the repeat, then returns. Without it, two same-pitch legato notes would merge into one tone and the rhythm would be lost.
3. **Release:**
   - Last note (`!legatoNext`): `setTarget(0, end, τ = 0.1 s)`, heard as ≈ 0.3 s; the sources stop at `end + 0.7 s`.
   - Note with `legatoNext`: the same release is scheduled **provisionally** at `end + 0.3 s`, and a continuation cancels it.
4. **Long notes:** each sample has a loop region with an equal-power crossfade baked into its end (0.3 s), so playback wraps from `loopEnd` to `loopStart` seamlessly. A note sustains for any length without refreshing its source, and pitch glides don't affect the loop. Checked: a 20 s note has no dip over 2.8 dB and no periodicity break.
5. **No synthetic vibrato:** the recordings already carry ±15–20 cents of vibrato at about 5 Hz.

**Invariant** (written in `phrase.ts`): every phrase is either OPEN or CLOSED.
- OPEN: its last note had `legatoNext`; a provisional release is pending. It may be continued only while `now + 50 ms < releaseAt`, i.e. before any of the release has rendered. At most one phrase per voice is OPEN.
- CLOSED: the release is final; it is never continued, and it is disconnected after its sources stop.
- Envelopes use only `setValueAtTime`/`setTargetAtTime`. So `cancelScheduledValues(t)` for a future `t` removes exactly the pending release and never cuts a ramp in progress. Source `stop()` may be re-issued: the last call wins, per spec, checked in Chromium and WebKit.

### Samples (`violin-assets.ts`)
- VSCO 2 violin sustains G3 C4 E4 G4 C5 E5 G5 C6 (mono mp3, 44.1 kHz, 12–17 s each). They come from nbrosowsky/tonejs-instruments (CC-BY 3.0); credits are in `public/samples/violin/CREDITS.txt`.
- **Preparation per sample:**
  1. Mono.
  2. Trim to the onset (first sample above −40 dB of the peak, minus 2 ms; the mp3s carry about 27 ms of encoder delay).
  3. Cut at the loop end.
  4. Normalise RMS over 0.5 s → end to 0.12.
  5. Flatten slow level drift by 80 % (250 ms windows; the first 0.25 s keeps its natural shape).
  6. Bake the loop crossfade.
- **Tuning** (median YIN pitch, cents): G3 −2, C4 0, E4 0, G4 +2, C5 +6, E5 +11, G5 +5, C6 −9. `root` = note + cents / 100.
- **Bow changes:** the recordings contain bow changes, measured as periodicity breaks of 0.4–1.1 against a normal 0.01–0.06:

  | Sample | Bow changes at (s) |
  |---|---|
  | G3 | 3.69 |
  | E4 | 3.19, 6.28 |
  | G4 | 3.21, 6.36 |
  | G5 | 6.10 |

  A note plays from 0 up to the loop end and then loops, so each loop region ends before its sample's first bow change:

  | Sample | Loop region (s) |
  |---|---|
  | G3 | 1.0–3.5 |
  | C4 | 1.5–7.5 |
  | E4 | 1.0–3.0 |
  | G4 | 1.0–3.0 |
  | C5 | 1.5–7.5 |
  | E5 | 1.5–7.5 |
  | G5 | 1.5–5.9 |
  | C6 | 1.5–7.5 |

  Smaller irregularities of 0.15–0.18 (C5, E5, C6) are left in. A long note on E4 or G4 therefore repeats every 2 s of sample time.
- **Memory:** 45 s of mono float32 at 48 kHz ≈ 8.7 MB kept. Decoding one file at a time holds at most one full decoded recording (about 3 MB) extra.
- **Room:** a 0.9 s mono impulse: low-passed (4 kHz) seeded noise, 8 ms pre-delay, exponential decay τ 0.16 s (RT60 ≈ 1.1 s), through a normalising ConvolverNode.

### Bass: legato phrase voice (native)
- **Graph:** per phrase, oscillator (PeriodicWave, harmonics 1, 0.6, 0.42, 0.3, 0.22, 0.16, 0.11, 0.08, 0.055, 0.04) → lowpass → phrase envelope → gate → output (0.32).
- **Lowpass:** sustain cutoff = f0 × 6, clamped to 350–1600 Hz, Q 2 dB. At the pluck it starts 2.5× higher and falls with τ 70 ms. Harmonics 2–6 carry the pitch on phone speakers.
- **Envelope:** attack τ 3 ms; decays to 0.7 from 15 ms on (τ 0.18 s); vel τ 30 ms; release τ 45 ms (≈ 0.1 s heard, stops after 0.3 s); portato dip 0.7.
- **Legato:** portamento with an exponential frequency ramp over 30 ms; the cutoff follows (τ 30 ms). Release and lifecycle are the same as the violin's (`phrase.ts`).

### Synth: pool of `Tone.Synth`
- Custom partials 1, 0.5, 0.3, 0.18, 0.1, 0.06, 0.035, 0.02 (a soft, rolled-off saw, one oscillator per note).
- Envelope: attack 5 ms, decay 0.18 s, sustain 0.5, release 0.2 s. Output 0.3.
- Up to 8 voices, created lazily. A free voice is one whose note and release are over; when none is free, the voice that frees up first is stolen (one whose last start is strictly earlier, as Tone requires).
- stopAll: the gate closes, and each busy envelope gets a 15 ms Tone release or has its future events cancelled.

### Drums: Tone
- **Kick:** MembraneSynth at 50 Hz, pitch drop of 6 octaves over 40 ms, decay 0.35 s; gain 0.9.
- **Snare:** white NoiseSynth, high-passed at 500 Hz and low-passed at 6 kHz, decay 0.16 s (gain 0.5), plus a 185 Hz triangle body, decay 0.08 s (gain 0.35).
- **Hat:** MetalSynth at 320 Hz, harmonicity 5.1, modulation index 32, resonance 5 kHz, 1.5 octaves, decay 70 ms; gain 0.12.
- Output 0.65.
- Spectral centroids: kick 97 Hz < snare ≈ 5.0 kHz < hat ≈ 13.1 kHz.
- Safety: a second hit of the same kind within 10 ms is dropped, and every trigger sits in try/catch.

### Blips
- `ok`: E5 → B5 sine, 60 ms each, peak 0.16.
- `err`: E4 → A3 triangle, 90 ms each, peak 0.2.
- `click`: a 5 ms noise burst, first sample 0.6.

## Deviations from the brief (and why)
- **Synth is a pool of `Tone.Synth`, not `Tone.PolySynth`.** PolySynth defers future notes through `context.setTimeout`, which only fires on Tone's clock ticks. That ties note timing to the engine's `lookAhead`, and the deferred notes never fire in a raw offline render. The pool schedules every note at its exact time.
- **Bass is a native phrase voice, not `Tone.MonoSynth`.** Cancelling a provisional release in MonoSynth needs Tone internals (envelope, filter envelope and oscillator stop each). Sharing `phrase.ts` with the violin gives both voices the same tested legato, watchdog and overlap behaviour, and it is cheaper.
- **Violin:** looping a pre-crossfaded sustain region replaces "refresh by crossfading to a fresh source". There is nothing to schedule or cancel for long notes, and no click.
- **Added:** the portato dip on repeated pitches; `LATE_MARGIN` (no attack is ever scheduled in the past); and 5 files in `src/instruments/` beyond the brief's list (`shared.ts`, `phrase.ts`, `violin-assets.ts`, `tone-util.ts`), all in this area.
- **`ctx` widened** to `BaseAudioContext` in `createVoice`, `preloadInstruments` and `playBlip`.

## CPU and memory
- **Per violin voice:** one BiquadFilter and one ConvolverNode (a 0.9 s mono impulse ≈ 43 k taps, FFT-partitioned; small on phones), plus gains. Per sounding phrase: 1 buffer source and gain (2 during a 70 ms switch). A released phrase's sources stop about 0.7 s after its end; its nodes are disconnected at the next `play()` or `stopAll()` after that.
- **Bass:** one oscillator, biquad and gain per sounding phrase. No Tone.
- **Synth:** Tone.Synth instances are created on demand, up to 8. Each keeps a few always-running ConstantSourceNodes (Tone signals); cheap, but not zero.
- **Drums:** one fixed set of Tone synths per voice.
- **Memory:** violin buffers ≈ 8.7 MB plus the room impulse (170 KB). The Tone bundle is part of the 239 KB main chunk (62 KB gzip).

## Checks (`node dev/instruments/check.ts [chromium|webkit]`)
Each engine opens `dev/instruments/index.html` and renders into native `OfflineAudioContext`s (48 kHz, Tone pointed at each). Events are handed over at `when − 0.12 s` through `suspend()`/`resume()`, so `ctx.currentTime` inside the voice is the real hand-over time. A real-time smoke test then runs on a live AudioContext. About 2 s of offline time plus 7 s of real time per engine. The WAVs go to `dev/instruments/out/<engine>/` (gitignored).

**Results on 2026-10-17: all 29 checks pass on Chromium and on WebKit.**

| Check | Pass rule | Measured |
|---|---|---|
| Pitch per note, synth (C4 E4 G4 C5) | ±30 cents | 0 |
| Pitch per note, violin (all 8 roots + transposed D4 A4 D5) | ±30 cents | −11 to +6 |
| Pitch per note, bass (C2 E2 G2 A2 C3) | ±30 cents | 0 |
| Violin legato C5 D5 E5 G5 A4 C5 (4 sample switches, one note handed over 4 ms late) | see legato rules below | 1 attack · dip 3.7 dB · boundary rise ≤ 0.6 dB · old pitch −19 to −31 dB · sustain break 0.03 · transition break 0.23 |
| Bass legato | see legato rules below | 1 attack · dip 1.5 dB · old pitch ≤ −25 dB |
| Repeated pitch in a phrase | 1 attack, dip 2–6 dB | violin 3.6 dB · bass 4.8 dB |
| 20 s violin note (A4: the G4 sample loops 8 times) | dip ≤ 6 dB, break < 0.3, 1 attack | dip 2.8 dB · break 0.053 · 1 attack |
| Violin samples, white box | no break over 0.3 before the loop end; loop seam (spliced) below 0.3 | inside ≤ 0.18 · seam ≤ 0.05 |
| Violin staccato (gaps 0.2 s) | 4 attacks, each gap at least 10 dB down | 4 attacks · 15–20 dB down |
| Drums centroids | kick < snare < hat | 97 Hz < 5.0 kHz < 13.1 kHz |
| Drums flams | hits 1 ms apart and same-time hits don't throw | no errors |
| Catch-up (dur 1.0, offset 0.3) | sounds as long as a 0.7 s note (±50 ms) | ✓ violin, synth, bass |
| Late hand-over (5 ms) | clean start: first 0.5 ms below −15 dB re peak | violin −44 dB · synth −24 dB · bass −21 dB |
| Wrapped phrase (`legatoNext` on the last note), 2 cycles | legato rules; ends by itself | 1 attack · no rise at the loop boundary · silent (−100 dBFS) 2 s after the last note |
| stopAll | silent within 30 ms, including a note handed over before the stop; plays again after | −100 dBFS from 30 ms on, all 4 voices |
| Blips | render; click onset exact | click onset 0.00 ms |
| Real-time smoke | sound, right pitch, no exceptions | ✓ all 4 voices |

The legato rules: exactly 1 attack, envelope dip ≤ 6 dB, boundary rise < 3 dB, old pitch below −12 dB after the change, sustain periodicity break below 0.3, transition break below 0.3.

**Detectors** (`dev/instruments/analysis.ts`):
- 20 ms RMS envelope.
- Attack: a rise of 10 dB or more within 80 ms.
- Boundary rise: the peak after the boundary against the peaks over the preceding 200 ms. Comparing peak to peak cancels the samples' natural ±2.5 dB, ~5 Hz tremolo; a max-against-mean comparison read up to 3.6 dB without any attack.
- Old-pitch energy: FFT band energy at the previous note's pitch ±50 cents, against the new pitch, from 80 ms after the change. This tells a legato move from a re-attack, whose release overlaps the new note.
- Periodicity break: a normalised difference against the best lag near the period. A bowed string is sawtooth-like, so a first-difference "click" test cannot see an unfaded seam; this detector can.
- YIN fundamental; spectral centroid.

**Mutation tests.** Each was run once and reverted; each was caught:

| Mutation | Caught by |
|---|---|
| Every legato note re-attacks | 4 legato and wrap checks |
| No baked loop crossfade | 20 s note, sample seam |
| Hard sample switch (0.5 ms crossfade) | legato and wrap transition break |
| stopAll gate removed | stopAll |
| No provisional release | 6 checks |
| `LATE_MARGIN` < 0 | synth late start |

Not caught: switching to a sample at offset 0 (bow attack). The VSCO attacks are soft enough that the rendered envelope shows nothing, so the 0.3 s entry is kept on judgment.

## Open questions and ideas
- **Listen on a phone.** Check the room level (wet 0.18), the violin lowpass, synth and bass brightness, and the drum balance. Listening WAVs: `dev/instruments/out/chromium/violin-legato.wav`, `violin-wrap.wav`, `violin-staccato.wav`, `violin-long-69.wav`, `bass-legato.wav`, `synth-notes.wav`, `drums-groove.wav`, `blip-*.wav`.
- **E4/G4 loops are only 2 s.** If long notes on them sound repetitive, the region after the first bow change (3.3–6.1 s) could serve as a second sustain stretch reached by a crossfade.
- **Velocity range** (`VEL_FLOOR` 0.35 ≈ 9 dB range) is a guess until real sung takes exist.
- **Optional:** expose per-voice onset latency so the engine can pre-compensate the violin's ~10 ms.
