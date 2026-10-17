# dsp — analysis, fixtures, analyzer

Owner: dsp agent. Files: `src/analysis/{pitch,segment,autotune,phrases,drums}.ts`, `dev/{wav,make-fixtures,analyze}.ts`,
`dev/fixtures/out/` (generated, gitignored), this file.

Run: `node dev/make-fixtures.ts` (≈1 s, 18 fixtures) then `node dev/analyze.ts` (≈3 s; exit 1 when a gated threshold fails).
`node dev/analyze.ts take.wav` on a WAV without a `.json` next to it just prints the detections (for real phone takes);
`--drums` / `--notes` force a pipeline, `--verbose` lists every match.

## For the engine (read this)

- **Clock.** Every time in and out is the mic-stamp clock: `block.frame / sampleRate`. `PitchFrame.t` is the window centre.
  Subtract `inLat` yourself. `close(at)` takes `at` in the same clock (window end + inLat).
- **Blocks.** Any length works (results are identical for 128, 300, 512, 1000-sample blocks). A block whose `frame` does not
  continue the previous one (or a new sample rate) restarts the tracker / detector at that block.
- **Finalisation delays** (mic-stamp time of the end of the block whose `push()` returned it, measured on the fixtures):
  - notes: **≤ 140 ms after the note's end** (measured max 137 ms). Legato-ended notes (pitch change or dip): median 82 ms,
    max 137 ms (a marginal pitch change needs 70 ms of evidence). Gap-ended notes: median 92 ms, max 114 ms.
  - hits: **≤ 82 ms after the onset** (70 ms classification span + one 512-sample block; measured max 81.3 ms).
  - `seg.open()` shows the note being sung about 40–50 ms behind real time (2-frame median lag + half the 43 ms window);
    its onset is provisional until the note is emitted (the energy refinement can move it by ≈ ±15 ms). After a note ends,
    `open()` keeps returning it until it is emitted, so the drawing does not flicker.
- **`NoteSegmenter.close(at)`**: processes the frames before `at`, truncates the open note at `at`, drops notes that start at
  or after `at` and notes shorter than 80 ms after truncation, returns the finals, then resets; frames with `t < at` pushed
  afterwards are ignored. Notes already returned by `push()` are not clipped by a later `close()` (frames pushed past the
  window end can still finalise a note that ends after `at`): clip what you receive to your window.
- **`OnsetDetector.close(at)`** (new, asked by the coordinator; `createOnsetDetector()` returns `ClosableOnsetDetector`
  until `src/types.ts` has it): force-classifies every onset before `at` that is still waiting for its 70 ms span, on the
  audio before `at` (later samples count as silence; with < 10 ms of audio the span starts at the onset), returns those
  hits and resets. Hits before `at` are never returned after it. Checked: cutting 5 / 15 / 30 ms after each fixture hit
  returns 30/30 hits with the right kind for 29 / 30 / 30.
- **Register fit:** `registerShift(take.notes.map(n => n.midi), kind)` once per take, then `snapMidi(midi) + shift` per note.
- **Phrases:** `assignPhrases(notesSortedByPos, loopLength, takeId)` after snapping; a gap < 120 ms is legato, circular.
- **Velocity:** notes `vel` = note RMS mapped −50..−10 dBFS → 0..1; hits `vel` = peak 10 ms RMS mapped −46..−6 dBFS → 0..1.
- **Speed (Node 24 on the dev Mac):** notes ≈ 85× realtime, drums ≈ 280× realtime.

## Proposed contract changes (for the coordinator)

1. `OnsetDetector.close(at: Sec): RawHit[]` — implemented (see above).
2. Document in `types.ts`: `PitchFrame.rms` is the RMS of the central 20 ms of the window (not the whole 43 ms window; the
   segmenter needs the finer time resolution for onsets and repeated-note dips). The volume gate uses the whole window.

## What each module does (final parameters)

### pitch.ts
pitchy `findPitch` on a 2048-sample window, hop `round(0.010·sr)` (480 / 441). Voiced iff whole-window RMS ≥ 0.008, clarity ≥
0.85, 70 ≤ hz ≤ 1100. **Lag-limited fallback:** pitchy searches every lag, and in fast glides the NSDF at a very long lag
(few overlapping samples) beats the real period (seen: 26 Hz at clarity 0.96 in a G3→E3 slur). When pitchy's answer is out
of range, the McLeod peak picking is redone on lags for 70–1100 Hz only, on pitchy's own `Autocorrelator`. In real glides
that mostly gives an honest low clarity (dropout) instead of a confident wrong pitch.

### segment.ts
Per 10 ms frame, frame i processed when i+2 arrives:
- centred median of 5 on fractional MIDI;
- **pitch change:** departure > **0.5** semitone from the running note median, same side; confirmed after **4** frames when
  the candidate median is ≥ 1.0 semitone away, after **7** frames when closer, and only if it rounds to a different
  semitone. The new note starts where the pitch crosses halfway between old and new (glide centre, interpolated).
  Shorter runs are folded back (±12 / ±24 octave errors moved back first) = the octave fold.
