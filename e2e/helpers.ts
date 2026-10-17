// [tester] Shared e2e helpers. Node side: URLs, fixtures + ground truth, boot, IndexedDB seed/read, log analysis
// (sched exactness, note matching). In-page flows (firstTake, overdub) run inside ONE page.evaluate each, so the
// timing between taps and injected audio is decided on the AudioContext clock, not by CDP round trips.
// Times are context seconds. Fixture URLs: /__fixtures/<name>.wav (served from dev/fixtures/out by page.route).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { DrumHit, InstrumentKind, LogEvent, Note, RawHit, RawNote, Session, Track } from '../src/types.ts';

export const ROOT = join(import.meta.dirname, '..');
export const FIXTURE_DIR = join(ROOT, 'dev/fixtures/out');
export const OUT_DIR = join(ROOT, 'e2e/out');
export const SESSION_KEY = 'sing.session.v1';

export function singUrl(query = 'test'): string {
  const base = process.env.SING_URL;
  if (!base) throw new Error('SING_URL not set (global setup did not run)');
  return query ? `${base}?${query}` : base;
}

// ---------- fixtures ----------

export interface GroundTruth {
  name: string;
  sampleRate: number;
  durationSec: number;
  notes: { t: number; dur: number; midi: number }[];
  hits: { t: number; kind: DrumHit['kind'] }[];
}

export function groundTruth(name: string): GroundTruth {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as GroundTruth;
}

export const fixtureUrl = (name: string): string => `/__fixtures/${name}.wav`;

/** serve /__fixtures/<path> from dev/fixtures/out/<path> */
export async function routeFixtures(target: Page | BrowserContext): Promise<void> {
  await target.route('**/__fixtures/**', async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split('/__fixtures/')[1] ?? '');
    const file = join(FIXTURE_DIR, rel);
    if (rel.includes('..') || !existsSync(file)) return route.fulfill({ status: 404, body: `no fixture ${rel}` });
    return route.fulfill({ path: file, contentType: rel.endsWith('.json') ? 'application/json' : 'audio/wav' });
  });
}

// ---------- boot ----------

const errorLists = new WeakMap<Page, string[]>();

/** console errors + page errors of this page since the first call (idempotent) */
export function watchErrors(page: Page): string[] {
  let list = errorLists.get(page);
  if (list) return list;
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  errorLists.set(page, errors);
  list = errors;
  return list;
}

export interface BootOptions {
  /** URL query without '?' (default 'test'); '' = the real app */
  query?: string;
  /** written to IndexedDB before the start tap, so the app restores it */
  seed?: Session;
  /** navigate first (false: the page is already at the app, e.g. after reload) */
  navigate?: boolean;
}

/** goto the app, tap the start screen, wait for window.__sing (only with ?test) */
export async function boot(page: Page, opts: BootOptions = {}): Promise<string[]> {
  const errors = watchErrors(page);
  await routeFixtures(page);
  const query = opts.query ?? 'test';
  if (opts.navigate !== false) await page.goto(singUrl(query));
  if (opts.seed) await idbPut(page, SESSION_KEY, opts.seed);
  await page.locator('.start').click();
  await expect(page.locator('.stage')).toBeVisible({ timeout: 30_000 });
  if (query.split('&').includes('test')) await page.waitForFunction(() => !!window.__sing, null, { timeout: 30_000 });
  return errors;
}

// ---------- IndexedDB (idb-keyval's default store: db 'keyval-store', object store 'keyval') ----------

export async function idbPut(page: Page, key: string, value: unknown): Promise<void> {
  await page.evaluate(
    ([k, v]) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('keyval-store');
        req.onupgradeneeded = () => req.result.createObjectStore('keyval');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put(v, k as string);
          tx.oncomplete = () => (db.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
    [key, value] as const,
  );
}

export async function idbGet<T>(page: Page, key: string): Promise<T | undefined> {
  return page.evaluate(
    (k) =>
      new Promise<unknown>((resolve, reject) => {
        const req = indexedDB.open('keyval-store');
        req.onupgradeneeded = () => req.result.createObjectStore('keyval');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readonly');
          const get = tx.objectStore('keyval').get(k);
          get.onsuccess = () => (db.close(), resolve(get.result));
          get.onerror = () => reject(get.error);
        };
      }),
    key,
  ) as Promise<T | undefined>;
}

