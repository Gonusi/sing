// [engine] The loop scheduler, on the AudioContext clock (Tone Transport/Part are NOT used: double-fire/wrap bugs).
//
// Timing (all context seconds):
//   An event at loop position p, cycle k is HEARD at   heard = origin + p + k·L
//   and scheduled at                                    when  = heard − outLat      (outLat read live per tick)
// On every Tone "tick" (15 ms) each eligible track (on, has a take) schedules the half-open HEARD window
//   [track.scheduledUntil, now + LOOKAHEAD_SEC + outLat)      then scheduledUntil = that upper bound.
// Windows are half-open and contiguous, and `heard` is computed by the same formula every time, so each
// (track, event, cycle) is scheduled exactly once. The window is in the heard domain so a drifting outLat can
// never double-schedule or skip an event.
//
// Late events (when < now): note late ≤ NOTE_LATE_FULL_SEC → plays now in full; a later note whose end is still
// ahead → plays now with offset = now − when (catch-up); drum hit late ≤ DRUM_LATE_MAX_SEC → plays now;
// anything else is dropped. Iteration is bounded per event, so a stale scheduledUntil costs nothing.
// Catch-up paths, all through the same late rules:
//   - start(origin, L, from): occurrences heard ≥ from (first take: from = tDown of the stop, already past)
//   - a track switched back on: its scheduledUntil stood still while it was off
//   - an event that appears after its window passed (overdub notes become final late): its occurrences in
//     [from, track.scheduledUntil) are scheduled once, when the event is first seen.
//
// Vocal tracks (raw audio): one event per cycle, a Note {pos 0, dur L} (vocalEvent). A late vocal occurrence always
// plays with an exact offset (audio must not shift), and an occurrence that straddles activeFrom starts at activeFrom
// with offset activeFrom − heard (a vocal overdub plays from the moment its window ends, not from the next cycle).
//
// Mixing: each track gets its own GainNode (voice.output → strip gain → master + engine.fxSend), owned here.
//   gain target = running && track.on ? 1 : 0; on/off ramps over RAMP_ONOFF_SEC, stop ramps over RAMP_STOP_SEC.
import type { DrumHit, InstrumentKind, Note, ScheduledTrack, Scheduler, Sec, Voice } from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';

/** scheduling horizon beyond now (+ outLat, heard domain) */
export const LOOKAHEAD_SEC = 0.12;
/** a note this late still plays in full (started now) */
export const NOTE_LATE_FULL_SEC = 0.02;
/** a drum hit later than this is dropped */
export const DRUM_LATE_MAX_SEC = 0.03;
/** a caught-up note must have at least this much left to be worth starting */
export const MIN_CATCHUP_REMAIN_SEC = 0.03;
export const RAMP_ONOFF_SEC = 0.01;
export const RAMP_STOP_SEC = 0.02;
/** shorter loops are not scheduled at all (guards the cycle loop) */
export const MIN_LOOP_SEC = 0.01;
/** boundary slack for `from` / activeFrom / activeUntil: heard = origin + pos + k·L can land 1 ulp below `from` */
export const EDGE_EPS_SEC = 1e-6;

export interface SchedEvent {
  trackId: string;
  kind: InstrumentKind;
  pos: Sec;
  cycle: number;
  /** origin + pos + cycle·L */
  heard: Sec;
  /** heard − outLat (the ideal start) */
  when: Sec;
  /** the start actually passed to voice.play (= when, or now when late) */
  at: Sec;
  /** catch-up offset passed to voice.play */
  offset: Sec;
  outLat: Sec;
  /** for drops: why */
  reason?: string;
}

export interface TransportEvent {
  action: 'start' | 'stop' | 'resync';
  at: Sec;
  origin?: Sec;
  loopLength?: Sec;
  from?: Sec;
  /** per-track scheduledUntil (heard domain) at stop */
  scheduledUntil?: Record<string, Sec>;
}

export interface SchedulerOptions {
  onEvent?(e: SchedEvent): void;
  onDrop?(e: SchedEvent): void;
  onTransport?(e: TransportEvent): void;
}

