# Singing Loop App — Spec

## Concept
A minimal, voice-driven web app for making music by singing. You sing a melody, the app detects the notes, autotunes them, and plays them back on an instrument. Layers build up like a loop pedal. It is controlled mostly by voice, with almost no UI.

## Feel (non-negotiable)
- **Instant.** No pauses, no spinners. React as soon as there is enough signal.
- **Human.** Short spoken replies ("done", "rolling", "got it"), never robotic.
- **Musical.** Actions land on the beat; confirmation sounds are in the song's key.
- **Super minimal UI.**

## Example session
1. User: "create player john playing violin" → app immediately says "done".
2. User: "record" → beep → user sings "la la la la".
3. User says "stop" in a low voice → take ends, loop starts playing as violin, autotuned, with no gap.
4. User: "create player anna playing bass", "record" → records one loop cycle while the loop plays (user wears headphones) → new lane joins the loop.

## Input modes
- **Singing voice** (normal register) → turned into notes.
- **Command voice** = low pitch, below a per-user calibrated threshold → command recognizer acts on it.
- **Touch and hold anywhere** → forced command mode. This is the reliable fallback.

## Architecture (browser only, no backend for v1)
- **Stack:** Vite + TypeScript. No UI framework needed; canvas for the lanes.
- **Capture:** getUserMedia with `noiseSuppression: false`, `autoGainControl: false`. `echoCancellation` configurable (test `true` for speaker playback, `false` with headphones). AudioWorklet feeding a ring buffer.
- **Pitch:** pitchy (McLeod method) on ~10ms frames, with a clarity/confidence threshold.
- **Note segmentation:** live, during recording, so playback is instant after "stop". Median filter, reject sudden octave jumps, drop notes shorter than ~80ms.
- **Autotune:** snap each note's median pitch to the nearest semitone, or the nearest note in the detected key.
- **Playback:** Tone.js (PolySynth for synths, Sampler for sampled instruments). Preload everything at startup.
- **Commands:** vosk-browser in a Web Worker, restricted to a grammar, streaming partial results. Fire on the first partial that forms a complete command; don't wait for end-of-speech silence. No command may be a prefix of another.
- **Responses:** prerecorded voice clips (a few variants each) preloaded as AudioBuffers. No speechSynthesis (laggy, robotic). Use placeholder clips during development.
- Verify current library APIs and versions before using them.

## Command grammar (v1)
- `create player <name> playing <instrument>`
- `<name>` → select that lane
- `record` / `stop` / `play` / `again`
- `mute <name>` / `solo <name>`
- `tempo <number>`

Names come from a closed list of ~100 short names in the grammar. Instruments v1: violin, piano, bass, guitar, strings, synth.

## Command vs. singing gate
- **Pitch gate:** voiced audio below the calibrated threshold counts as command voice. Speech also has unstable pitch, while singing holds steady notes, which is a second signal.
- During recording, keep writing to the ring buffer while a possible command is spoken. On a confirmed "stop", trim the take back to where the low voice began, so the word never lands in the take.
- **Onboarding calibration:** user says a few commands in their command voice; this sets the pitch threshold.

## Loop pedal
- **First take sets loop length and tempo.** It runs from the record beep to the onset of the low "stop" voice. Estimate tempo from note onsets; round the loop to whole bars.
- **No gap after "stop".** Recognition confirms a few hundred ms late, so start playback offset into the loop by the time elapsed since the loop's end point, as if it had been looping all along.
- **Later takes:** "record" waits for the next loop start (count-in clicks in tempo), records exactly one cycle, auto-commits, and the new lane starts playing.
- **Pre-roll:** always keep the last ~2s of mic audio, so singing that starts slightly early isn't lost.

## Latency
- Compensate round-trip latency (output + input). Start from AudioContext `baseLatency`/`outputLatency`, then do a one-time calibration: play clicks and have the user clap along (or, on speaker, let the mic hear the clicks). Shift every take by the measured offset.
- Wired headphones recommended; Bluetooth adds large latency.

## UI
- Full-screen stacked horizontal lanes. Current lane lit, showing player name and instrument. Notes drawn live as they're sung, plus a playhead.
- Every recognized command gets a short sound and a visual flash.
- Clear indicator when in command mode (touch-hold or low voice).
- First screen is a single "tap to start", which unlocks the AudioContext on iOS, requests the mic and preloads assets.
- Mic access on a phone requires HTTPS: use a local HTTPS dev server or a tunnel for testing.

## Build phases
Each phase must work on a real phone before moving on.
1. **Sing to instrument.** Tap to record/stop. Live pitch → notes → autotune → replay on a synth. Notes drawn on one lane.
2. **Loop pedal.** First take sets loop and tempo, multiple lanes, auto one-cycle recording, latency calibration.
3. **Voice control.** Vosk grammar, pitch gate, touch-hold command mode, prerecorded responses, trimming "stop" out of takes.
4. **Polish.** Sampled instruments, key detection, confirmations in key, echo-cancellation tests for speaker mode.

## Later ideas (not v1)
- Whispered commands as an alternative gate
- MIDI export
- Autotuning the actual voice (pitch-shifting the recording)
- Auto-harmony