// ---------- in-page flows ----------

export interface FirstTakeRun {
  t0: number;
  /** context time the fixture's first sample entered the mic */
  at: number;
  stopT: number;
  /** inLat the take used (from its 'take start' log event) */
  inLat: number;
  trackId: string;
  L: number;
}

/**
 * idle → tap (tDown t0) → fixture injected at t0 + lead → stop tap at t0 + L (released 100 ms later) → playing.
 * `kind`: create + select an empty lane of that kind first (else the controller picks/creates a synth lane).
 */
export async function firstTake(
  page: Page,
  o: { fixture: string; L: number; lead?: number; from?: number; dur?: number; kind?: InstrumentKind },
): Promise<FirstTakeRun> {
  return page.evaluate(async (o) => {
    const s = window.__sing!;
    const url = `/__fixtures/${o.fixture}.wav`;
    await s.mic.load(url);
    if (o.kind && !s.command({ type: 'create', kind: o.kind })) throw new Error(`create ${o.kind} refused`);
    const t0 = s.now();
    const at = await s.mic.play(url, t0 + (o.lead ?? 0.1), { from: o.from, dur: o.dur });
    await s.waitUntil(t0 + 0.1);
    s.gesture({ type: 'tap', tDown: t0 });
    const start = s.logSince(t0).find((e) => e.type === 'take' && e.data?.phase === 'start');
    if (!start) throw new Error(`no take start (state ${s.state()})`);
    const stopT = t0 + o.L;
    await s.waitUntil(stopT + 0.1);
    s.gesture({ type: 'tap', tDown: stopT });
    return {
      t0, at, stopT, inLat: Number(start.data!.inLat), trackId: String(start.data!.trackId), L: s.session().loopLength ?? 0,
    };
  }, o);
}

export interface OverdubRun {
  ts: number;
  at: number;
  trackId: string;
  inLat: number;
  /** 'commit' or 'discard' */
  phase: string;
  /** context time the take event was logged */
  endLoggedAt: number;
}

/**
 * playing → (create + select an empty `kind` lane) → tap at ts → fixture at ts + lead → wait for the window-end
 * commit (or discard). Throws if nothing happens within L + 3 s.
 */
export async function overdub(
  page: Page,
  o: { kind: InstrumentKind; fixture: string; lead?: number; from?: number; dur?: number; create?: boolean },
): Promise<OverdubRun> {
  return page.evaluate(async (o) => {
    const s = window.__sing!;
    const url = `/__fixtures/${o.fixture}.wav`;
    await s.mic.load(url);
    if (o.create !== false && !s.command({ type: 'create', kind: o.kind })) throw new Error(`create ${o.kind} refused in ${s.state()}`);
    const ts = s.now();
    const at = await s.mic.play(url, ts + (o.lead ?? 0.1), { from: o.from, dur: o.dur });
    await s.waitUntil(ts + 0.1);
    s.gesture({ type: 'tap', tDown: ts });
    const start = s.logSince(ts).find((e) => e.type === 'take' && e.data?.phase === 'start' && e.data?.mode === 'overdub');
    if (!start) throw new Error(`no overdub start (state ${s.state()})`);
    const trackId = String(start.data!.trackId);
    const L = s.session().loopLength ?? 0;
    const deadline = ts + L + 3;
    for (;;) {
      const end = s.logSince(ts).find(
        (e) => e.type === 'take' && (e.data?.phase === 'commit' || e.data?.phase === 'discard') && e.data?.trackId === trackId,
      );
      if (end) return { ts, at, trackId, inLat: Number(start.data!.inLat), phase: String(end.data!.phase), endLoggedAt: end.t };
      if (s.now() > deadline) throw new Error(`overdub ${trackId} neither committed nor discarded by ${deadline.toFixed(2)}`);
      await s.waitUntil(s.now() + 0.05);
    }
  }, o);
}

export const now = (page: Page): Promise<number> => page.evaluate(() => window.__sing!.now());
export const waitCtx = (page: Page, t: number): Promise<number> => page.evaluate((t) => window.__sing!.waitUntil(t), t);
export const sleepCtx = (page: Page, sec: number): Promise<number> =>
  page.evaluate((sec) => window.__sing!.waitUntil(window.__sing!.now() + sec), sec);