- **gaps:** 2 unvoiced frames end a note; a gap < 50 ms re-joins it if it rounds to the same semitone and no dip happened;
  a pitch change across an unvoiced gap < 120 ms with no energy dip is a **legato dropout** → the new note starts mid-gap.
- **repeated notes:** frame RMS ≥ 6 dB below the note's peak, then ≥ 4 dB back up within 300 ms → split at the dip minimum.
- min note 80 ms; a too-short note that runs straight into the next one is absorbed into it (onset moves back: scoops).
- **onset after a gap:** energy refinement — where frame RMS crosses floor + 15% of the way to the note level, searched
  5 frames before to 4 after the first voiced frame; only when the level rises ≥ 6 dB (a real attack).
- note midi = median of the accepted values (fractional, unsnapped); vel from the note RMS.

### drums.ts
Spectral flux on FFT 512 / hop 256 / Hann (fft.js), `log1p(10·|X|)` with |X| scaled so a full-scale sine bin ≈ 1.
Onset when flux > **median + 2·(1.4826·MAD) + 0.2** of the previous 40 frames, local max ±3 frames, ≥ 60 ms apart, ≥ 8 frames
of history, RMS of the next 30 ms ≥ 0.004, and a **sharp attack**: in the band below or above 6 kHz, the loudest frame in
the 30 ms after the onset is ≥ 6 dB above the loudest frame centred 40–10 ms before it.
Classification on the frames in 10–70 ms after the onset, **after subtracting the room-noise floor** (quietest 4-frame
stretch of the last second, ×1.1) and skipping frames below 2× that floor:
kick if energy < 300 Hz > **60%** or centroid < 900 Hz; hat if centroid > 5 kHz or energy > 6 kHz > 45%; else snare.

### autotune.ts / phrases.ts
`VIOLIN_SWEET_RANGE` 69–76 (A4–E5), `BASS_SWEET_RANGE` 40–45 (E2–A2); synth and drums 0. Ties → smaller shift.
`LEGATO_GAP_SEC` 0.12, circular across the loop end; a single note that fills the loop is `legatoNext` into itself.

## Changes from the brief's starting numbers, and why

| setting | brief | now | measured reason |
|---|---|---|---|
| pitch departure | 0.7 st, 3–4 frames | 0.5 st; 4 frames if ≥ 1 st away, else 7 | ±30-cent detune makes a semitone step as small as 0.4 st; wide vibrato (±60 c) peaks last 30–55 ms and split notes at 4 frames |
| same-semitone rule | — | a change must round differently | vibrato / drift inside one semitone is never a new note |
| slur onset | first departed frame | glide-centre crossing | first-departed was 12–22 ms early on 3–5-semitone slurs |
| legato dropout | — | mid-gap onset when no dip | pitchy drops 4–5 frames in fast octave / third glides; onsets were 30–50 ms late |
| dip recovery | 6 dB | 4 dB | a repeated note sung 4 dB quieter than the one before was missed |
| flux threshold | mean + 2σ + 0.55 | median + 2σ̂(MAD) + 0.2 | at 16ths one loud hit in the 40-frame history inflated σ and hid the next soft hat (17/24 found); the 0.55 offset was 3× the room-noise flux (≈0.24) in this scaling and hid phone hats |
| attack test | — | ≥ 6 dB peak rise in one band | needed once the threshold got lower: breaths rise ≤ 5 dB, hats ≥ 8 dB on the fixtures |
| kick low ratio | 35% | 60% | the fixture snare's 200 Hz body holds 45–49% of its energy; kicks are ≥ 98% (centroid < 900 Hz still catches kicks with less) |
| noise-floor subtraction | — | yes | phone hats (−41..−44 dBFS after the 8 kHz low-pass) were classified snare: room noise pulled the centroid to 4.3–5.7 kHz; after: 7.7–9.3 kHz |

## Analyzer output (final run)

