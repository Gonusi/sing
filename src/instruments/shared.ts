// [instruments] Helpers every voice uses: the context type, pitch/velocity maths, note timing (catch-up),
// and the stopAll gate. Plain Web Audio, no Tone.
import type { DrumHit, Note, Sec } from '../types.ts';

/** Every factory takes this: a live AudioContext in the app, an OfflineAudioContext in dev checks. */
export type Ctx = BaseAudioContext;

export function isNote(ev: Note | DrumHit): ev is Note {
  return 'midi' in ev;
}

/** MIDI note number → Hz (A4 = 440 Hz). Fractional MIDI is fine. */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Gain at vel 0, so soft singing stays audible (≈ −9 dB below vel 1). */
export const VEL_FLOOR = 0.35;

/** Note/hit velocity 0..1 → linear gain VEL_FLOOR..1. */
export function velGain(vel: number): number {
  const v = Math.min(1, Math.max(0, Number.isFinite(vel) ? vel : 0.7));
  return VEL_FLOOR + (1 - VEL_FLOOR) * v;
}

/** Shortest sound a note gets (a catch-up remainder or a tiny `dur`). */
export const MIN_NOTE_DUR: Sec = 0.03;

/** When a note sounds, in context time, after catch-up. */
export interface NoteSpan {
  /** context time the sound starts (`when`; may be a few ms in the past) */
  start: Sec;
  /** context time the note ends: start + (dur − skipped) */
  end: Sec;
  /** seconds of the note already missed (catch-up `offset`), ≥ 0 */
  skipped: Sec;
}

export function noteSpan(note: Note, when: Sec, offset = 0): NoteSpan {
  const skipped = Math.max(0, offset);
  return { start: when, end: when + Math.max(MIN_NOTE_DUR, note.dur - skipped), skipped };
}

// ---------- stopAll gate ----------

/** Gate fade-out time constant on stopAll; after KILL_TIME the level is e^(−6) ≈ −52 dB. */
export const KILL_TAU: Sec = 0.004;
/** stopAll(at) is silent by at + KILL_TIME (contract: ≤ 30 ms); sources may be cut from then on. */
export const KILL_TIME: Sec = 0.025;
/** Gate fade-in time constant when the next note reopens it (no click from leftover reverb tails). */
const GATE_OPEN_TAU: Sec = 0.003;

/**
 * A GainNode every voice puts just before its output. stopAll closes it (fast fade); the next attack reopens it.
 * It only ever gets setValueAtTime/setTargetAtTime, so cancelling its future events never cuts a ramp.
 */
export interface Gate {
  readonly node: GainNode;
  /** fade to silence from `at` (clamped to now); stays closed until open() */
  close(at: Sec): void;
  /** reopen at `at` (not before the close fade finished); no-op when already open */
  open(at: Sec): void;
}

export function createGate(ctx: Ctx): Gate {
  const node = ctx.createGain();
  let closed = false;
  let closedUntil = -Infinity;
  return {
    node,
    close(at) {
      const t = Math.max(at, ctx.currentTime);
      node.gain.cancelScheduledValues(t);
      node.gain.setTargetAtTime(0, t, KILL_TAU);
      node.gain.setValueAtTime(0, t + KILL_TIME);
      closed = true;
      closedUntil = t + KILL_TIME;
    },
    open(at) {
      if (!closed) return;
      const t = Math.max(at, closedUntil, ctx.currentTime);
      node.gain.setTargetAtTime(1, t, GATE_OPEN_TAU);
      closed = false;
    },
  };
}

/** A fixed-level native GainNode: the voice's `output` (the engine automates its own per-track gain after it). */
export function createOutput(ctx: Ctx, level: number): GainNode {
  const out = ctx.createGain();
  out.gain.value = level;
  return out;
}
