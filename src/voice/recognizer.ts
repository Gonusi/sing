// [voice] vosk-browser recogniser for hold-to-talk. vosk-browser (5.8 MB) is imported lazily in load(), so it
// stays out of the main chunk; it runs Kaldi in its own blob Web Worker and caches the model in IndexedDB.
//
// Per hold:
//   begin(fromT) take the warm spare KaldiRecognizer (made with GRAMMAR_JSON), feed mic.read(fromT, now) — the
//                speech since touch-down, before holdStart — then every new mic block, batched into CHUNK_SEC chunks.
//   replies      every chunk gets one reply: a partial (→ onPartial) or, when vosk itself detects the end of an
//                utterance (model.conf: ≥ 0.5–1.0 s of trailing silence), a result; heard = closed utterances + partial.
//   during hold  an endpoint result that is a command fires at once (it is vosk's final word on that utterance).
//                Partials fire only under grammar.EARLY_RULE — off by default: replayed traces showed one-reply-to-
//                three-reply hallucinations ("record" in noise) and on/off flips, while the final is ~99 % right.
//   end()        1. tail: keep feeding RELEASE_TAIL_SEC of audio after the release (push-to-talk users let go
//                   while the last sound — the /f/ of "off" — is still arriving; the ring also lags the release);
//                2. flush + retrieveFinalResult, wait for its reply (≤ FINAL_TIMEOUT_MS);
//                3. fire the heard text if it is a command and nothing fired yet; resolve.
//   Then the used recogniser is removed and a new spare is created.
//
// Invariants:
//   I1 exactly one onCommand per hold: fire() is the only emitter and checks hold.fired.
//   I2 the worker answers every chunk and the one retrieveFinalResult with exactly one message, in order
//      → reply number (chunksSent + 1) after the final request is the final result; earlier results are endpoints.
//   I3 a KaldiRecognizer serves one hold; nothing is sent to it after remove().
//   I4 status only moves forward: off → loading → ready | error, ready → error. Any worker error → 'error'
//      (the worker's wasm is not trusted after an error); nothing ever throws into the UI except load()'s promise.
//   I5 end() always resolves, never rejects: every wait has a timeout and fail() wakes it.
// Coupling to vosk-browser 0.0.8 internals: Model's private `worker` field (crash listener, terminate) and the
// progress wrapper in load-progress.ts. package.json pins ^0.0.8 (= 0.0.8 only).
import type { Command, MicBlock, MicFeed, Recognizer, Sec, VoiceStatus } from '../types.ts';
import type { KaldiRecognizer, Model } from 'vosk-browser';
import type { RecognizerMessage } from 'vosk-browser/dist/interfaces';
import { GRAMMAR_JSON, canFireEarly, displayText, earlyCommand, normalizeText, parseCommand } from './grammar.ts';
import { PROGRESS_EVENT, constructWithProgress, type ProgressDetail } from './load-progress.ts';

export interface RecognizerDeps {
  ctx: AudioContext;
  mic: MicFeed;
  /** ABSOLUTE url of the .tar.gz model (vosk's blob worker resolves relative urls against the origin root) */
  modelUrl: string;
  /** dev only: every reply of a hold, with the text heard so far (dev/voice/replay.ts tunes EARLY_RULE from these) */
  onTrace?: (e: TraceEvent) => void;
}

export interface TraceEvent {
  kind: 'partial' | 'endpoint' | 'final';
  /** closed utterances + open partial, normalised, "[unk]" kept */
  text: string;
}

/** audio per acceptWaveformFloat call: one reply per chunk */
export const CHUNK_SEC = 0.08;
/** end(): audio fed after the release, before the final result is requested */
export const RELEASE_TAIL_SEC = 0.1;
/** end(): stop waiting for the tail audio this long after it should have arrived (mic stalled) */
const TAIL_SLACK_MS = 150;
/** end(): give up waiting for the final result after this long */
const FINAL_TIMEOUT_MS = 1500;
/** load(): fail when the worker shows no sign of life (progress or ready) for this long */
const LOAD_STALL_MS = 60_000;
/** share of the progress bar for the download; the rest is unpacking + model creation in the worker */
const DOWNLOAD_SHARE = 0.85;
/** vosk/Kaldi log level: -1 = warnings and errors only */
const VOSK_LOG_LEVEL = -1;