export interface LoopScheduler extends Scheduler {
  readonly origin: Sec | null;
  readonly loopLength: Sec | null;
  /** schedule the next window now (also runs on every Tone tick) */
  tick(): void;
  /** after an interruption: skip everything whose start already passed (no burst of stale events) */
  resync(): void;
  /** the per-track gain (voice.output → this → master) */
  trackOutput(trackId: string): GainNode | null;
  /** setTracks; catchUp false = events new to a track are not caught up in the range already passed */
  setTracks(tracks: ScheduledTrack[], opts?: { catchUp?: boolean }): void;
  dispose(): void;
}

interface Strip {
  st: ScheduledTrack;
  voice: Voice;
  gain: GainNode;
  /** heard-domain end of what has been scheduled for this track */
  scheduledUntil: Sec;
  /** keys of events whose range up to scheduledUntil is covered (only grows until the next start) */
  known: Set<string>;
}

type LoopEvent = Note | DrumHit;

export function createScheduler(engine: AudioEngine, opts: SchedulerOptions = {}): LoopScheduler {
  const { ctx } = engine;
  const strips = new Map<string, Strip>();
  let running = false;
  let origin = 0;
  let L = 0;
  let from = 0;
  let lastHi = 0;

  // ---- per-track scheduling ----

  const scheduleRange = (s: Strip, lo: Sec, hi: Sec, now: Sec, ol: Sec, only?: Set<LoopEvent>) => {
    const vocal = isVocalTrack(s.st);
    const activeFrom = s.st.activeFrom ?? -Infinity;
    for (const ev of trackEvents(s.st, L)) {
      if (only && !only.has(ev)) continue;
      const drum = isDrumTrack(s.st);
      const dur = drum ? 0 : (ev as Note).dur;
      // occurrences that the late rules would drop anyway are not even enumerated (never tighter than lateDecision)
      const minHeard = now + ol - (drum ? DRUM_LATE_MAX_SEC : Math.max(dur, NOTE_LATE_FULL_SEC)) - 1e-6;
      // a vocal occurrence counts when it still overlaps activeFrom (it is started part-way, below)
      const activeLo = vocal ? activeFrom - dur : activeFrom;
      const evLo = Math.max(lo, from - EDGE_EPS_SEC, activeLo - EDGE_EPS_SEC, minHeard);
      const evHi = Math.min(hi, (s.st.activeUntil ?? Infinity) - EDGE_EPS_SEC);
      forEachOccurrence(origin, L, ev.pos, evLo, evHi, (k, heard) => {
        if (vocal && heard + dur <= activeFrom + EDGE_EPS_SEC) return;
        const skip = vocal && heard < activeFrom - EDGE_EPS_SEC ? activeFrom - heard : 0;
        const when = heard - ol;
        const d = vocal ? vocalDecision(when, dur, now, skip) : lateDecision(drum, when, dur, now);
        const e: SchedEvent = {
          trackId: s.st.track.id, kind: s.st.track.kind, pos: ev.pos, cycle: k, heard, when,
          at: d.at, offset: d.offset, outLat: ol,
        };
        if (!d.play) {
          opts.onDrop?.({ ...e, reason: d.reason });
          return;
        }
        try {
          s.voice.play(ev, d.at, d.offset > 0 ? d.offset : undefined);
        } catch (err) {
          console.error('voice.play failed', err);
        }
        opts.onEvent?.(e);
      });
    }
  };

  const tick = () => {
    if (!running || !(L >= MIN_LOOP_SEC)) return;
    const now = ctx.currentTime;
    const ol = engine.outLat();
    const hi = now + LOOKAHEAD_SEC + ol;
    for (const s of strips.values()) {
      if (!eligible(s.st) || hi <= s.scheduledUntil) continue;
      scheduleRange(s, s.scheduledUntil, hi, now, ol);
      s.scheduledUntil = hi;
    }
    lastHi = Math.max(lastHi, hi);
  };

  /** events not seen before: schedule their occurrences in the range this track already passed (catchUp false:
   *  only remember them — a re-derivation of notes that are already sounding must not start them twice) */
  const catchUpNewEvents = (s: Strip, catchUp = true) => {
    const fresh = new Set<LoopEvent>();
    for (const ev of trackEvents(s.st, L)) {
      const key = eventKey(ev);
      if (s.known.has(key)) continue;
      s.known.add(key);
      fresh.add(ev);
    }
    if (!catchUp || !running || !(L >= MIN_LOOP_SEC) || fresh.size === 0 || !eligible(s.st)) return;
    scheduleRange(s, from - EDGE_EPS_SEC, s.scheduledUntil, ctx.currentTime, engine.outLat(), fresh);
  };

  // ---- strips (per-track gain) ----

  const targetGain = (s: Strip) => (running && s.st.track.on ? 1 : 0);
  const applyGain = (s: Strip, rampSec: Sec, at = ctx.currentTime) => rampParam(s.gain.gain, targetGain(s), at, rampSec);

  const addStrip = (st: ScheduledTrack): Strip => {
    const gain = ctx.createGain();
    const s: Strip = { st, voice: st.voice, gain, scheduledUntil: running ? Math.max(from - EDGE_EPS_SEC, lastHi) : 0, known: new Set() };
    gain.gain.setValueAtTime(targetGain(s), ctx.currentTime);
    st.voice.output.connect(gain);
    gain.connect(engine.master);
    gain.connect(engine.fxSend);
    strips.set(st.track.id, s);
    return s;
  };

  const removeStrip = (s: Strip) => {
    strips.delete(s.st.track.id);
    rampParam(s.gain.gain, 0, ctx.currentTime, RAMP_ONOFF_SEC);
    setTimeout(() => {
      try {
        s.voice.output.disconnect(s.gain);
      } catch {
        /* already disconnected (voice disposed) */
      }
      s.gain.disconnect();
    }, 100);
  };

  const unsubscribeTick = engine.onTick(tick);

  return {
    get running() {
      return running;
    },
    get origin() {
      return running ? origin : null;
    },
    get loopLength() {
      return running ? L : null;
    },
    start(o, loopLength, f) {
      running = true;
      origin = o;
      L = loopLength;
      from = f;
      lastHi = f - EDGE_EPS_SEC;
      for (const s of strips.values()) {
        s.scheduledUntil = f - EDGE_EPS_SEC;
        s.known = new Set(trackEvents(s.st, loopLength).map(eventKey));
        applyGain(s, RAMP_ONOFF_SEC);
      }
      opts.onTransport?.({ action: 'start', at: ctx.currentTime, origin: o, loopLength, from: f });
      tick();
    },
    stop(at) {
      if (!running) return;
      running = false;
      const t = Math.max(at, ctx.currentTime);
      const until: Record<string, Sec> = {};
      for (const s of strips.values()) {
        until[s.st.track.id] = s.scheduledUntil;
        applyGain(s, RAMP_STOP_SEC, t);
        try {
          s.voice.stopAll(t + RAMP_STOP_SEC);
        } catch (err) {
          console.error('voice.stopAll failed', err);
        }
      }
      opts.onTransport?.({ action: 'stop', at: t, scheduledUntil: until });
    },
    pos(at) {
      if (!running || L <= 0) return null;
      return mod(Math.max(at, from) - origin, L);
    },
    setTracks(list, setOpts = {}) {
      const seen = new Set<string>();
      for (const st of list) {
        const id = st.track.id;
        seen.add(id);
        let s = strips.get(id);
        if (s && s.voice !== st.voice) {
          removeStrip(s);
          s = undefined;
        }
        if (!s) s = addStrip(st);
        const wasOn = s.st.track.on;
        s.st = st;
        if (wasOn !== st.track.on) applyGain(s, RAMP_ONOFF_SEC);
        // keys only grow until the next start(): forgetting one could schedule an occurrence twice
        catchUpNewEvents(s, setOpts.catchUp ?? true);
      }
      for (const s of [...strips.values()]) if (!seen.has(s.st.track.id)) removeStrip(s);
      tick();
    },
    tick,
    resync() {
      const now = ctx.currentTime;
      const ol = engine.outLat();
      for (const s of strips.values()) s.scheduledUntil = Math.max(s.scheduledUntil, now + ol);
      lastHi = Math.max(lastHi, now + ol);
      opts.onTransport?.({ action: 'resync', at: now });
    },
    trackOutput: (id) => strips.get(id)?.gain ?? null,
    dispose() {
      unsubscribeTick();
      for (const s of [...strips.values()]) removeStrip(s);
    },
  };
}

