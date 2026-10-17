// [engine] The state machine (idle → recordingFirst → playing ⇄ overdubbing, stopped) and the timing model.
// See PLAN.md "State machine" and "Timing model". Owns voices (one per track), the scheduler and take recording.
//
// State table as implemented (s = state at tDown, read from a short state history; every action uses tDown):
// | s              | input                  | result                                                              |
// |----------------|------------------------|---------------------------------------------------------------------|
// | idle           | tap / record           | recordingFirst: t0 = tDown, into the selected empty lane (else the  |
// |                |                        | first empty lane, else a new synth lane); start beep                |
// |                | undo                   | pop the undo stack (stays idle unless the snapshot has a loop)       |
// | recordingFirst | tap / stop             | L = tDown − t0; L < 1 s → discard → idle; else commit → playing      |
// |                |                        | (scheduler.start(origin = t0, L, from = tDown): catch-up)            |
// |                | auto at t0 + 60 s      | as stop with tDown = t0 + 60                                        |
// |                | undo                   | discard the take → idle                                             |
// |                | any other held command | applied; the take continues; audio from the hold's tDown to its      |
// |                |                        | release is dropped from the take                                     |
// | playing        | tap / record           | overdubbing: ts = tDown, into the selected lane if empty, else a new |
// |                |                        | lane of the same kind; pending notes play from ts + L               |
// |                | stop                   | stopped                                                             |
// |                | undo                   | pop the undo stack (no loop left → idle)                            |
// | overdubbing    | window end             | commit → playing (at ts + L + inLat + COMMIT_MARGIN_SEC)            |
// |                | tap                    | commit what was sung so far → playing                               |
// |                | stop                   | commit so far → stopped                                             |
// |                | undo                   | discard → playing (already committed at window end → undo it)       |
// |                | create / record        | error blip, nothing else                                            |
// | stopped        | tap / play             | playing (origin = now + outLat + START_LEAD_SEC, so pos 0 is whole)  |
// |                | record                 | playing + overdubbing with ts = origin                              |
// |                | undo                   | pop the undo stack (no loop left → idle)                            |
// | any but overd. | create X               | add + select an empty X lane (undoable)                             |
// | any            | toggle X on/off        | every X lane on/off (not undoable)                                  |
// Ignored (logged): play/stop in idle, record/play in recordingFirst, play in playing/overdubbing, stop in stopped.
import type {
  AppState, Command, Controller, DeviceSettings, Gesture, InstrumentKind, LogEvent, ScheduledTrack, Sec, Session, Take, Track,
  View, Voice,
} from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';
import { wavBlob } from '../audio/wav-encode.ts';
import { createScheduler, type LoopScheduler } from '../loop/clock.ts';
import { FIRST_TAKE_DISPLAY_MIN_SEC, createTakeRecorder, type Analysis, type TakeRecorder } from '../loop/take.ts';
import { createAudioStore, referencedAudio } from '../audio/audio-store.ts';
import { createVocalVoice } from '../audio/vocal-voice.ts';
import { createSessionStore, emptySession, loadSession, saveDevice, type SessionStore } from './session.ts';
import { createVoice as createInstrumentVoice } from '../instruments/index.ts';
import { playBlip } from '../instruments/blip.ts';

export interface ControllerDeps {
  engine: AudioEngine;
  mic: Mic;
  device: DeviceSettings;
  /** ?test mode: no persistence side effects beyond normal, logs kept in memory */
  test: boolean;
  // ---- engine extensions (main.ts passes none of these) ----
  /** replace parts of src/analysis (dev checks inject a fake detector) */
  analysis?: Partial<Analysis>;
  /** replace the instrument voice factory */
  createVoice?: (kind: InstrumentKind, ctx: AudioContext) => Voice;
  /** load the stored session at boot (default true) */
  restore?: boolean;
  /** save sessions to IndexedDB (default true) */
  persist?: boolean;
}

export interface EngineController extends Controller {
  /** accepted (true) or ignored/refused (false) — lets the caller choose the ok/err blip */
  command(c: Command, tDown: Sec): boolean;
  /** the in-memory log (last LOG_MAX events) */
  logs(): LogEvent[];
  /** write the pending session save now */
  flush(): Promise<void>;
  readonly scheduler: LoopScheduler;
  /** decoded loop audio of a vocal track (null when none / not loaded) */
  vocalAudio(trackId: string): AudioBuffer | null;
  dispose(): void;
}