export const getLog = (page: Page): Promise<LogEvent[]> => page.evaluate(() => window.__sing!.log());
export const getSession = (page: Page): Promise<Session> => page.evaluate(() => window.__sing!.session());
export const getState = (page: Page): Promise<string> => page.evaluate(() => window.__sing!.state());

// ---------- log analysis ----------

export interface Sched {
  trackId: string;
  kind: InstrumentKind;
  pos: number;
  cycle: number;
  heard: number;
  when: number;
  at: number;
  offset: number;
  outLat: number;
  reason?: string;
}

export const ofType = (log: LogEvent[], type: string): LogEvent[] => log.filter((e) => e.type === type);
export const scheds = (log: LogEvent[]): Sched[] => ofType(log, 'sched').map((e) => e.data as unknown as Sched);
export const drops = (log: LogEvent[]): Sched[] => ofType(log, 'drop').map((e) => e.data as unknown as Sched);
export const occKey = (trackId: string, pos: number, cycle: number): string => `${trackId}|${pos.toFixed(5)}|${cycle}`;

export function duplicates(list: Sched[]): string[] {
  const seen = new Set<string>();
  const d: string[] = [];
  for (const s of list) {
    const k = occKey(s.trackId, s.pos, s.cycle);
    if (seen.has(k)) d.push(k);
    seen.add(k);
  }
  return d;
}

export const trackEvents = (t: Track): (Note | DrumHit)[] => (t.take ? (t.kind === 'drums' ? t.take.hits : t.take.notes) : []);

export interface Exactness {
  runs: number;
  /** required occurrences (heard in the run's scheduled range, outside the start's late zone) */
  required: number;
  missing: string[];
  /** sched/drop occurrences that no event of the final session explains */
  extra: string[];
  dups: string[];
  played: number;
  dropped: number;
}

/**
 * For every transport run (start … stop) in the log: the set of (track, pos, cycle) in sched ∪ drop must equal every
 * occurrence heard in [max(from, activeFrom), scheduledUntil[track]) of every event of `session`, each exactly once.
 * Occurrences heard inside the start's late zone (before start.at + outLat + dur) may be skipped silently (the
 * scheduler does not enumerate events the late rules drop anyway); they count only if present.
 * Assumes tracks stayed on during each run and their takes only grew (overdub lanes).
 */
export function exactness(log: LogEvent[], session: Session): Exactness {
  const out: Exactness = { runs: 0, required: 0, missing: [], extra: [], dups: [], played: 0, dropped: 0 };
  for (let i = 0; i < log.length; i++) {
    const st = log[i];
    if (st.type !== 'transport' || st.data?.action !== 'start') continue;
    const j = log.findIndex((e, k) => k > i && e.type === 'transport' && (e.data?.action === 'stop' || e.data?.action === 'start'));
    if (j < 0 || log[j].data?.action !== 'stop') continue;
    out.runs++;
    const origin = Number(st.data.origin);
    const L = Number(st.data.loopLength);
    const from = Number(st.data.from);
    const startAt = Number(st.data.at);
    const until = log[j].data!.scheduledUntil as Record<string, number>;
    const run = log.slice(i + 1, j);
    const activeFrom = new Map<string, number>();
    for (const e of run) {
      if (e.type === 'take' && e.data?.phase === 'start' && e.data?.mode === 'overdub') activeFrom.set(String(e.data.trackId), Number(e.data.start) + L);
    }
    const got = [...scheds(run), ...drops(run)];
    out.played += scheds(run).length;
    out.dropped += drops(run).length;
    out.dups.push(...duplicates(got));
    const gotKeys = new Set(got.map((s) => occKey(s.trackId, s.pos, s.cycle)));
    const explained = new Set<string>();
    for (const t of session.tracks) {
      const hi = until[t.id];
      if (hi === undefined) continue;
      const lo = Math.max(from, activeFrom.get(t.id) ?? -Infinity) - 1e-6;
      for (const ev of trackEvents(t)) {
        const dur = 'dur' in ev ? ev.dur : 0;
        for (let k = Math.floor((lo - origin - ev.pos) / L) - 1; origin + ev.pos + k * L < hi; k++) {
          const heard = origin + ev.pos + k * L;
          if (heard < lo) continue;
          const key = occKey(t.id, ev.pos, k);
          explained.add(key);
          const lateZone = heard < startAt + (got[0]?.outLat ?? 0.05) + Math.max(dur, 0.02) + 0.005;
          if (lateZone && !gotKeys.has(key)) continue;
          out.required++;
          if (!gotKeys.has(key)) out.missing.push(`${key} heard ${heard.toFixed(3)}`);
        }
      }
    }
    for (const s of got) {
      const key = occKey(s.trackId, s.pos, s.cycle);
      if (!explained.has(key)) out.extra.push(key);
    }
  }
  return out;
}

