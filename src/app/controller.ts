// [engine] The state machine (idle → countIn → recordingFirst → playing ⇄ overdubbing, stopped) and the timing model.
// See PLAN.md "Round 4" (transport, tempo) and "Timing model". Owns voices, the scheduler, the metronome and takes.
//
// Transport table as implemented (s = state at tDown, from a short state history; taps do NOTHING here — main.ts maps
// them to seek). Voice commands: record = transport('record'), play = 'play', stop = 'pause'.
// | s              | input        | result                                                                       |
// |----------------|--------------|------------------------------------------------------------------------------|
// | idle           | record       | countIn (1 bar, always clicks) → recordingFirst with t0 = the downbeat D       |
// | countIn        | record/pause | cancel → back to idle / stopped                                              |
// |                | (tick at D)  | recordingFirst (first) or overdubbing (from stopped)                         |
// | recordingFirst | record       | commit: L = max(1, round-half-up(bars)) bars → playing from min(end, t0 + L) |
// |                | pause        | commit as above → stopped at the position heard then                         |
// |                | auto t0+60 s | as record                                                                    |
// |                | undo         | discard → idle                                                               |
// | playing        | record       | punch in: overdubbing from now (ts = tDown), selected lane if empty else new |
// |                | pause        | stopped; the playhead stays where it was heard                               |
// | overdubbing    | record       | commit what was sung → playing                                               |
// |                | pause        | commit → stopped                                                             |
// |                | window end   | commit after exactly one cycle → playing                                     |
// |                | undo         | discard → playing                                                            |
// |                | create       | error blip                                                                   |
// | stopped        | play         | playing from the playhead (resume)                                           |
// |                | record       | countIn, then play from the playhead and overdub from it (ts = D)            |
// | playing/stopped| toStart      | playhead → 0 (playing: jumps and keeps playing); refused otherwise           |
// | any but overd. | create X     | add + select an empty X lane (undoable)                                      |
// | any            | toggle X     | every X lane on/off (not undoable)                                           |
// seek(pos): beat-snapped; playing → jump; stopped → new resume position; refused in countIn/recording/without a loop.
// Tempo (Session.tempo): setTempo rescales every note/hit/raw and the loop (same bars), not an undo point (undo keeps
// the current tempo); refused while a vocal take exists or while counting in / recording.
// Metronome: clicks on the loop's beat grid while running when fx.click (default on), always during count-in; into
// master (not the echo bus); drum takes exclude each click (unless the output is headphones).
import type {
  AppState, Command, Controller, DeviceSettings, Gesture, InstrumentKind, LogEvent, ScheduledTrack, Sec, Session, Take, Tempo,
  Track, TransportAction, View, Voice,
} from '../types.ts';
import { DEFAULT_TEMPO, TEMPO_MAX_BPM, TEMPO_MIN_BPM } from '../types.ts';
import { createMetronome, type BeatGrid } from '../loop/metronome.ts';
import { JUMP_FADE_SEC } from '../loop/clock.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';
import { wavBlob } from '../audio/wav-encode.ts';
import { createScheduler, type LoopScheduler } from '../loop/clock.ts';
import { FIRST_TAKE_DISPLAY_MIN_SEC, createTakeRecorder, deriveNotes, type Analysis, type TakeRecorder } from '../loop/take.ts';
import { DEFAULT_SMOOTHING } from '../analysis/clean.ts';
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
  /**
   * remove a lane (undo point, like create): its voice is disposed; a take in progress on it is discarded first
   * (state as for undo of that take); selection moves to the next lane (or the previous, or null); the loop length
   * stays while any lane remains, an emptied session is idle with no loop (undoable). false = unknown id.
   */
  deleteTrack(trackId: string): boolean;
  /** decoded loop audio of a vocal track (null when none / not loaded) */
  vocalAudio(trackId: string): AudioBuffer | null;
  dispose(): void;
}