export const MIN_FIRST_TAKE_SEC = 1;
export const MAX_FIRST_TAKE_SEC = 60;
/** overdub commit waits for the last audio (inLat) plus analysis finalisation */
export const COMMIT_MARGIN_SEC = 0.15;
/** vocal overdubs need only the 20 ms seam tail + one block: commit sooner, so less of the first replay is missed */
export const VOCAL_COMMIT_MARGIN_SEC = 0.05;
/** echo amount for a session that has none saved (?test: 0, so existing expectations hold) */
export const DEFAULT_ECHO = 0.2;
/** stopped → play: pos 0 is scheduled this long after now, so nothing starts late */
export const START_LEAD_SEC = 0.03;
const BEEP_HZ = 1320;
const BEEP_SEC = 0.04;
const BEEP_LEVEL = 0.25;
/**
 * drum takes only: corrected-time span after the beep is heard that is dropped (on speakers the mic hears it and
 * the onset detector would make a hit of it). Melodic takes keep it: the beep is shorter than any note.
 */
const BEEP_EXCLUDE_SEC = 0.08;
export const LOG_MAX = 2000;
const STATE_HISTORY_MAX = 64;
const HOLDS_MAX = 16;

/** a tap means a different input per state (TAP_MEANS); 'commit' = tap while overdubbing */
type Input = 'tap' | 'commit' | Command['type'];

interface ActiveTake {
  rec: TakeRecorder;
  trackId: string;
  mode: 'first' | 'overdub';
  /** t0 (first) or ts (overdub), corrected time */
  start: Sec;
  /** the lane was created for this take (discard / undo removes it) */
  createdLane: boolean;
  prevSelected: string | null;
  /** tDowns of holds whose exclusion is open in this take */
  holdExclusions: Set<Sec>;
  off: () => void;
}

interface Hold {
  tUp: Sec | null;
}

