// [instruments] Legato phrase lifecycle shared by the violin and bass voices: one attack per phrase, legato moves
// inside it, one release at its end. This file owns each phrase's envelope GainNode; the instrument supplies the
// sound (PhraseSound: sources, pitch glides, sample switches).
//
// INVARIANT — every phrase is in exactly one state:
//   OPEN    its last note had legatoNext. A provisional release is scheduled at `releaseAt` = note end + LEGATO_GRACE
//           (envelope setTarget → 0 there, sources stop at releaseAt + tail), so a phrase whose next note never comes
//           (track switched off, lane re-recorded, note dropped) still ends. A continuation (same phrase id) cancels
//           and re-schedules it, but only while now + CANCEL_SAFETY < releaseAt, i.e. before any of it has rendered.
//           At most one phrase per voice is OPEN.
//   CLOSED  its release is final (last note of the phrase, superseded by another phrase, provisional release passed,
//           or stopAll). It is never continued; it is disconnected once its sources have stopped.
// Envelope automation uses only setValueAtTime/setTargetAtTime, so cancelScheduledValues(t) for a future t removes
// exactly the pending release and never cuts a ramp in progress (a cancelled linear ramp would jump → click).
// Source stop() is re-issued on a continuation: the Web Audio spec applies the last call (checked in Chromium and
// WebKit, dev/instruments/check.ts).
import type { Note, Sec } from '../types.ts';
import { earliestStart, KILL_TAU, KILL_TIME, noteSpan, velGain, type Ctx, type Gate, type NoteSpan } from './shared.ts';

/** An open phrase releases on its own this long after its last note ends if no continuation arrived. */
export const LEGATO_GRACE: Sec = 0.3;
/** A continuation must be handed over at least this long before the provisional release would start. */
const CANCEL_SAFETY: Sec = 0.05;
/** The release lasts this many release time constants (e^−7 ≈ −61 dB), then the sources stop. */
const RELEASE_TAU_COUNT = 7;
/** Disconnect a closed phrase this long after its sources stopped. */
const REAP_MARGIN: Sec = 0.1;
/** Portato: a repeated pitch inside a phrase dips this long before its start, with this time constant. */
const REPEAT_DIP_LEAD: Sec = 0.04;
const REPEAT_DIP_TAU: Sec = 0.012;

export interface PhraseEnvelope {
  /** attack time constant (≈ 95 % after 3 τ) */
  attackTau: Sec;
  /** level the attack settles to, as a fraction of the velocity gain (1 = no decay) */
  sustain: number;
  /** delay after the phrase start before the decay towards `sustain` begins */
  decayDelay: Sec;
  decayTau: Sec;
  /** time constant of the level change at a legato note (the gain follows each note's vel) */
  velTau: Sec;
  /** release time constant */
  releaseTau: Sec;
  /**
   * Portato for a repeated pitch inside a phrase (two legato notes on the same pitch would otherwise merge into one
   * tone and lose the rhythm): the level dips to this fraction just before the repeat, then returns. 1 = no dip.
   * Keep it at 0.5 or above (a deeper dip reads as a gap).
   */
  repeatDip: number;
}

/** The instrument-specific sound of one phrase, playing into the phrase envelope. */
export interface PhraseSound {
  /** move to the next note of the phrase at span.start — glide, maybe crossfade samples — with no new attack */
  legato(note: Note, span: NoteSpan): void;
  /** (re)schedule the stop of every live source; the last call wins */
  stopAt(at: Sec): void;
  /** free every node (after the stop time has passed, or on dispose) */
  disconnect(): void;
}

export interface PhraseVoiceOptions {
  ctx: Ctx;
  /** every phrase envelope connects here */
  destination: AudioNode;
  /** the voice's stopAll gate: closed by stopAll, reopened by the next phrase start */
  gate: Gate;
  envelope: PhraseEnvelope;
  /** start the sound of a new phrase (its first note) into `env` */
  start(note: Note, span: NoteSpan, env: GainNode): PhraseSound;
}

export interface PhraseVoice {
  play(note: Note, when: Sec, offset?: Sec): void;
  stopAll(at: Sec): void;
  dispose(): void;
}