export const MAX_FIRST_TAKE_SEC = 60;
/** count-in: the first click is heard this long after the record press (+ outLat) */
export const COUNT_IN_LEAD_SEC = 0.1;
/** drum takes drop hits within this corrected-time window around each metronome click (on speakers) */
const CLICK_EXCLUDE = { before: 0.01, after: 0.04 } as const;
/** overdub commit waits for the last audio (inLat) plus analysis finalisation */
export const COMMIT_MARGIN_SEC = 0.15;
/** vocal overdubs need only the 20 ms seam tail + one block: commit sooner, so less of the first replay is missed */
export const VOCAL_COMMIT_MARGIN_SEC = 0.05;
/** echo amount for a session that has none saved (?test: 0, so existing expectations hold) */
export const DEFAULT_ECHO = 0.2;
/** stopped → play: pos 0 is scheduled this long after now, so nothing starts late */
export const START_LEAD_SEC = 0.03;
export const LOG_MAX = 2000;
const STATE_HISTORY_MAX = 64;
const HOLDS_MAX = 16;

type Input = Command['type'];

interface CountIn {
  /** heard time of the downbeat recording starts on */
  D: Sec;
  /** heard time of the first count-in click */
  c0: Sec;
  mode: 'first' | 'overdub';
  /** state to go back to on cancel */
  prev: AppState;
}

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
  // the stored mic choice (main.ts opens the default mic before the controller exists)
  if (!deps.test && device.micId && mic.inputId() !== device.micId) {
    const opened = await mic.setInput(device.micId);
    if (!opened) console.warn('stored mic not available, default in use');
  }
  const echoOf = (sess: Session) => sess.fx?.echo ?? (deps.test ? 0 : DEFAULT_ECHO);
  const smoothOf = (sess: Session) => sess.fx?.smooth ?? DEFAULT_SMOOTHING;
  const clickOf = (sess: Session) => sess.fx?.click ?? true;
  /** Session.fx with every setting filled in (echo, smooth and click always travel together) */
  const withFx = (sess: Session, patch: Partial<NonNullable<Session['fx']>>): Session =>
    ({ ...sess, fx: { echo: echoOf(sess), smooth: smoothOf(sess), click: clickOf(sess), ...patch } });
  const tempoOf = (sess: Session = store.current): Tempo => sess.tempo ?? DEFAULT_TEMPO;
  const beatSecOf = (sess?: Session) => 60 / tempoOf(sess).bpm;
  const barSecOf = (sess?: Session) => beatSecOf(sess) * tempoOf(sess).beatsPerBar;
  const tempoEditable = (sess: Session = store.current) => !sess.tracks.some((t) => t.take?.audio);
  /** every position and length × ratio (a tempo change keeps bar positions) */
  const rescale = (sess: Session, ratio: number, tempo: Tempo): Session => ({
    ...sess,
    tempo,
    loopLength: sess.loopLength === null ? null : sess.loopLength * ratio,
    tracks: sess.tracks.map((t) => (!t.take ? t : {
      ...t,
      take: {
        ...t.take,
        notes: t.take.notes.map((n) => ({ ...n, pos: n.pos * ratio, dur: n.dur * ratio })),
        hits: t.take.hits.map((h) => ({ ...h, pos: h.pos * ratio })),
        ...(t.take.raw ? { raw: t.take.raw.map((n) => ({ ...n, pos: n.pos * ratio, dur: n.dur * ratio })) } : {}),
      },
    })),
  });
  const profileOf = () => ({ tuningOffset: device.tuningOffset, range: device.range });
  /** re-derive every melodic take's notes from its raw detections (old takes without raw keep their notes) */
  const rederive = (sess: Session, smoothing: number): Session => {
    const L = sess.loopLength;
    if (L === null) return sess;
    let changedAny = false;
    const tracks = sess.tracks.map((t) => {
      if (t.kind === 'drums' || t.kind === 'vocals' || !t.take?.raw) return t;
      changedAny = true;
      return { ...t, take: { ...t.take, notes: deriveNotes(t.take.raw, smoothing, L, t.kind, t.take.id, deps.analysis, profileOf()) } };
    });
    return changedAny ? { ...sess, tracks } : sess;
  };
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
  /** where play resumes (loop position) while stopped */
  let resumePos: Sec = 0;
  let countIn: CountIn | null = null;
  const metronome = createMetronome(engine);

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
  const syncVoices = (catchUp = true) => {
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
    pushTracks(catchUp);
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
  const scheduledList = (): ScheduledTrack[] => {
    const list: ScheduledTrack[] = [];
    for (const t of store.current.tracks) {
      const voice = voices.get(t.id);
      if (!voice) continue;
      const pending = take?.mode === 'overdub' && take.trackId === t.id ? take.rec.pendingTake() : null;
      list.push({ track: pending ? { ...t, take: pending } : t, voice, activeFrom: activeFrom.get(t.id) });
    }
    return list;
  };
  const pushTracks = (catchUp = true) => scheduler.setTracks(scheduledList(), { catchUp });
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
  // ---- takes ----
  const newTake = (lane: Track, window: Parameters<typeof createTakeRecorder>[0]['window'], createdLane: boolean, prevSelected: string | null, tDown: Sec): ActiveTake => {
    const rec = createTakeRecorder({
      mic, kind: lane.kind, takeId: newId('k'), inLat: device.inLat, window, analysis: deps.analysis,
      smoothing: () => smoothOf(store.current),
      profile: profileOf,
      drumTemplates: device.drums,
    });
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

  /** the first take's recorder, created at the count-in with t0 = the downbeat D (its feed starts at D's pre-roll) */
  const prepareFirstTake = (t0: Sec, tDown: Sec) => {
    const before = store.current;
    let lane = before.tracks.find((t) => t.id === before.selectedId && !t.take) ?? before.tracks.find((t) => !t.take);
    let s = before;
    const created = !lane;
    if (!lane) {
      lane = newTrack('synth');
      s = { ...s, tracks: [...s.tracks, lane] };
    }
    commitSession({ ...s, selectedId: lane.id });
    take = newTake(lane, { type: 'first', t0 }, created, before.selectedId, tDown);
  };

  /** whole bars: max(1, round-half-up(recorded bars)) */
  const barRounded = (recorded: Sec) => Math.max(1, Math.floor(recorded / barSecOf() + 0.5)) * barSecOf();

  const finishFirstTake = (end: Sec): boolean => {
    const t = take;
    if (!t || t.mode !== 'first') return false;
    const L = barRounded(end - t.start);
    const result = t.rec.finish(end, L);
    endTake(t);
    keepVocalAudio(t.rec, result);
    const cur = store.current;
    const undoPoint = t.createdLane ? removeTrack(cur, t.trackId, t.prevSelected) : cur;
    commitSession({ ...cur, loopLength: L, tracks: withTake(cur.tracks, t.trackId, result) }, undoPoint);
    log('take', { phase: 'commit', mode: 'first', trackId: t.trackId, takeId: result.id, L, bars: Math.round(L / barSecOf()), t0: t.start, end, notes: result.notes.length, hits: result.hits.length });
    // rounded down: cycle 1 already began (catch-up plays it from t0 + L); rounded up: a silent tail until t0 + L
    scheduler.start(t.start, L, Math.min(end, t.start + L));
    setState('playing', end);
    return true;
  };

  /** the overdub recorder for window [ts, ts + L) (state is set by the caller) */
  const prepareOverdub = (ts: Sec, tDown: Sec): boolean => {
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
  const snapToBeat = (pos: Sec): Sec => {
    const L = store.current.loopLength ?? 0;
    const b = beatSecOf();
    const p = Math.round(pos / b) * b;
    return L > 0 ? ((p % L) + L) % L : 0;
  };
  /** play from loop position P: P is heard START_LEAD_SEC (+ outLat) from now */
  const startPlaybackFrom = (P: Sec): Sec | null => {
    const L = store.current.loopLength;
    if (L === null) return null;
    // one read of the clock for the logged numbers: currentTime can advance by a quantum within a task
    const now = ctx.currentTime;
    const outLat = engine.outLat();
    const origin = now + outLat + START_LEAD_SEC - P;
    log('play', { now, outLat, origin, from: P });
    activeFrom.clear();
    pushTracks();
    scheduler.start(origin, L, origin + P);
    return origin;
  };
  /** while playing: continue from loop position P (fade, new origin) */
  const jumpTo = (P: Sec) => {
    const L = store.current.loopLength;
    if (L === null) return;
    const now = ctx.currentTime;
    const outLat = engine.outLat();
    const origin = now + outLat + START_LEAD_SEC + JUMP_FADE_SEC - P;
    log('jump', { now, outLat, origin, to: P });
    scheduler.jump(origin, L, origin + P, scheduledList());
  };
  const stopPlayback = () => {
    scheduler.stop(ctx.currentTime);
    activeFrom.clear();
    metronome.cancel();
  };
  /** stop and keep the heard position as the resume point */
  const pauseHere = (at: Sec) => {
    resumePos = scheduler.pos(ctx.currentTime) ?? resumePos;
    stopPlayback();
    setState('stopped', at);
  };

  // ---- count-in ----
  const startCountIn = (mode: 'first' | 'overdub', tDown: Sec): boolean => {
    const bar = barSecOf();
    const c0 = ctx.currentTime + engine.outLat() + COUNT_IN_LEAD_SEC;
    const D = c0 + bar;
    if (mode === 'first') {
      prepareFirstTake(D, tDown);
    } else {
      const L = store.current.loopLength;
      if (L === null) return false;
      const P = snapToBeat(resumePos);
      resumePos = P;
      activeFrom.clear();
      pushTracks();
      scheduler.start(D - P, L, D); // playback begins exactly at the downbeat, at P
      if (!prepareOverdub(D, tDown)) {
        stopPlayback();
        return false;
      }
    }
    countIn = { D, c0, mode, prev: state };
    log('countIn', { D, c0, mode, beats: tempoOf().beatsPerBar, bpm: tempoOf().bpm });
    setState('countIn', tDown);
    return true;
  };
  const cancelCountIn = (at: Sec): boolean => {
    const c = countIn;
    if (!c) return false;
    countIn = null;
    discardTake('count-in cancelled');
    if (c.mode === 'overdub') stopPlayback();
    metronome.cancel();
    setState(c.prev, at);
    return true;
  };

  // ---- undo ----
  const popUndo = (at: Sec): boolean => {
    const fx = store.current.fx;
    const popped = store.undo();
    if (!popped) {
      log('undo', { empty: true });
      return false;
    }
    // echo, smoothing, click and tempo are not undo steps: keep the current ones on the restored snapshot
    const tempo = tempoOf();
    const retimed = tempoOf(popped).bpm !== tempo.bpm ? rescale(popped, tempoOf(popped).bpm / tempo.bpm, tempo) : popped;
    const prev = fx ? rederive({ ...retimed, fx }, smoothOf({ ...retimed, fx })) : retimed;
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
  /** the transport, read against s = the state at tDown */
  const transportAct = (action: TransportAction, s: AppState, tDown: Sec): boolean => {
    switch (action) {
      case 'record':
        if (s === 'countIn') return cancelCountIn(tDown);
        if (s === 'idle') return state === 'idle' && startCountIn('first', tDown);
        if (s === 'stopped') return state === 'stopped' && startCountIn('overdub', tDown);
        if (s === 'playing') {
          if (state !== 'playing' || !prepareOverdub(tDown, tDown)) return false;
          setState('overdubbing', tDown); // punch in now
          return true;
        }
        if (s === 'recordingFirst') return finishFirstTake(tDown);
        if (s === 'overdubbing') {
          if (take?.mode !== 'overdub') return false;
          commitOverdub(Math.max(tDown, take.start));
          if (state === 'overdubbing') setState('playing', tDown);
          return true;
        }
        return false;
      case 'pause':
        if (s === 'countIn') return cancelCountIn(tDown);
        if (s === 'recordingFirst') {
          if (!finishFirstTake(tDown)) return false;
          pauseHere(tDown);
          return true;
        }
        if (s === 'playing' || s === 'overdubbing') {
          if (state !== 'playing' && state !== 'overdubbing') return false;
          if (take?.mode === 'overdub') commitOverdub(Math.max(tDown, take.start));
          pauseHere(tDown);
          return true;
        }
        return false;
      case 'play':
        if (s !== 'stopped' || state !== 'stopped') return false;
        if (startPlaybackFrom(resumePos) === null) return false;
        setState('playing', tDown);
        return true;
      case 'toStart':
        return seekTo(0, 'toStart');
    }
  };

  const seekTo = (pos: Sec, why: string): boolean => {
    if (store.current.loopLength === null || (state !== 'playing' && state !== 'stopped')) return false;
    const P = snapToBeat(pos);
    if (state === 'playing') jumpTo(P);
    else resumePos = P;
    log('seek', { pos, to: P, why, state });
    changed();
    return true;
  };

  const act = (input: Input, s: AppState, tDown: Sec, c?: Command): boolean => {
    switch (input) {
      case 'record':
        return transportAct('record', s, tDown);
      case 'stop':
        return transportAct('pause', s, tDown);
      case 'play':
        return transportAct('play', s, tDown);
      case 'undo':
        if (s === 'countIn') return cancelCountIn(tDown);
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
  const currentGrid = (): BeatGrid | null => {
    const t = tempoOf();
    const g = (anchor: Sec): BeatGrid => ({ anchor, beatSec: 60 / t.bpm, beatsPerBar: t.beatsPerBar });
    if (state === 'countIn' && countIn) return g(countIn.mode === 'first' ? countIn.D : (scheduler.origin ?? countIn.D));
    if (state === 'recordingFirst' && take) return g(take.start);
    if ((state === 'playing' || state === 'overdubbing') && scheduler.origin !== null) return g(scheduler.origin);
    return null;
  };
  /** View.playhead: heard position while playing, resume position while stopped / counting in from it, else null */
  const playheadAt = (now: Sec): Sec | null => {
    if (store.current.loopLength === null) return null;
    if (state === 'playing' || state === 'overdubbing') return scheduler.pos(now);
    if (state === 'countIn' && countIn?.mode === 'overdub') return resumePos;
    if (state === 'stopped') return resumePos;
    return null;
  };
  /** View.beat: bar/beat (1-based) and phase while running; the count-in bar counts as bar 1 */
  const beatAt = (now: Sec): View['beat'] => {
    const t = tempoOf();
    const beatSec = 60 / t.bpm;
    let p: Sec | null = null;
    if (state === 'countIn' && countIn) p = Math.max(0, now - countIn.c0);
    else if (state === 'recordingFirst' && take) p = Math.max(0, now - take.start);
    else if (state === 'playing' || state === 'overdubbing') p = scheduler.pos(now);
    if (p === null) return null;
    const b = p / beatSec;
    const k = Math.floor(b + 1e-9);
    return { bar: Math.floor(k / t.beatsPerBar) + 1, beat: (k % t.beatsPerBar) + 1, phase: Math.max(0, b - k) };
  };
  /** metronome clicks are heard by the mic on speakers: a drum take must not turn them into hats */
  const excludeClicks = () => device.output !== 'wired' && device.output !== 'bluetooth';
  const metronomeTick = () => {
    metronome.setGrid(currentGrid());
    const c = countIn;
    metronome.tick(
      (heard) => (c !== null && heard < c.D - 1e-6) || clickOf(store.current),
      (heard) => {
        if (take && excludeClicks() && store.current.tracks.find((x) => x.id === take?.trackId)?.kind === 'drums') {
          take.rec.addExclusion({ from: heard - CLICK_EXCLUDE.before, to: heard + CLICK_EXCLUDE.after });
        }
      },
    );
  };

  const offTick = engine.onTick(() => {
    const now = ctx.currentTime;
    if (state === 'countIn' && countIn && now >= countIn.D) {
      const c = countIn;
      countIn = null;
      setState(c.mode === 'first' ? 'recordingFirst' : 'overdubbing', c.D);
    }
    metronomeTick();
    const t = take;
    if (!t || state === 'countIn') return;
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
    setSmoothing(amount) {
      const a = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : DEFAULT_SMOOTHING));
      const cur = store.current;
      if (cur.fx?.smooth === a) return;
      store.set(rederive(withFx(cur, { smooth: a }), a)); // no undo point
      // notes already sounding are not started again; the window already scheduled may play old notes once
      syncVoices(false);
      log('smoothing', { amount: a });
      changed();
    },
    setEcho(amount) {
      const a = Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0));
      engine.setEcho(a);
      const cur = store.current;
      if (cur.fx?.echo === a) return;
      store.set(withFx(cur, { echo: a })); // no undo point
      log('echo', { amount: a });
      changed();
    },
    deleteTrack(trackId) {
      if (!store.current.tracks.some((t) => t.id === trackId)) return false;
      const at = ctx.currentTime;
      if (state === 'countIn' && take?.trackId === trackId) cancelCountIn(at);
      if (take?.trackId === trackId) {
        const mode = take.mode;
        discardTake(); // a lane created for the take goes with it
        if (mode === 'first') setState('idle', at);
        else if (state === 'overdubbing') setState('playing', at);
      }
      const cur = store.current;
      const idx = cur.tracks.findIndex((t) => t.id === trackId);
      if (idx < 0) {
        log('delete', { trackId, withTake: true });
        return true;
      }
      const tracks = cur.tracks.filter((t) => t.id !== trackId);
      const neighbour = tracks[idx] ?? tracks[idx - 1] ?? null;
      const selectedId = cur.selectedId === trackId ? (neighbour?.id ?? null) : cur.selectedId;
      if (tracks.length === 0) {
        if (scheduler.running) stopPlayback();
        commitSession({ ...cur, tracks: [], selectedId: null, loopLength: null }, cur);
        setState('idle', at);
      } else {
        commitSession({ ...cur, tracks, selectedId }, cur);
      }
      log('delete', { trackId, left: tracks.length });
      return true;
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
        tempo: tempoOf(),
        playhead: playheadAt(now),
        beat: beatAt(now),
        countIn: state === 'countIn' && countIn
          ? Math.min(tempoOf().beatsPerBar, Math.max(1, Math.ceil((countIn.D - now) / beatSecOf() - 1e-9)))
          : null,
        tempoEditable: tempoEditable(),
      };
    },
    transport(action, tDown) {
      const s = stateAt(tDown);
      const accepted = transportAct(action, s, tDown);
      log('transport-action', { action, tDown, stateAtTDown: s, state, accepted });
      return accepted;
    },
    seek(pos) {
      return seekTo(pos, 'seek');
    },
    setTempo(bpm) {
      if (!Number.isFinite(bpm) || !tempoEditable()) return false;
      if (state === 'countIn' || state === 'recordingFirst' || state === 'overdubbing') return false;
      const old = tempoOf();
      const b = Math.round(Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, bpm)) * 100) / 100;
      if (b === old.bpm) return true;
      const ratio = old.bpm / b;
      const pos = state === 'playing' ? scheduler.pos(ctx.currentTime) : null;
      store.set(rescale(store.current, ratio, { ...old, bpm: b })); // not an undo point (like echo)
      resumePos *= ratio;
      // the same lanes and voices: while playing, jump hands the scheduler the rescaled tracks and loop atomically
      if (pos !== null) jumpTo(pos * ratio);
      else pushTracks();
      log('tempo', { bpm: b, ratio });
      changed();
      return true;
    },
    setClick(on) {
      const cur = store.current;
      if (clickOf(cur) === on) return;
      store.set(withFx(cur, { click: on })); // not an undo point
      log('click', { on });
      changed();
    },
    gesture(g: Gesture) {
      log('gesture', { ...g });
      switch (g.type) {
        case 'tap':
          return; // taps no longer record: main.ts maps them to seek
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
      // a mic choice is applied here (main.ts createMic doesn't know it); a failed choice falls back to the default
      if ('micId' in patch && (patch.micId ?? null) !== mic.inputId()) {
        const opened = await mic.setInput(patch.micId ?? null);
        if (!opened) log('error', { message: 'chosen mic failed, default in use', micId: patch.micId });
      }
      const before = device;
      device = { ...device, ...patch };
      log('device', { ...device });
      // a newly learned voice profile re-derives the takes (like a smoothing change)
      if (before.tuningOffset !== device.tuningOffset || JSON.stringify(before.range) !== JSON.stringify(device.range)) {
        store.set(rederive(store.current, smoothOf(store.current)));
        syncVoices(false);
        changed();
      }
      await saveDevice(device);
    },
    async clearSession() {
      if (take) discardTake();
      stopPlayback();
      const fx = store.current.fx;
      const tempo = store.current.tempo;
      if (countIn) cancelCountIn(ctx.currentTime);
      await store.clear();
      // the settings and the tempo survive a clear
      if (fx || tempo) store.set({ ...store.current, ...(fx ? { fx } : {}), ...(tempo ? { tempo } : {}) });
      resumePos = 0;
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