export async function createController(deps: ControllerDeps): Promise<EngineController> {
  const { engine, mic } = deps;
  const { ctx } = engine;
  const makeVoice = deps.createVoice ?? createInstrumentVoice;
  let device: DeviceSettings = { ...deps.device };
  // until calibrated, the browser's own input-latency report (when it gives one) beats the 10 ms guess
  const reported = mic.reportedLatency();
  if (!device.calibrated && reported !== null) device = { ...device, inLat: reported };

  // ---- log ----
  const logBuf: LogEvent[] = [];
  const logSubs = new Set<(e: LogEvent) => void>();
  const log = (type: string, data?: Record<string, unknown>) => {
    const e: LogEvent = { t: ctx.currentTime, type, data };
    logBuf.push(e);
    if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
    for (const cb of [...logSubs]) {
      try {
        cb(e);
      } catch (err) {
        console.error('log subscriber failed', err);
      }
    }
  };

  // ---- change notification (batched per microtask) ----
  const changeSubs = new Set<() => void>();
  let changePending = false;
  const changed = () => {
    if (changePending) return;
    changePending = true;
    queueMicrotask(() => {
      changePending = false;
      for (const cb of [...changeSubs]) {
        try {
          cb();
        } catch (err) {
          console.error('change subscriber failed', err);
        }
      }
    });
  };

  // ---- session, state ----
  const restored = deps.restore === false ? null : await loadSession();
  const store: SessionStore = createSessionStore(restored ?? emptySession(), { persist: deps.persist ?? true });
  // vocal audio: load what the session references before voices sync; drop stored audio nothing references
  const audio = createAudioStore(ctx, { persist: deps.persist ?? true });
  await audio.loadAll(referencedAudio(store.sessions()));
  const gcAudio = () => void audio.gc(referencedAudio(store.sessions()));
  gcAudio();
  const echoOf = (sess: Session) => sess.fx?.echo ?? (deps.test ? 0 : DEFAULT_ECHO);
  engine.setEcho(echoOf(store.current));
  let state: AppState = store.current.loopLength !== null ? 'stopped' : 'idle';
  const history: { t: Sec; state: AppState }[] = [{ t: -Infinity, state }];
  let take: ActiveTake | null = null;
  let lastRec: TakeRecorder | null = null;
  /** the last overdub committed, so a command read against 'overdubbing' at its tDown can still undo it */
  let lastCommit: { trackId: string; from: Sec; to: Sec; session: Session } | null = null;
  const holds = new Map<Sec, Hold>();
  const voices = new Map<string, Voice>();
  const activeFrom = new Map<string, Sec>();

  const setState = (next: AppState, at: Sec) => {
    if (next === state) return;
    log('state', { from: state, to: next, at });
    state = next;
    const t = Math.max(at, history[history.length - 1].t);
    history.push({ t, state: next });
    if (history.length > STATE_HISTORY_MAX) history.splice(0, history.length - STATE_HISTORY_MAX);
    changed();
  };
  const stateAt = (t: Sec): AppState => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i].t <= t) return history[i].state;
    return history[0].state;
  };

  // ---- scheduler ----
  const scheduler = createScheduler(engine, {
    onEvent: (e) => log('sched', { ...e }),
    onDrop: (e) => log('drop', { ...e }),
    onTransport: (e) => log('transport', { ...e }),
  });

  // ---- voices + scheduled tracks ----
  const silentVoice = (kind: InstrumentKind): Voice => {
    const output = ctx.createGain();
    return { kind, output, play: () => {}, stopAll: () => {}, dispose: () => output.disconnect() };
  };
  const vocalBufferOf = (trackId: string) => () => {
    const key = store.current.tracks.find((t) => t.id === trackId)?.take?.audio?.key;
    return key ? audio.buffer(key) : null;
  };
  const syncVoices = () => {
    const ids = new Set(store.current.tracks.map((t) => t.id));
    for (const t of store.current.tracks) {
      if (voices.has(t.id)) continue;
      let v: Voice;
      try {
        v = t.kind === 'vocals' ? createVocalVoice(ctx, vocalBufferOf(t.id)) : makeVoice(t.kind, ctx);
      } catch (e) {
        log('error', { where: 'createVoice', kind: t.kind, message: String(e) });
        v = silentVoice(t.kind);
      }
      voices.set(t.id, v);
    }
    pushTracks();
    for (const [id, v] of [...voices]) {
      if (ids.has(id)) continue;
      voices.delete(id);
      activeFrom.delete(id);
      try {
        v.dispose();
      } catch (e) {
        console.error('voice.dispose failed', e);
      }
    }
  };
  const pushTracks = () => {
    const list: ScheduledTrack[] = [];
    for (const t of store.current.tracks) {
      const voice = voices.get(t.id);
      if (!voice) continue;
      const pending = take?.mode === 'overdub' && take.trackId === t.id ? take.rec.pendingTake() : null;
      list.push({ track: pending ? { ...t, take: pending } : t, voice, activeFrom: activeFrom.get(t.id) });
    }
    scheduler.setTracks(list);
  };
  const commitSession = (next: Session, undoPoint?: Session) => {
    store.set(next, undoPoint);
    syncVoices();
    changed();
    if (undoPoint) gcAudio(); // the undo stack may have dropped its oldest snapshot
  };
  /** a vocal take's audio goes into the cache (synchronously) and IndexedDB before the session references it */
  const keepVocalAudio = (rec: TakeRecorder, result: Take) => {
    const pcm = rec.loopAudio();
    if (result.audio && pcm) void audio.put(result.audio.key, pcm, result.audio.sampleRate);
  };

  // ---- small audio helpers ----
  const errorBlip = (why: string) => {
    log('error', { message: why });
    try {
      playBlip(ctx, 'err', undefined, engine.master);
    } catch (e) {
      console.error('blip failed', e);
    }
  };
  const playBeep = (at: Sec) => {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(BEEP_HZ, at);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(BEEP_LEVEL, at + 0.003);
    g.gain.setValueAtTime(BEEP_LEVEL, at + BEEP_SEC - 0.01);
    g.gain.linearRampToValueAtTime(0, at + BEEP_SEC);
    osc.connect(g).connect(engine.master);
    osc.start(at);
    osc.stop(at + BEEP_SEC + 0.01);
    osc.onended = () => g.disconnect();
  };

  // ---- takes ----
  const newTake = (lane: Track, window: Parameters<typeof createTakeRecorder>[0]['window'], createdLane: boolean, prevSelected: string | null, tDown: Sec): ActiveTake => {
    const rec = createTakeRecorder({ mic, kind: lane.kind, takeId: newId('k'), inLat: device.inLat, window, analysis: deps.analysis });
    const t: ActiveTake = {
      rec, trackId: lane.id, mode: window.type, start: window.type === 'first' ? window.t0 : window.ts,
      createdLane, prevSelected, holdExclusions: new Set(), off: () => {},
    };
    t.off = rec.onUpdate(() => {
      if (t.mode === 'overdub' && take === t) pushTracks();
      changed();
    });
    // a take started by a held command: the speech after tDown is not part of it
    const hold = holds.get(tDown);
    if (hold) {
      rec.beginExclusion(tDown);
      if (hold.tUp !== null) rec.endExclusion(hold.tUp);
      else t.holdExclusions.add(tDown);
    }
    log('take', { phase: 'start', mode: t.mode, trackId: lane.id, kind: lane.kind, takeId: rec.takeId, start: t.start, inLat: rec.inLat });
    return t;
  };
  const endTake = (t: ActiveTake) => {
    t.off();
    lastRec = t.rec;
    if (take === t) take = null;
  };

  const startFirstTake = (tDown: Sec): boolean => {
    const before = store.current;
    let lane = before.tracks.find((t) => t.id === before.selectedId && !t.take) ?? before.tracks.find((t) => !t.take);
    let s = before;
    const created = !lane;
    if (!lane) {
      lane = newTrack('synth');
      s = { ...s, tracks: [...s.tracks, lane] };
    }
    commitSession({ ...s, selectedId: lane.id });
    take = newTake(lane, { type: 'first', t0: tDown }, created, before.selectedId, tDown);
    const beepAt = ctx.currentTime;
    playBeep(beepAt);
    const beepHeard = beepAt + engine.outLat();
    if ((lane.kind === 'drums' || lane.kind === 'vocals') && beepHeard >= tDown) take.rec.addExclusion({ from: beepHeard, to: beepHeard + BEEP_EXCLUDE_SEC });
    setState('recordingFirst', tDown);
    return true;
  };

  const finishFirstTake = (end: Sec): boolean => {
    const t = take;
    if (!t || t.mode !== 'first') return false;
    const L = end - t.start;
    if (L < MIN_FIRST_TAKE_SEC) {
      discardTake('too-short', { L });
      setState('idle', end);
      return true;
    }
    const result = t.rec.finish(end);
    endTake(t);
    keepVocalAudio(t.rec, result);
    const cur = store.current;
    const undoPoint = t.createdLane ? removeTrack(cur, t.trackId, t.prevSelected) : cur;
    commitSession({ ...cur, loopLength: L, tracks: withTake(cur.tracks, t.trackId, result) }, undoPoint);
    log('take', { phase: 'commit', mode: 'first', trackId: t.trackId, takeId: result.id, L, t0: t.start, end, notes: result.notes.length, hits: result.hits.length });
    scheduler.start(t.start, L, end);
    setState('playing', end);
    return true;
  };

  const startOverdub = (ts: Sec, tDown: Sec): boolean => {
    const L = store.current.loopLength;
    const origin = scheduler.origin;
    if (L === null || origin === null || take) return false;
    const before = store.current;
    const sel = before.tracks.find((t) => t.id === before.selectedId) ?? before.tracks[0] ?? null;
    let lane: Track;
    let s = before;
    const created = !sel || sel.take !== null;
    if (sel && !sel.take) {
      lane = sel;
    } else {
      lane = newTrack(sel?.kind ?? 'synth');
      s = { ...s, tracks: [...s.tracks, lane] };
    }
    activeFrom.set(lane.id, ts + L);
    take = newTake(lane, { type: 'overdub', origin, loopLength: L, ts }, created, before.selectedId, tDown);
    commitSession({ ...s, selectedId: lane.id });
    // stamped at the command's tDown, not at ts: from stopped, ts = origin is in the future, and a command between
    // tDown and origin must still be read as overdubbing (else undo would pop the first take)
    setState('overdubbing', tDown);
    return true;
  };

  /** commit the overdub with its window ending at `end`; an empty take is discarded */
  const commitOverdub = (end: Sec): boolean => {
    const t = take;
    if (!t || t.mode !== 'overdub') return false;
    const result = t.rec.finish(end);
    endTake(t);
    keepVocalAudio(t.rec, result);
    if (result.notes.length + result.hits.length === 0 && !result.audio) {
      log('take', { phase: 'discard', reason: 'empty', trackId: t.trackId });
      if (t.createdLane) commitSession(removeTrack(store.current, t.trackId, t.prevSelected));
      else pushTracks();
      return true;
    }
    const cur = store.current;
    const undoPoint = t.createdLane ? removeTrack(cur, t.trackId, t.prevSelected) : cur;
    const next = { ...cur, tracks: withTake(cur.tracks, t.trackId, result) };
    commitSession(next, undoPoint);
    lastCommit = { trackId: t.trackId, from: t.start, to: end, session: next };
    log('take', { phase: 'commit', mode: 'overdub', trackId: t.trackId, takeId: result.id, ts: t.start, end, notes: result.notes.length, hits: result.hits.length });
    return true;
  };

  const discardTake = (reason = 'discarded', extra: Record<string, unknown> = {}) => {
    const t = take;
    if (!t) return;
    t.rec.discard();
    endTake(t);
    log('take', { phase: 'discard', reason, trackId: t.trackId, mode: t.mode, ...extra });
    if (t.createdLane) commitSession(removeTrack(store.current, t.trackId, t.prevSelected));
    else {
      activeFrom.delete(t.trackId);
      pushTracks();
      changed();
    }
  };

  // ---- playback ----
  const startPlayback = (): Sec | null => {
    const L = store.current.loopLength;
    if (L === null) return null;
    // one read of the clock for the logged numbers: currentTime can advance by a quantum within a task
    const now = ctx.currentTime;
    const outLat = engine.outLat();
    const origin = now + outLat + START_LEAD_SEC;
    log('play', { now, outLat, origin });
    activeFrom.clear();
    pushTracks();
    scheduler.start(origin, L, origin);
    return origin;
  };
  const stopPlayback = () => {
    scheduler.stop(ctx.currentTime);
    activeFrom.clear();
  };

  // ---- undo ----
  const popUndo = (at: Sec): boolean => {
    const fx = store.current.fx;
    const popped = store.undo();
    if (!popped) {
      log('undo', { empty: true });
      return false;
    }
    // echo is not an undo step: keep the current setting on the restored snapshot
    const prev = fx ? { ...popped, fx } : popped;
    if (prev !== popped) store.set(prev);
    gcAudio();
    syncVoices();
    changed();
    log('undo', { tracks: prev.tracks.length, loopLength: prev.loopLength });
    if (prev.loopLength === null) {
      if (scheduler.running) stopPlayback();
      setState('idle', at);
    } else if (state === 'idle') {
      setState('stopped', at);
    }
    return true;
  };

  // ---- session edits (no audio) ----
  const createLane = (kind: InstrumentKind): boolean => {
    const before = store.current;
    const lane = newTrack(kind);
    commitSession({ ...before, tracks: [...before.tracks, lane], selectedId: lane.id }, before);
    return true;
  };
  const setTrackOn = (pred: (t: Track) => boolean, on: (t: Track) => boolean) => {
    const cur = store.current;
    commitSession({ ...cur, tracks: cur.tracks.map((t) => (pred(t) ? { ...t, on: on(t) } : t)) });
  };

  // ---- the table ----
  const act = (input: Input, s: AppState, tDown: Sec, c?: Command): boolean => {
    switch (input) {
      case 'tap':
        return act(TAP_MEANS[s], s, tDown);
      case 'record':
        if (s === 'idle') return startFirstTake(tDown);
        if (s === 'playing') return state === 'playing' && startOverdub(tDown, tDown);
        if (s === 'overdubbing') {
          errorBlip('record while overdubbing');
          return false;
        }
        if (s === 'stopped') {
          const origin = startPlayback();
          if (origin === null) return false;
          setState('playing', tDown);
          return startOverdub(origin, tDown);
        }
        return false;
      case 'stop':
        if (s === 'recordingFirst') return finishFirstTake(tDown);
        if (s === 'playing' || s === 'overdubbing') {
          if (state !== 'playing' && state !== 'overdubbing') return false;
          if (take?.mode === 'overdub') commitOverdub(Math.max(tDown, take.start));
          stopPlayback();
          setState('stopped', tDown);
          return true;
        }
        return false;
      case 'play':
        if (s !== 'stopped' || state !== 'stopped') return false;
        if (startPlayback() === null) return false;
        setState('playing', tDown);
        return true;
      case 'undo':
        if (s === 'recordingFirst') {
          if (take?.mode !== 'first') return false;
          discardTake();
          setState('idle', tDown);
          return true;
        }
        if (s === 'overdubbing') return undoOverdub(tDown);
        return popUndo(tDown);
      case 'create':
        if (s === 'overdubbing') {
          errorBlip('create while overdubbing');
          return false;
        }
        return c?.type === 'create' ? createLane(c.kind) : false;
      case 'toggle':
        if (c?.type !== 'toggle') return false;
        setTrackOn((t) => t.kind === c.kind, () => c.on);
        return true;
      case 'commit':
        if (take?.mode !== 'overdub') return false;
        commitOverdub(Math.max(tDown, take.start));
        if (state === 'overdubbing') setState('playing', tDown);
        return true;
    }
  };

  /** undo read against 'overdubbing': discard the pending take, or undo it if it was committed meanwhile */
  const undoOverdub = (tDown: Sec): boolean => {
    if (take?.mode === 'overdub') {
      discardTake();
      if (state === 'overdubbing') setState('playing', tDown);
      return true;
    }
    if (lastCommit && tDown >= lastCommit.from && tDown <= lastCommit.to + COMMIT_MARGIN_SEC + 1 && store.current === lastCommit.session) {
      lastCommit = null;
      return popUndo(tDown);
    }
    return false;
  };

  // ---- tick: window-end commit, first-take auto-stop ----
  const offTick = engine.onTick(() => {
    const t = take;
    if (!t) return;
    const now = ctx.currentTime;
    if (t.mode === 'first' && now - t.start >= MAX_FIRST_TAKE_SEC) {
      log('take', { phase: 'auto-stop' });
      finishFirstTake(t.start + MAX_FIRST_TAKE_SEC);
      return;
    }
    if (t.mode === 'overdub') {
      const L = store.current.loopLength ?? 0;
      const end = t.start + L;
      const margin = store.current.tracks.find((x) => x.id === t.trackId)?.kind === 'vocals' ? VOCAL_COMMIT_MARGIN_SEC : COMMIT_MARGIN_SEC;
      if (now >= end + t.rec.inLat + margin) {
        commitOverdub(end);
        if (state === 'overdubbing') setState('playing', end);
      }
    }
  });
  const offLife = engine.onLifecycle((e) => {
    log('lifecycle', { event: e });
    if (e === 'resumed') scheduler.resync();
  });

  // ---- boot ----
  syncVoices();
  log('boot', { state, tracks: store.current.tracks.length, loopLength: store.current.loopLength, restored: restored !== null });

  return {
    get state() {
      return state;
    },
    get session() {
      return store.current;
    },
    get device() {
      return device;
    },
    scheduler,
    setEcho(amount) {
      const a = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
      engine.setEcho(a);
      const cur = store.current;
      if (cur.fx?.echo === a) return;
      store.set({ ...cur, fx: { echo: a } }); // no undo point
      log('echo', { amount: a });
      changed();
    },
    vocalAudio(trackId) {
      return vocalBufferOf(trackId)();
    },
    view(): View {
      const now = ctx.currentTime;
      const t = take;
      const L = store.current.loopLength ?? 0;
      return {
        state,
        session: store.current,
        recordingTrackId: t?.trackId ?? null,
        liveNotes: t ? t.rec.liveNotes() : [],
        livePeaks: t ? t.rec.livePeaks(Math.max(now - t.start, FIRST_TAKE_DISPLAY_MIN_SEC)) : null,
        liveHits: t ? t.rec.liveHits() : [],
        openNote: t ? t.rec.openNote() : null,
        loopPos: scheduler.pos(now),
        elapsed: !t ? null : t.mode === 'first' ? Math.max(0, now - t.start) : Math.max(0, t.start + L - now),
      };
    },
    gesture(g: Gesture) {
      log('gesture', { ...g });
      switch (g.type) {
        case 'tap': {
          const s = stateAt(g.tDown);
          act('tap', s, g.tDown);
          return;
        }
        case 'holdStart':
          holds.set(g.tDown, { tUp: null });
          if (holds.size > HOLDS_MAX) holds.delete(holds.keys().next().value as Sec);
          if (take) {
            take.rec.beginExclusion(g.tDown);
            take.holdExclusions.add(g.tDown);
          }
          return;
        case 'holdEnd': {
          const h = holds.get(g.tDown) ?? { tUp: null };
          h.tUp = g.tUp;
          holds.set(g.tDown, h);
          if (take?.holdExclusions.has(g.tDown)) {
            take.rec.endExclusion(g.tUp);
            take.holdExclusions.delete(g.tDown);
          }
          return;
        }
      }
    },
    command(c, tDown) {
      const s = stateAt(tDown);
      const accepted = act(c.type, s, tDown, c);
      log('command', { command: { ...c }, tDown, stateAtTDown: s, state, accepted });
      return accepted;
    },
    select(trackId) {
      const cur = store.current;
      if (!cur.tracks.some((t) => t.id === trackId) || cur.selectedId === trackId) return;
      commitSession({ ...cur, selectedId: trackId });
    },
    toggleTrack(trackId) {
      setTrackOn((t) => t.id === trackId, (t) => !t.on);
      log('toggle', { trackId });
    },
    async setDevice(patch) {
      device = { ...device, ...patch };
      log('device', { ...device });
      await saveDevice(device);
    },
    async clearSession() {
      if (take) discardTake();
      stopPlayback();
      const fx = store.current.fx;
      await store.clear();
      if (fx) store.set({ ...store.current, fx }); // the echo setting survives a clear
      lastCommit = null;
      gcAudio();
      syncVoices();
      setState('idle', ctx.currentTime);
      changed();
      log('clear');
    },
    lastTakeWav() {
      const rec = lastRec ?? take?.rec ?? null;
      if (!rec) return null;
      const a = rec.rawAudio();
      return a.samples.length ? wavBlob(a.samples, a.sampleRate) : null;
    },
    voiceOutput: (trackId) => scheduler.trackOutput(trackId),
    onChange(cb) {
      changeSubs.add(cb);
      return () => void changeSubs.delete(cb);
    },
    onLog(cb) {
      logSubs.add(cb);
      return () => void logSubs.delete(cb);
    },
    logs: () => [...logBuf],
    flush: () => store.flush(),
    dispose() {
      offTick();
      offLife();
      if (take) discardTake();
      scheduler.dispose();
      for (const v of voices.values()) v.dispose();
      voices.clear();
    },
  };
}

/** what a tap means in each state */
const TAP_MEANS: Record<AppState, Input> = {
  idle: 'record',
  recordingFirst: 'stop',
  playing: 'record',
  overdubbing: 'commit',
  stopped: 'play',
};

// ---------- pure session helpers ----------

function newTrack(kind: InstrumentKind): Track {
  return { id: newId('t'), kind, take: null, on: true };
}

function withTake(tracks: Track[], id: string, take: Take): Track[] {
  return tracks.map((t) => (t.id === id ? { ...t, take } : t));
}

function removeTrack(s: Session, id: string, selectAfter: string | null): Session {
  const tracks = s.tracks.filter((t) => t.id !== id);
  const keep = selectAfter && tracks.some((t) => t.id === selectAfter) ? selectAfter : (tracks[0]?.id ?? null);
  return { ...s, tracks, selectedId: s.selectedId === id ? keep : s.selectedId };
}

let idCounter = 0;
function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1296;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36)}`;
}