interface Phrase {
  id: string;
  /** pitch of its latest note (a same-pitch continuation gets the portato dip) */
  midi: number;
  env: GainNode;
  sound: PhraseSound;
  /** OPEN: the provisional release time; CLOSED: the final release time */
  releaseAt: Sec;
  /** when every source stops (releaseAt + release tail) */
  stopAt: Sec;
}

export function createPhraseVoice(o: PhraseVoiceOptions): PhraseVoice {
  const { ctx, envelope: e } = o;
  const releaseTail = RELEASE_TAU_COUNT * e.releaseTau;
  let open: Phrase | null = null;
  const closed = new Set<Phrase>();

  const canContinue = (p: Phrase, now: Sec) => now + CANCEL_SAFETY < p.releaseAt;

  function scheduleRelease(p: Phrase, at: Sec): void {
    p.releaseAt = at;
    p.stopAt = at + releaseTail;
    p.env.gain.setTargetAtTime(0, at, e.releaseTau);
    p.sound.stopAt(p.stopAt);
  }

  /** remove the pending (still future) release; the caller schedules a new one right after */
  function cancelRelease(p: Phrase): void {
    p.env.gain.cancelScheduledValues(p.releaseAt);
  }

  function startPhrase(note: Note, span: NoteSpan): Phrase {
    o.gate.open(span.start);
    const env = ctx.createGain();
    env.gain.value = 0; // the intrinsic value: what the param falls back to if every event were cancelled
    env.connect(o.destination);
    const peak = velGain(note.vel);
    env.gain.setValueAtTime(0, span.start);
    env.gain.setTargetAtTime(peak, span.start, e.attackTau);
    if (e.sustain < 1) env.gain.setTargetAtTime(peak * e.sustain, span.start + e.decayDelay, e.decayTau);
    const sound = o.start(note, span, env);
    return { id: note.phrase, midi: note.midi, env, sound, releaseAt: Infinity, stopAt: Infinity };
  }

  /** the OPEN phrase is abandoned (another phrase starts at `at`): release it no later than `at` */
  function abandon(p: Phrase, at: Sec, now: Sec): void {
    if (canContinue(p, now) && at < p.releaseAt) {
      cancelRelease(p);
      scheduleRelease(p, Math.max(at, now));
    }
    closed.add(p);
  }

  function reap(now: Sec): void {
    for (const p of closed) {
      if (p.stopAt + REAP_MARGIN >= now) continue;
      p.sound.disconnect();
      p.env.disconnect();
      closed.delete(p);
    }
  }

  return {
    play(note, when, offset = 0) {
      const now = ctx.currentTime;
      reap(now);
      const span = noteSpan(ctx, note, when, offset);
      let p: Phrase;
      if (open && open.id === note.phrase && canContinue(open, now)) {
        p = open;
        cancelRelease(p);
        if (note.midi === p.midi && e.repeatDip < 1) {
          const dipAt = Math.max(span.start - REPEAT_DIP_LEAD, earliestStart(ctx, now));
          p.env.gain.setTargetAtTime(velGain(note.vel) * e.sustain * e.repeatDip, dipAt, REPEAT_DIP_TAU);
        }
        p.env.gain.setTargetAtTime(velGain(note.vel) * e.sustain, span.start, e.velTau);
        p.sound.legato(note, span);
        p.midi = note.midi;
      } else {
        if (open) abandon(open, span.start, now);
        p = startPhrase(note, span);
      }
      open = null;
      if (note.legatoNext) {
        scheduleRelease(p, span.end + LEGATO_GRACE);
        open = p;
      } else {
        scheduleRelease(p, span.end);
        closed.add(p);
      }
    },

    stopAll(at) {
      const t = Math.max(at, ctx.currentTime);
      o.gate.close(t);
      if (open) closed.add(open);
      open = null;
      for (const p of closed) {
        p.env.gain.cancelScheduledValues(t);
        p.env.gain.setTargetAtTime(0, t, KILL_TAU);
        if (p.stopAt > t + KILL_TIME) {
          p.releaseAt = t;
          p.stopAt = t + KILL_TIME;
          p.sound.stopAt(p.stopAt);
        }
      }
    },

    dispose() {
      if (open) closed.add(open);
      open = null;
      const now = ctx.currentTime;
      for (const p of closed) {
        p.sound.stopAt(now);
        p.sound.disconnect();
        p.env.disconnect();
      }
      closed.clear();
    },
  };
}
