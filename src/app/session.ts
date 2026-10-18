// [engine] Session store: snapshots for undo, IndexedDB persistence (idb-keyval), device settings.
//
// - Session and DeviceSettings live under separate keys, so undo never touches the device (calibration).
// - Sessions are immutable values: every change produces a new Session object (the UI may hold on to one).
// - Undo: a stack of whole-session snapshots, pushed BEFORE a commit/create/delete (not on on/off/select).
// - Every IndexedDB call is wrapped: the app keeps working (in memory) when storage fails.
import { get, set } from 'idb-keyval';
import type { DeviceSettings, InstrumentKind, Session, Track } from '../types.ts';
import { INSTRUMENTS } from '../types.ts';

/** ec on by default: with EC off, iOS routes playback to the quiet earpiece (WebKit 326286); stored settings keep theirs */
export const DEFAULT_DEVICE: DeviceSettings = { inLat: 0.01, ec: true, calibrated: false };
export const SESSION_KEY = 'sing.session.v1';
export const DEVICE_KEY = 'sing.device.v1';
/** debounce for session saves */
export const SAVE_DEBOUNCE_MS = 250;
export const MAX_UNDO = 50;

export function emptySession(): Session {
  return { v: 1, loopLength: null, tracks: [], selectedId: null };
}

// ---------- device settings ----------

export async function loadDevice(): Promise<DeviceSettings> {
  try {
    const d = (await get(DEVICE_KEY)) as Partial<DeviceSettings> | undefined;
    return { ...DEFAULT_DEVICE, ...validDevice(d) };
  } catch (e) {
    console.warn('device settings not loaded', e);
    return { ...DEFAULT_DEVICE };
  }
}

export async function saveDevice(d: DeviceSettings): Promise<void> {
  try {
    await set(DEVICE_KEY, { ...d });
  } catch (e) {
    console.warn('device settings not saved', e);
  }
}

function validDevice(d: Partial<DeviceSettings> | undefined): Partial<DeviceSettings> {
  if (!d || typeof d !== 'object') return {};
  const out: Partial<DeviceSettings> = {};
  if (typeof d.inLat === 'number' && Number.isFinite(d.inLat)) out.inLat = d.inLat;
  if (typeof d.ec === 'boolean') out.ec = d.ec;
  if (typeof d.calibrated === 'boolean') out.calibrated = d.calibrated;
  return out;
}

// ---------- session ----------

export async function loadSession(): Promise<Session | null> {
  try {
    const s = await get(SESSION_KEY);
    return isSession(s) ? s : null;
  } catch (e) {
    console.warn('session not loaded', e);
    return null;
  }
}

async function saveSession(s: Session): Promise<void> {
  try {
    await set(SESSION_KEY, s);
  } catch (e) {
    console.warn('session not saved', e);
  }
}

export function isSession(s: unknown): s is Session {
  if (!s || typeof s !== 'object') return false;
  const x = s as Session;
  return (
    x.v === 1 &&
    (x.loopLength === null || (typeof x.loopLength === 'number' && x.loopLength > 0)) &&
    Array.isArray(x.tracks) &&
    x.tracks.every(isTrack) &&
    (x.selectedId === null || typeof x.selectedId === 'string')
  );
}

function isTrack(t: unknown): t is Track {
  if (!t || typeof t !== 'object') return false;
  const x = t as Track;
  return (
    typeof x.id === 'string' &&
    (INSTRUMENTS as readonly string[]).includes(x.kind as InstrumentKind) &&
    typeof x.on === 'boolean' &&
    (x.take === null || (typeof x.take === 'object' && Array.isArray(x.take.notes) && Array.isArray(x.take.hits)))
  );
}

export interface SessionStore {
  readonly current: Session;
  readonly canUndo: boolean;
  /** the current session plus every undo snapshot (what vocal audio GC must keep) */
  sessions(): Session[];
  /** replace the session; `undoPoint` (usually the previous session) is pushed onto the undo stack */
  set(next: Session, undoPoint?: Session): void;
  /** pop the last snapshot (null when there is none) */
  undo(): Session | null;
  /** empty session, empty undo stack, saved at once */
  clear(): Promise<void>;
  /** write the pending save now */
  flush(): Promise<void>;
}

export function createSessionStore(initial: Session, opts: { persist?: boolean } = {}): SessionStore {
  const persist = opts.persist ?? true;
  let current = initial;
  const stack: Session[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;

  const scheduleSave = () => {
    if (!persist) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  };
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!pending) return;
    pending = false;
    await saveSession(current);
  };
  if (persist && typeof addEventListener === 'function') {
    addEventListener('pagehide', () => void flush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush();
    });
  }

  return {
    get current() {
      return current;
    },
    get canUndo() {
      return stack.length > 0;
    },
    sessions: () => [current, ...stack],
    set(next, undoPoint) {
      if (undoPoint) {
        stack.push(undoPoint);
        if (stack.length > MAX_UNDO) stack.shift();
      }
      current = next;
      scheduleSave();
    },
    undo() {
      const prev = stack.pop() ?? null;
      if (prev) {
        current = prev;
        scheduleSave();
      }
      return prev;
    },
    async clear() {
      stack.length = 0;
      current = emptySession();
      pending = true;
      await flush();
    },
    flush,
  };
}