/** largest |when − (origin + pos + cycle·L − outLat)| over the sched events of every run */
export function worstWhenError(log: LogEvent[]): number {
  let worst = 0;
  let origin = 0;
  let L = 0;
  for (const e of log) {
    if (e.type === 'transport' && e.data?.action === 'start') {
      origin = Number(e.data.origin);
      L = Number(e.data.loopLength);
    }
    if (e.type !== 'sched') continue;
    const s = e.data as unknown as Sched;
    worst = Math.max(worst, Math.abs(s.when - (origin + s.pos + s.cycle * L - s.outLat)));
  }
  return worst;
}

// ---------- note / hit matching ----------

export interface NoteMatch {
  matched: number;
  expected: number;
  /** expected notes with no detection within tol (any pitch) */
  missed: string[];
  /** matched in time but a different semitone */
  wrongPitch: string[];
  /** detections that matched nothing */
  extra: number;
  /** signed onset errors (detected − expected) of the matched notes, seconds */
  errors: number[];
}

/** greedy nearest-onset matching of detections to expectations (both in the same clock) */
export function matchNotes(det: { t: number; midi: number }[], exp: { t: number; midi: number }[], tol: number): NoteMatch {
  const used = new Set<number>();
  const r: NoteMatch = { matched: 0, expected: exp.length, missed: [], wrongPitch: [], extra: 0, errors: [] };
  for (const e of exp) {
    let best = -1;
    for (let i = 0; i < det.length; i++) {
      if (used.has(i) || Math.abs(det[i].t - e.t) > tol) continue;
      if (best < 0 || Math.abs(det[i].t - e.t) < Math.abs(det[best].t - e.t)) best = i;
    }
    if (best < 0) {
      r.missed.push(`${e.midi}@${e.t.toFixed(3)}`);
      continue;
    }
    used.add(best);
    if (Math.round(det[best].midi) !== e.midi) {
      r.wrongPitch.push(`${e.midi}@${e.t.toFixed(3)} got ${det[best].midi.toFixed(2)}@${det[best].t.toFixed(3)}`);
      continue;
    }
    r.matched++;
    r.errors.push(det[best].t - e.t);
  }
  r.extra = det.length - used.size;
  return r;
}

export function matchHits(det: RawHit[], exp: { t: number; kind: string }[], tol: number): NoteMatch & { wrongKind: string[] } {
  const used = new Set<number>();
  const r = { matched: 0, expected: exp.length, missed: [] as string[], wrongPitch: [] as string[], wrongKind: [] as string[], extra: 0, errors: [] as number[] };
  for (const e of exp) {
    let best = -1;
    for (let i = 0; i < det.length; i++) {
      if (used.has(i) || Math.abs(det[i].t - e.t) > tol) continue;
      if (best < 0 || Math.abs(det[i].t - e.t) < Math.abs(det[best].t - e.t)) best = i;
    }
    if (best < 0) {
      r.missed.push(`${e.kind}@${e.t.toFixed(3)}`);
      continue;
    }
    used.add(best);
    r.matched++;
    r.errors.push(det[best].t - e.t);
    if (det[best].kind !== e.kind) r.wrongKind.push(`${e.kind}@${e.t.toFixed(3)} got ${det[best].kind}`);
  }
  r.extra = det.length - used.size;
  return r;
}

export const maxAbs = (xs: number[]): number => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
export const ms = (x: number): string => `${(x * 1000).toFixed(1)} ms`;
export const rawNotes = (xs: RawNote[]): { t: number; midi: number }[] => xs.map((n) => ({ t: n.t, midi: n.midi }));