```
NOTES
fixture                      gt  det    ok       %  onset ms mean/max  extra missed pitch  final ms p95/max  speed
silence-noise                 0    0     0       -     0.0/0.0     0      0      0       0.0/0.0   124x
sing-cmaj-44k                 8    8     8  100.0%     4.3/9.6     0      0      0     98.4/98.4    88x
sing-cmaj                    16   16    16  100.0%    4.7/12.9     0      0      0     96.3/96.3    81x
sing-high                    16   16    16  100.0%    4.5/16.3     0      0      0     96.3/96.3    85x
sing-legato                  18   18    18  100.0%    5.9/15.7     0      0      0   137.0/137.0    89x
sing-low                     16   16    16  100.0%     2.9/5.7     0      0      0     95.7/95.7    78x
sing-repeated                12   12    12  100.0%     2.7/5.4     0      0      0   114.3/114.3    95x
stress-sing-fast*            12   12    12  100.0%     3.5/7.1     0      0      0   114.1/114.1   117x
stress-sing-noisy*            8    8     8  100.0%     4.3/6.1     0      0      0     95.7/95.7    59x
stress-sing-quiet*            8    8     8  100.0%     4.2/7.2     0      0      0     94.3/94.3    94x
stress-sing-vibrato*         16   16    16  100.0%    5.2/20.4     0      0      0   113.6/113.6    82x
stress-sing-vowels*           8    8     8  100.0%     3.0/5.8     0      0      0     95.7/95.7    79x
stress-sing-wide-vibrato*     8   17     8  100.0%     3.9/7.5     9      0      0   117.9/117.9    89x
sung total: 86/86 = 100.0% correct, onset error mean 4.2 ms max 16.3 ms, finalisation delay after note end p95 108.4 ms max 137.0 ms
stress total (not gated): 60/60 = 100.0% correct, onset error mean 4.1 ms max 20.4 ms

DRUMS
fixture                      gt  det    ok       %  onset ms mean/max  extra missed  kind  final ms max  speed  confusions
beatbox-basic                16   16    16  100.0%     2.0/4.0     0      0      0      80.0   275x
beatbox-phone                16   16    16  100.0%     1.8/4.9     0      0      0      80.0   272x
silence-noise                 0    0     0       -     0.0/0.0     0      0      0       0.0   291x
stress-beatbox-44k*          16   16    15   93.8%     2.4/4.6     0      0      1      81.3   300x hat→snare:1
stress-beatbox-fast*         24   23    23   95.8%     2.1/5.7     0      1      0      80.0   255x
stress-beatbox-noisy*        16    8     8   50.0%     2.5/4.9     0      8      0      80.0   311x
hit finalisation delay after onset: max 81.3 ms

speed: notes 85x realtime, drums 284x realtime

PASS
```
`*` = stress fixture (`gated: false` in its JSON): reported, never fails the run.

## Fixtures (`dev/make-fixtures.ts`, seeded mulberry32, 48 kHz mono 16-bit unless named -44k)

Ground truth `{ name, description, gated, sampleRate, durationSec, notes: [{t, dur, midi}], hits: [{t, kind}] }`; `t` is
seconds from the file start (attack start after a gap, boundary centre for a slur or dip; sample-exact drum start).
Voice = additive harmonics × cascade formants ("ah" 700/1220/2600 Hz; stress-vowels also "oo", "ee"), −6 dB/oct source,
30 ms attack, 40 ms release, vibrato 5.5 Hz ±30 c from 150 ms, ±30 c detune per note, 40 ms slur glides, ±4 c jitter,
3% shimmer, aspiration −26 dB, breath noise in gaps (−40 dBFS), room noise −45 dBFS.
Gated: `sing-cmaj`, `sing-cmaj-44k`, `sing-low`, `sing-high`, `sing-legato`, `sing-repeated`, `silence-noise`,
`beatbox-basic`, `beatbox-phone`. Stress: `stress-sing-{quiet,vibrato,vowels,fast,noisy,wide-vibrato}`,
`stress-beatbox-{44k,fast,noisy}`.

## Known weaknesses / to tune on real takes

- **Synthetic voices are easier than real ones.** Expect: scoops longer than 80 ms, breathy onsets, consonants, vocal fry,
  vibrato with amplitude modulation. First thing to do with the owner's exported takes: `node dev/analyze.ts take.wav`.
- **Operatic vibrato (±1 semitone)** still splits notes at vibrato peaks (stress-sing-wide-vibrato: 9 extra notes). ±60 c is
  fine. Fix if needed: a vibrato-aware reference (mean over one vibrato period) before the departure test.
- **Volume gate 0.008 (−42 dBFS)**: a quiet phone take (singer far from the mic, AGC off) may sit below it. If real takes show
  missing soft notes, try 0.004; clarity ≥ 0.85 still rejects noise.
- **Dip split (repeated notes)** will also split a sustained note with ≥ 6 dB tremolo or a fast swell (6 dB down, 4 dB up
  within 300 ms).
- **Hats near the room noise** are missed (stress-beatbox-noisy: hats at −41 dBFS in −32 dBFS room noise; 3 of the weakest
  hats in stress-beatbox-fast / -44k). The fixture hat is noise > 7 kHz and the phone variant low-passes at 8 kHz, which is
  harsher than a real "ts". A band-wise flux (low / mid / high with their own thresholds) is the next step if real takes
  miss hats.
- **Kick/snare/hat thresholds** are tuned on one synthetic kit. Real beatbox kicks through a phone may have centroids of
  300–800 Hz (still kick by the centroid rule); "pf"/"psh" snares may reach 3–5 kHz centroids (close to the hat rule).
  Retune `KICK_*`/`HAT_*` on real takes; `dev/analyze.ts --verbose` prints the confusions.
- `close()` of the segmenter drops a truncated note shorter than 80 ms (a note begun < 80 ms before the overdub window end).

## Ideas for the next run
- Add a debug flag to `dev/analyze.ts` that dumps per-frame pitch / RMS / flux around a time (I used throwaway scripts).
- Keep a small sweep harness for drum constants (copy the module, patch constants, score all drum fixtures) — it found the
  flux-offset and attack-gate settings in minutes.