// ---------- pure helpers (exported for checks) ----------

export function isDrumTrack(st: ScheduledTrack): boolean {
  return st.track.kind === 'drums';
}

export function eligible(st: ScheduledTrack): boolean {
  return st.track.on && st.track.take !== null;
}

export function isVocalTrack(st: ScheduledTrack): boolean {
  return st.track.kind === 'vocals';
}

/** vocal takes: one stable event object per (take, L) so identity-based catch-up works */
const vocalEvents = new WeakMap<object, Note>();
export function vocalEvent(take: object & { id: string }, L: Sec): Note {
  const cached = vocalEvents.get(take);
  if (cached && cached.dur === L) return cached;
  const ev: Note = { pos: 0, dur: L, midi: 0, vel: 1, phrase: take.id, legatoNext: false };
  vocalEvents.set(take, ev);
  return ev;
}

export function trackEvents(st: ScheduledTrack, L: Sec): LoopEvent[] {
  const take = st.track.take;
  if (!take) return [];
  if (isVocalTrack(st)) return take.audio && L > 0 ? [vocalEvent(take, L)] : [];
  return isDrumTrack(st) ? take.hits : take.notes;
}

/** identity of an event across take updates (same position = same event; midi/phrase may change at commit) */
export function eventKey(ev: LoopEvent): string {
  return 'kind' in ev ? `h:${ev.pos.toFixed(5)}:${ev.kind}` : `n:${ev.pos.toFixed(5)}`;
}