type VoskModule = typeof import('vosk-browser');

interface Slot {
  rec: KaldiRecognizer;
  hold: Hold | null;
}

interface Hold {
  slot: Slot;
  /** next context frame to feed */
  cursor: number;
  /** end(): feed up to this frame, then stop (null = no limit yet) */
  feedUntil: number | null;
  batch: Float32Array;
  batchLen: number;
  chunksSent: number;
  replies: number;
  finalRequested: boolean;
  /** utterances vosk closed itself (endpoint results) during this hold */
  segments: string[];
  /** the open utterance */
  partial: string;
  lastText: string;
  repeats: number;
  /** last text sent to onPartial */
  shown: string;
  fired: Command | null;
  unsubscribe: (() => void) | null;
  /** resolves the wait end() is in (tail or final result) */
  wake: (() => void) | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const workerOf = (model: Model) => (model as unknown as { worker?: Worker }).worker;

/** vosk-browser is UMD/CommonJS: depending on the bundler the API is on the namespace or on `default` */
async function importVosk(): Promise<VoskModule> {
  const mod = (await import('vosk-browser')) as VoskModule & { default?: VoskModule };
  if (typeof mod.Model === 'function') return mod;
  if (mod.default && typeof mod.default.Model === 'function') return mod.default;
  throw new Error('vosk-browser: Model export not found');
}

/**
 * Create the Model and wait for it. Rejects on a load error, a worker crash or LOAD_STALL_MS without progress.
 * After it resolved, later fatal errors go to `onFatal`.
 */
function openModel(vosk: VoskModule, modelUrl: string, onProgress: (f: number) => void, onFatal: (reason: string) => void): Promise<Model> {
  const model = constructWithProgress(modelUrl, () => new vosk.Model(modelUrl, VOSK_LOG_LEVEL));
  return new Promise<Model>((resolve, reject) => {
    let settled = false;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const fatal = (reason: string) => {
      if (settled) return onFatal(reason);
      settled = true;
      clearTimeout(stall);
      workerOf(model)?.terminate();
      reject(new Error(reason));
    };
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => fatal(`model load stalled for ${LOAD_STALL_MS / 1000} s`), LOAD_STALL_MS);
    };
    model.on('load', (m) => {
      if (!('result' in m) || !m.result) return fatal('model failed to load');
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      resolve(model);
    });
    model.on('error', (m) => fatal(`vosk: ${'error' in m ? m.error : 'unknown error'}`));
    workerOf(model)?.addEventListener('error', (e) => fatal(`vosk worker crashed: ${e.message || 'unknown'}`));
    model.addEventListener(PROGRESS_EVENT, (e) => {
      if (settled) return;
      armStall();
      const { loaded, total } = (e as CustomEvent<ProgressDetail>).detail;
      if (total > 0) onProgress(DOWNLOAD_SHARE * Math.min(1, loaded / total));
    });
    armStall();
  });
}

/** wait until `arm(done)`'s caller calls done, or `ms` passed; `done` is idempotent */
function waitFor(ms: number, arm: (done: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    arm(done);
  });
}