/** calls fn(k, heard) for every heard = origin + pos + k·L inside [lo, hi) */
export function forEachOccurrence(origin: Sec, L: Sec, pos: Sec, lo: Sec, hi: Sec, fn: (k: number, heard: Sec) => void): void {
  if (!(L >= MIN_LOOP_SEC) || !(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) return;
  const at = (k: number) => origin + pos + k * L;
  let k = Math.ceil((lo - origin - pos) / L);
  while (at(k - 1) >= lo) k--;
  while (at(k) < lo) k++;
  for (; at(k) < hi; k++) fn(k, at(k));
}

export interface LateDecision {
  play: boolean;
  at: Sec;
  offset: Sec;
  reason?: string;
}

/** the late rules (see header) */
export function lateDecision(drum: boolean, when: Sec, dur: Sec, now: Sec): LateDecision {
  const late = now - when;
  if (late <= 0) return { play: true, at: when, offset: 0 };
  if (drum) return late <= DRUM_LATE_MAX_SEC ? { play: true, at: now, offset: 0 } : { play: false, at: now, offset: 0, reason: 'drum-late' };
  if (late <= NOTE_LATE_FULL_SEC) return { play: true, at: now, offset: 0 };
  if (when + dur - now > MIN_CATCHUP_REMAIN_SEC) return { play: true, at: now, offset: late };
  return { play: false, at: now, offset: 0, reason: 'note-over' };
}

/** vocals: start at when + skip (activeFrom) and never shift — a late start always skips exactly what it missed */
export function vocalDecision(when: Sec, dur: Sec, now: Sec, skip: Sec): LateDecision {
  const start = when + skip;
  const late = Math.max(0, now - start);
  const remaining = dur - skip - late;
  if (late > 0 && remaining <= MIN_CATCHUP_REMAIN_SEC) return { play: false, at: now, offset: 0, reason: 'vocal-over' };
  return { play: true, at: start + late, offset: skip + late };
}

export function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/** click-free move of `param` to `value` over `rampSec`, starting at `at` */
export function rampParam(param: AudioParam, value: number, at: Sec, rampSec: Sec): void {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(at);
  } else {
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
  }
  param.linearRampToValueAtTime(value, at + rampSec);
}