export function createRecognizer(deps: RecognizerDeps): Recognizer {
  const { ctx, mic, modelUrl, onTrace } = deps;
  const sampleRate = mic.sampleRate;
  const chunkSamples = Math.round(CHUNK_SEC * sampleRate);
  const commandSubs = new Set<(c: Command) => void>();
  const partialSubs = new Set<(t: string) => void>();
  let status: VoiceStatus = 'off';
  let loading: Promise<void> | null = null;
  let model: Model | null = null;
  let spare: Slot | null = null;
  let active: Hold | null = null;
  /** holds between end() and their resolve */
  const finishing = new Set<Hold>();

  function emit<T>(subs: Set<(v: T) => void>, v: T): void {
    for (const cb of [...subs]) {
      try {
        cb(v);
      } catch (e) {
        console.error('voice subscriber failed', e);
      }
    }
  }

  /** I4: any worker problem ends voice for this session; pending holds resolve (I5) */
  function fail(reason: string): void {
    if (status === 'error') return;
    console.warn(`voice: ${reason}`);
    status = 'error';
    const pending = [...(active ? [active] : []), ...finishing];
    active = null;
    for (const h of pending) {
      stopFeeding(h);
      h.wake?.();
    }
    if (model) workerOf(model)?.terminate();
    model = null;
    spare = null;
  }

  // ---------- recognisers ----------

  function createSlot(): Slot | null {
    if (!model || status !== 'ready') return null;
    try {
      const rec = new model.KaldiRecognizer(sampleRate, GRAMMAR_JSON);
      const slot: Slot = { rec, hold: null };
      const onReply = (m: RecognizerMessage) => onMessage(slot, m);
      rec.on('partialresult', onReply);
      rec.on('result', onReply);
      rec.on('error', onReply);
      return slot;
    } catch (e) {
      fail(`recogniser creation failed: ${errText(e)}`);
      return null;
    }
  }

  /** I3: remove the used recogniser, keep one spare ready */
  function retire(slot: Slot): void {
    slot.hold = null;
    try {
      slot.rec.remove();
    } catch {
      /* worker already gone */
    }
    if (!spare) spare = createSlot();
  }

  // ---------- replies ----------

  function heardText(h: Hold): string {
    return normalizeText([...h.segments, h.partial].join(' '));
  }

  function show(h: Hold, text: string): void {
    const d = displayText(text);
    if (d === h.shown) return;
    h.shown = d;
    emit(partialSubs, d);
  }

  /** I1 */
  function fire(h: Hold, c: Command): void {
    if (h.fired) return;
    h.fired = c;
    emit(commandSubs, c);
  }

  function onMessage(slot: Slot, m: RecognizerMessage): void {
    if (m.event === 'error') return fail(`worker error: ${m.error}`);
    const h = slot.hold;
    if (!h) return; // a spare gets no replies (create has none); a retired slot is unregistered
    h.replies++;
    const isFinal = h.finalRequested && h.replies === h.chunksSent + 1; // I2
    if (m.event === 'partialresult') {
      h.partial = m.result.partial ?? '';
      return afterText(h, 'partial');
    }
    const text = normalizeText(m.result.text ?? '');
    h.partial = '';
    if (text) h.segments.push(text);
    if (isFinal) {
      onTrace?.({ kind: 'final', text: heardText(h) });
      return h.wake?.();
    }
    afterText(h, 'endpoint');
  }

  function afterText(h: Hold, kind: 'partial' | 'endpoint'): void {
    const text = heardText(h);
    onTrace?.({ kind, text });
    show(h, text);
    h.repeats = text === h.lastText ? h.repeats + 1 : 1;
    h.lastText = text;
    if (h.fired) return;
    const c = kind === 'endpoint' ? (canFireEarly(text) ? parseCommand(text) : null) : earlyCommand(text, h.repeats);
    if (c) fire(h, c);
  }

  // ---------- feeding ----------

  function send(h: Hold): void {
    if (!h.batchLen) return;
    const chunk = h.batch.slice(0, h.batchLen);
    h.batchLen = 0;
    h.chunksSent++;
    try {
      h.slot.rec.acceptWaveformFloat(chunk, sampleRate);
    } catch (e) {
      fail(`acceptWaveformFloat failed: ${errText(e)}`);
    }
  }

  function feed(h: Hold, s: Float32Array): void {
    h.cursor += s.length;
    for (let i = 0; i < s.length; ) {
      const n = Math.min(chunkSamples - h.batchLen, s.length - i);
      h.batch.set(s.subarray(i, i + n), h.batchLen);
      h.batchLen += n;
      i += n;
      if (h.batchLen === chunkSamples) send(h);
    }
  }

  function onBlock(h: Hold, b: MicBlock): void {
    const skip = h.cursor - b.frame;
    if (skip >= b.samples.length) return; // already fed from the ring
    if (skip < 0) h.cursor = b.frame; // a gap in the mic stream: carry on from this block
    let s = skip > 0 ? b.samples.subarray(skip) : b.samples;
    if (h.feedUntil !== null) s = s.subarray(0, Math.max(0, h.feedUntil - h.cursor));
    feed(h, s);
    if (h.feedUntil !== null && h.cursor >= h.feedUntil) h.wake?.();
  }

  function stopFeeding(h: Hold): void {
    h.unsubscribe?.();
    h.unsubscribe = null;
  }

  // ---------- hold lifecycle ----------

  function startHold(slot: Slot, fromT: Sec): Hold {
    const h: Hold = {
      slot, cursor: 0, feedUntil: null, batch: new Float32Array(chunkSamples), batchLen: 0, chunksSent: 0, replies: 0,
      finalRequested: false, segments: [], partial: '', lastText: '', repeats: 0, shown: '', fired: null,
      unsubscribe: null, wake: null,
    };
    slot.hold = h;
    // the ring read and the subscription happen in one task: no block can slip in between
    const held = mic.read(fromT, ctx.currentTime);
    h.cursor = Math.round(held.t * sampleRate);
    feed(h, held.samples);
    h.unsubscribe = mic.subscribe((b) => onBlock(h, b));
    return h;
  }

  /** end() step 1: keep feeding until RELEASE_TAIL_SEC of audio after now has arrived */
  function feedTail(h: Hold): Promise<void> {
    h.feedUntil = Math.round((ctx.currentTime + RELEASE_TAIL_SEC) * sampleRate);
    if (status !== 'ready' || h.cursor >= h.feedUntil) return Promise.resolve();
    return waitFor(RELEASE_TAIL_SEC * 1000 + TAIL_SLACK_MS, (done) => (h.wake = done));
  }

  /** end() step 2: flush and wait for the final result (I2) */
  function finalResult(h: Hold): Promise<void> {
    stopFeeding(h);
    send(h);
    if (status !== 'ready') return Promise.resolve();
    return waitFor(FINAL_TIMEOUT_MS, (done) => {
      h.wake = done;
      h.finalRequested = true;
      try {
        h.slot.rec.retrieveFinalResult();
      } catch (e) {
        fail(`retrieveFinalResult failed: ${errText(e)}`);
      }
    });
  }

  /** I5 */
  async function finishHold(h: Hold): Promise<Command | null> {
    if (active === h) active = null;
    finishing.add(h);
    await feedTail(h);
    await finalResult(h);
    finishing.delete(h);
    h.wake = null;
    // step 3: the final result, or on timeout the best text so far
    const text = heardText(h);
    show(h, text);
    const c = parseCommand(text);
    if (c && status !== 'error') fire(h, c);
    retire(h.slot);
    return h.fired;
  }

  async function doLoad(onProgress: (f: number) => void): Promise<void> {
    status = 'loading';
    onProgress(0);
    try {
      const vosk = await importVosk();
      model = await openModel(vosk, modelUrl, onProgress, fail);
      status = 'ready';
      spare = createSlot();
      onProgress(1);
    } catch (e) {
      fail(`model load failed: ${errText(e)}`);
      throw e;
    }
  }

  return {
    get status() {
      return status;
    },
    load(onProgress) {
      loading ??= doLoad(onProgress);
      return loading;
    },
    begin(fromT) {
      if (status !== 'ready') return;
      if (active) void finishHold(active); // begin without end: close the previous hold first
      const slot = spare ?? createSlot();
      spare = null;
      if (!slot) return;
      active = startHold(slot, fromT);
    },
    async end() {
      const h = active;
      if (!h) return null;
      return finishHold(h);
    },
    onCommand(cb) {
      commandSubs.add(cb);
      return () => void commandSubs.delete(cb);
    },
    onPartial(cb) {
      partialSubs.add(cb);
      return () => void partialSubs.delete(cb);
    },
  };
}
