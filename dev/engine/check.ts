// [engine] Engine check: `node dev/engine/check.ts [chromium|webkit|all]` (default all).
// Starts Vite (free port), opens dev/engine/index.html headless, drives the REAL engine modules with the test mic
// (sine tones injected at exact context times) and the fake analysis from dev/engine/fake-analysis.ts.
// Assertions read the controller/scheduler log. Prints a PASS/FAIL table; exits 1 on any failure.
//
// Scenarios: a first take · b overdub · c state table · g holds + state at tDown · d persistence (reload) ·
//            e calibration loopback · f 15 s / 4 tracks exactness · f2 tiny loop · j on/off catch-up ·
//            l interruption · h probe level · i capture tap frame accuracy + limiter delay · k real getUserMedia (Chromium) ·
//            r REAL analysis (src/analysis) on dsp's fixtures: first take, overdub, drum overdub, window edges
// Needs dsp's fixtures: `node dev/make-fixtures.ts` (writes dev/fixtures/out/, gitignored). ONLY=r,f runs a subset.
import type { Page } from '@playwright/test';
import type { LogEvent, Session } from '../../src/types.ts';
import type { Eng } from './page.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDev } from '../lib/serve.ts';
import { launch, type Engine } from '../lib/browser.ts';
import { encodeWav16 } from '../../src/audio/wav-encode.ts';

interface Row {
  engine: Engine;
  check: string;
  pass: boolean;
  detail: string;
}

interface Sched {
  trackId: string;
  kind: string;
  pos: number;
  cycle: number;
  heard: number;
  when: number;
  at: number;
  offset: number;
  outLat: number;
}

const rows: Row[] = [];
let current: Engine = 'chromium';
const ms = (x: number) => `${(x * 1000).toFixed(2)} ms`;
function check(name: string, pass: boolean, detail: string): void {
  rows.push({ engine: current, check: name, pass, detail });
}

// ---------- in-page helpers (serialised into the page) ----------

type W = { __eng: Eng };

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(`${url}dev/engine/index.html`);
  await page.click('#start');
  await page.waitForFunction(() => {
    const e = (window as unknown as W).__eng;
    return e?.booted || e?.error;
  }, null, { timeout: 20000 });
  const err = await page.evaluate(() => (window as unknown as W).__eng.error);
  if (err) throw new Error(`boot failed: ${err}`);
}

const scheds = (events: LogEvent[]): Sched[] => events.filter((e) => e.type === 'sched').map((e) => e.data as unknown as Sched);
const key = (s: Sched) => `${s.trackId}|${s.pos.toFixed(5)}|${s.cycle}`;
function duplicates(list: Sched[]): string[] {
  const seen = new Set<string>();
  const d: string[] = [];
  for (const s of list) {
    const k = key(s);
    if (seen.has(k)) d.push(k);
    seen.add(k);
  }
  return d;
}

// ---------- a: first take ----------

async function checkFirstTake(page: Page): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    await e.c.clearSession();
    await e.c.setDevice({ inLat: 0.01 });
    const inLat = 0.01;
    const notes: [number, number, number][] = [[0.05, 0.5, 60], [0.8, 0.3, 64], [1.3, 0.4, 67], [1.9, 0.3, 72]];
    const t0 = e.now();
    e.gesture({ type: 'tap', tDown: t0 });
    for (const [p, dur, m] of notes) e.tone(t0 + p + inLat, m, dur);
    const stopT = t0 + 2.4;
    await e.waitUntil(t0 + 2.1); // mid-take: 3 notes final, the 4th (1.9 + 0.3) being sung
    const before = e.now();
    const v = e.c.view();
    const mid = { state: v.state, rec: v.recordingTrackId, live: v.liveNotes.map((n) => n.pos), open: v.openNote, elapsed: v.elapsed, before, after: e.now(), loopPos: v.loopPos };
    await e.waitUntil(stopT + 0.15); // the tap is released 150 ms after touch-down
    const startBefore = e.now();
    e.gesture({ type: 'tap', tDown: stopT });
    const startAt = e.now();
    await e.waitUntil(stopT + 2 * 2.4 + 0.2);
    e.command({ type: 'stop' });
    const wav = e.c.lastTakeWav();
    return { t0, stopT, startBefore, startAt, notes, mid, wavBytes: wav?.size ?? 0, sampleRate: e.sampleRate, session: e.c.session, events: e.events.filter((x) => x.t >= t0 - 0.001) };
  });
  const m = d.mid;
  const elapsed = m.elapsed ?? -1;
  const viewOk = {
    state: m.state === 'recordingFirst',
    lane: m.rec === d.session.tracks[0]?.id,
    live: m.live.length === 3 && Math.abs(m.live[2] - 1.3) < 0.003,
    open: !!m.open && Math.abs(m.open.pos - 1.9) < 0.003 && Math.abs(m.open.midi - 72) < 0.1,
    elapsed: elapsed >= m.before - d.t0 - 1e-6 && elapsed <= m.after - d.t0 + 1e-6,
    loopPos: m.loopPos === null,
  };
  check('a0 view mid-take: state, recording lane, live notes, open note, elapsed', Object.values(viewOk).every(Boolean),
    `${Object.entries(viewOk).filter(([, ok]) => !ok).map(([k]) => `${k} wrong; `).join('')}live ${m.live.map((p) => p.toFixed(3)).join(',')} open ${m.open ? `${m.open.pos.toFixed(3)}/${m.open.midi.toFixed(2)}` : 'null'} elapsed ${elapsed.toFixed(3)}`);
  // raw audio = pre-roll (from t0 + inLat − 0.2, or the context's first frame) up to the last block before the stop ran
  const wavSec = (d.wavBytes - 44) / 2 / d.sampleRate;
  const wantSec = d.startAt - Math.max(0, d.t0 + 0.01 - 0.2);
  // the last block lags currentTime by ≤ 1 block + message delay + a 512-frame clock step
  check('a7 lastTakeWav: 16-bit WAV of pre-roll + take', Math.abs(wavSec - wantSec) < 0.045, `${d.wavBytes} bytes = ${wavSec.toFixed(3)} s, expected ≈ ${wantSec.toFixed(3)} s`);
  const L = d.session.loopLength ?? 0;
  check('a1 first take L = tap difference', Math.abs(L - (d.stopT - d.t0)) < 0.001, `L=${L.toFixed(6)} expected ${(d.stopT - d.t0).toFixed(6)}`);
  const track = d.session.tracks[0];
  const got = track?.take?.notes ?? [];
  const posErr = d.notes.map(([p], i) => Math.abs((got[i]?.pos ?? -9) - p));
  const midiOk = d.notes.every(([, , m], i) => got[i]?.midi === m);
  check('a2 take notes at sung positions (±3 ms), right midi', got.length === d.notes.length && Math.max(...posErr) < 0.003 && midiOk,
    `n=${got.length} max pos err ${ms(Math.max(...posErr))} midi ${got.map((n) => n.midi).join(',')}`);
  const start = d.events.find((e) => e.type === 'transport' && e.data?.action === 'start')?.data as { origin: number; from: number } | undefined;
  check('a3 scheduler.start(origin = t0, L, from = tDown of stop)', !!start && Math.abs(start.origin - d.t0) < 1e-9 && Math.abs(start.from - d.stopT) < 1e-9,
    `origin=${start?.origin} t0=${d.t0} from=${start?.from}`);
  const sc = scheds(d.events).filter((s) => s.trackId === track?.id);
  const worst = Math.max(0, ...sc.map((s) => Math.abs(s.when - (d.t0 + s.pos + s.cycle * L - s.outLat))));
  const lateOk = sc.every((s) => (s.offset > 0 ? true : Math.abs(s.at - s.when) < 1e-9 || s.at > s.when));
  check('a4 every event at origin + pos + k·L − outLat (±2 ms)', sc.length > 0 && worst < 0.002 && lateOk, `${sc.length} events, worst ${ms(worst)}`);
  const sorted = [...sc].sort((x, y) => x.heard - y.heard);
  const first = sorted[0];
  check('a5 first cycle after stop: pos 0.05 caught up with offset', !!first && first.cycle === 1 && Math.abs(first.pos - got[0].pos) < 1e-9 &&
    // currentTime moves in render-callback steps (Chromium headless: 512 frames), so bracket the stop handler
    first.offset > 0.02 && first.offset >= d.startBefore - first.when - 1e-6 && first.offset <= d.startAt - first.when + 1e-6 && sc.every((s) => s.heard >= d.stopT - 1e-6),
    first ? `cycle ${first.cycle} pos ${first.pos.toFixed(3)} offset ${ms(first.offset)} (stop handled ${ms(d.startBefore - first.when)}..${ms(d.startAt - first.when)} late)` : 'no events');
  const dups = duplicates(sc);
  const stop = d.events.find((e) => e.type === 'transport' && e.data?.action === 'stop')?.data as { scheduledUntil: Record<string, number> } | undefined;
  const until = stop?.scheduledUntil[track?.id ?? ''] ?? 0;
  const expected = new Set<string>();
  for (const n of got) for (let k = 1; k < 5; k++) {
    const heard = d.t0 + n.pos + k * L;
    if (heard >= d.stopT - 1e-6 && heard < until) expected.add(`${track.id}|${n.pos.toFixed(5)}|${k}`);
  }
  const actual = new Set(sc.map(key));
  const missing = [...expected].filter((k) => !actual.has(k));
  const extra = [...actual].filter((k) => !expected.has(k));
  check('a6 each occurrence exactly once (no dup, none missing)', dups.length === 0 && missing.length === 0 && extra.length === 0,
    `${actual.size}/${expected.size} dup ${dups.length} missing ${missing.length} extra ${extra.length}`);
}

// ---------- b: overdub ----------

async function checkOverdub(page: Page): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    await e.c.clearSession();
    await e.c.setDevice({ inLat: 0.03 });
    const inLat = 0.03;
    const L = 2.0;
    const t0 = e.now();
    e.gesture({ type: 'tap', tDown: t0 });
    e.tone(t0 + 0.1 + inLat, 62, 0.4);
    e.tone(t0 + 1.0 + inLat, 65, 0.4);
    await e.waitUntil(t0 + L + 0.1);
    e.gesture({ type: 'tap', tDown: t0 + L });
    e.command({ type: 'create', kind: 'violin' });
    const violinId = e.c.session.selectedId;
    await e.sleep(0.2);
    // the overdub tap is at ts (in the near future, so a note can start before it); released 50 ms later
    const ts = e.now() + 0.5;
    const sung: { name: string; tc: number; dur: number; midi: number }[] = [
      { name: 'early (clipped to ts)', tc: ts - 0.3, dur: 0.6, midi: 69 },
      { name: 'n1', tc: ts + 0.5, dur: 0.25, midi: 71 },
      { name: 'n2', tc: ts + 1.0, dur: 0.25, midi: 72 },
      { name: 'n3', tc: ts + 1.4, dur: 0.2, midi: 74 },
      { name: 'open at end (force-closed)', tc: ts + L - 0.25, dur: 0.6, midi: 76 },
    ];
    for (const n of sung) e.tone(n.tc + inLat, n.midi, n.dur); // the mic hears it inLat late
    await e.waitUntil(ts + 0.05);
    e.gesture({ type: 'tap', tDown: ts });
    const stateAfterTap = e.c.state;
    await e.waitUntil(ts + L + inLat + 0.15 + 0.05);
    const stateAfterWindow = e.c.state;
    await e.sleep(0.8);
    e.command({ type: 'stop' });
    return { t0, L, ts, inLat, sung, violinId, stateAfterTap, stateAfterWindow, session: e.c.session, events: e.events.filter((x) => x.t >= t0 - 0.001) };
  });
  const mod = (x: number) => ((x % d.L) + d.L) % d.L;
  const violin = d.session.tracks.find((t) => t.id === d.violinId);
  const got = [...(violin?.take?.notes ?? [])];
  const want = d.sung.map((n) => {
    const start = Math.max(n.tc, d.ts);
    const end = Math.min(n.tc + n.dur, d.ts + d.L);
    return { name: n.name, pos: mod(start - d.t0), dur: end - start, midi: n.midi };
  });
  const errs = want.map((w) => {
    const g = got.find((n) => n.midi === w.midi);
    return g ? Math.max(Math.abs(g.pos - w.pos), Math.abs(g.dur - w.dur)) : Infinity;
  });
  check('b0 tap → overdubbing, window end → playing', d.stateAfterTap === 'overdubbing' && d.stateAfterWindow === 'playing', `${d.stateAfterTap} → ${d.stateAfterWindow}`);
  check('b1 overdub notes at their loop positions (±15 ms, incl. clipped + force-closed)', got.length === want.length && Math.max(...errs) < 0.015,
    `n=${got.length}/${want.length} worst ${ms(Math.max(...errs))}: ${want.map((w, i) => `${w.name} ${ms(errs[i])}`).join('; ')}`);
  const vs = scheds(d.events).filter((s) => s.trackId === d.violinId);
  const early = vs.filter((s) => s.heard < d.ts + d.L - 1e-6);
  check('b2 new lane silent until ts + L, then plays', early.length === 0 && vs.length >= 3, `${early.length} events before ts+L, ${vs.length} after`);
  const commit = d.events.find((e) => e.type === 'take' && e.data?.phase === 'commit' && e.data?.mode === 'overdub');
  const firstV = [...vs].sort((x, y) => x.heard - y.heard)[0];
  const firstLog = d.events.find((e) => e.type === 'sched' && (e.data as unknown as Sched).trackId === d.violinId);
  check('b3 pending notes scheduled before the commit (first at ts + L)', !!commit && !!firstV && Math.abs(firstV.heard - (d.ts + d.L)) < 0.001 && !!firstLog && firstLog.t < commit.t,
    `first violin heard at ts+L${firstV ? `+${ms(firstV.heard - d.ts - d.L)}` : '?'}, scheduled at ${firstLog?.t.toFixed(3)} commit at ${commit?.t.toFixed(3)}`);
  check('b4 no duplicate events', duplicates(scheds(d.events)).length === 0, `${scheds(d.events).length} events`);
}

// ---------- c: state table walk ----------

async function checkStateTable(page: Page): Promise<void> {
  const res = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    const out: { step: string; state: string; lanes: number; loop: number | null; accepted: boolean | null; loopPos: number | null }[] = [];
    const snap = (step: string, accepted: boolean | null = null) =>
      out.push({ step, state: e.c.state, lanes: e.c.session.tracks.length, loop: e.c.session.loopLength, accepted, loopPos: e.c.view().loopPos });
    const inLat = 0.01;
    const tap = () => e.gesture({ type: 'tap', tDown: e.now() });
    await e.c.clearSession();
    await e.c.setDevice({ inLat });
    snap('clear');
    snap('idle: undo (nothing)', e.command({ type: 'undo' }));
    snap('idle: create drums', e.command({ type: 'create', kind: 'drums' }));
    tap();
    snap('idle: tap');
    snap('recordingFirst: undo', e.command({ type: 'undo' }));
    tap();
    await e.sleep(0.5);
    tap();
    snap('recordingFirst: tap after 0.5 s (too short)');
    const t0 = e.now();
    tap();
    e.burst(t0 + 0.3 + inLat, 100);
    await e.sleep(1.2);
    tap();
    snap('recordingFirst: tap after 1.2 s');
    tap();
    snap('playing: tap');
    snap('overdubbing: create synth', e.command({ type: 'create', kind: 'synth' }));
    snap('overdubbing: record', e.command({ type: 'record' }));
    snap('overdubbing: undo', e.command({ type: 'undo' }));
    const ts = e.now();
    tap();
    e.burst(ts + 0.1 + inLat, 1000);
    await e.sleep(0.4);
    tap();
    snap('overdubbing: tap after 0.4 s (commit so far)');
    snap('playing: stop', e.command({ type: 'stop' }));
    snap('stopped: play', e.command({ type: 'play' }));
    snap('playing: stop again', e.command({ type: 'stop' }));
    snap('stopped: record', e.command({ type: 'record' }));
    const origin = e.c.scheduler.origin ?? e.now();
    e.burst(origin + 0.2 + inLat, 6000);
    await e.waitUntil(origin + 0.5);
    snap('overdubbing: stop (commit so far)', e.command({ type: 'stop' }));
    snap('stopped: undo', e.command({ type: 'undo' }));
    tap();
    snap('stopped: tap');
    snap('playing: undo', e.command({ type: 'undo' }));
    snap('playing: undo (first take)', e.command({ type: 'undo' }));
    snap('idle: undo (create)', e.command({ type: 'undo' }));
    snap('idle: play', e.command({ type: 'play' }));
    return { out, changes: e.changes, errors: e.events.filter((x) => x.type === 'error').map((x) => String(x.data?.message)) };
  });
  const { out: steps } = res;
  check('c3 onChange fired; refused create/record logged as errors', res.changes > 10 && res.errors.includes('create while overdubbing') && res.errors.includes('record while overdubbing'),
    `${res.changes} changes; errors: ${res.errors.join(', ')}`);
  const want: [string, number, boolean | null][] = [
    ['idle', 0, null], ['idle', 0, false], ['idle', 1, true], ['recordingFirst', 1, null], ['idle', 1, true], ['idle', 1, null],
    ['playing', 1, null], ['overdubbing', 2, null], ['overdubbing', 2, false], ['overdubbing', 2, false], ['playing', 1, true],
    ['playing', 2, null], ['stopped', 2, true], ['playing', 2, true], ['stopped', 2, true], ['overdubbing', 3, true], ['stopped', 3, true],
    ['stopped', 2, true], ['playing', 2, null], ['playing', 1, true], ['idle', 1, true], ['idle', 0, true], ['idle', 0, false],
  ];
  const bad = steps.map((s, i) => ({ s, w: want[i] })).filter(({ s, w }) => !w || s.state !== w[0] || s.lanes !== w[1] || (w[2] !== null && s.accepted !== w[2]));
  check('c1 state table walk (state, lanes, accepted)', bad.length === 0 && steps.length === want.length,
    bad.length ? bad.map(({ s, w }) => `${s.step}: got ${s.state}/${s.lanes}/${s.accepted} want ${w?.join('/')}`).join('; ') : `${steps.length} steps`);
  const loopL = steps[6].loop ?? 0;
  check('c2 L from the 1.2 s take; loopPos null when stopped, set when playing', Math.abs(loopL - 1.2) < 0.02 && steps[12].loopPos === null && steps[13].loopPos !== null,
    `L=${loopL.toFixed(3)} stopped loopPos=${steps[12].loopPos} playing loopPos=${steps[13].loopPos?.toFixed(3)}`);
}

// ---------- g: holds (exclusion) and commands read against the state at tDown ----------

async function checkHolds(page: Page): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    await e.c.clearSession();
    await e.c.setDevice({ inLat: 0.01 });
    const inLat = 0.01;
    const t0 = e.now();
    e.gesture({ type: 'tap', tDown: t0 });
    e.tone(t0 + 0.2 + inLat, 60, 0.3); // A kept
    e.tone(t0 + 0.55 + inLat, 62, 0.5); // C cut at the hold start (t0 + 0.8)
    e.tone(t0 + 1.15 + inLat, 64, 0.3); // B inside the hold: dropped
    e.tone(t0 + 1.8 + inLat, 65, 0.3); // D after the hold: kept
    const tH = t0 + 0.8;
    await e.waitUntil(tH + 0.3);
    e.gesture({ type: 'holdStart', tDown: tH });
    await e.waitUntil(t0 + 1.6);
    e.gesture({ type: 'holdEnd', tDown: tH, tUp: t0 + 1.6 });
    const toggled = e.command({ type: 'toggle', kind: 'violin', on: false }, tH);
    const stateAfterHold = e.c.state;
    await e.waitUntil(t0 + 2.4 + 0.05);
    e.gesture({ type: 'tap', tDown: t0 + 2.4 });
    const firstNotes = e.c.session.tracks[0]?.take?.notes ?? [];
    // state at tDown: hold starts just before the overdub window ends; the command arrives after the commit
    e.command({ type: 'create', kind: 'bass' });
    const bassId = e.c.session.selectedId;
    const L = e.c.session.loopLength ?? 0;
    const ts = e.now();
    e.gesture({ type: 'tap', tDown: ts });
    e.tone(ts + 0.3 + inLat, 45, 0.3);
    const tH2 = ts + L - 0.1;
    await e.waitUntil(tH2 + 0.3);
    e.gesture({ type: 'holdStart', tDown: tH2 });
    const bassTakeBefore = e.c.session.tracks.find((t) => t.id === bassId)?.take?.notes.length ?? null;
    const stateBefore = e.c.state;
    const accepted = e.command({ type: 'undo' }, tH2);
    e.gesture({ type: 'holdEnd', tDown: tH2, tUp: e.now() });
    const bassTakeAfter = e.c.session.tracks.find((t) => t.id === bassId)?.take ?? null;
    const cmdLog = [...e.events].reverse().find((x) => x.type === 'command');
    e.command({ type: 'stop' });
    return { t0, firstNotes, toggled, stateAfterHold, bassTakeBefore, stateBefore, accepted, bassTakeAfter, stateNow: e.c.state, cmdLog };
  });
  const want = [{ pos: 0.2, dur: 0.3, midi: 60 }, { pos: 0.55, dur: 0.25, midi: 62 }, { pos: 1.8, dur: 0.3, midi: 65 }];
  const errs = want.map((w) => {
    const g = d.firstNotes.find((n) => n.midi === w.midi);
    return g ? Math.max(Math.abs(g.pos - w.pos), Math.abs(g.dur - w.dur)) : Infinity;
  });
  check('g1 hold during a take: command applied, take continues', d.toggled === true && d.stateAfterHold === 'recordingFirst', `toggle accepted ${d.toggled}, state ${d.stateAfterHold}`);
  check('g2 audio from hold tDown to release dropped; open note cut at tDown', d.firstNotes.length === 3 && Math.max(...errs) < 0.006 && !d.firstNotes.some((n) => n.midi === 64),
    `notes ${d.firstNotes.map((n) => `${n.midi}@${n.pos.toFixed(3)}/${n.dur.toFixed(3)}`).join(' ')}`);
  check('g3 undo read against overdubbing at tDown undoes the take committed meanwhile', d.stateBefore === 'playing' && d.bassTakeBefore === 1 &&
    d.accepted === true && d.bassTakeAfter === null && d.stateNow === 'stopped' && d.cmdLog?.data?.stateAtTDown === 'overdubbing',
    `before: ${d.stateBefore}, bass notes ${d.bassTakeBefore}; undo accepted ${d.accepted}, read as ${String(d.cmdLog?.data?.stateAtTDown)}, bass take after ${JSON.stringify(d.bassTakeAfter)}`);
}

// ---------- d: persistence ----------

async function checkPersistence(page: Page, url: string): Promise<void> {
  const before = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    await e.c.flush();
    return { session: e.c.session, inLat: e.c.device.inLat };
  });
  await boot(page, url);
  const after = await page.evaluate(() => {
    const e = (window as unknown as W).__eng;
    return { session: e.c.session, state: e.c.state, inLat: e.c.device.inLat };
  });
  const same = JSON.stringify(before.session) === JSON.stringify(after.session);
  check('d1 reload → session + device restored, state stopped', same && after.state === (before.session.loopLength ? 'stopped' : 'idle') && after.inLat === before.inLat && before.session.tracks.length > 0,
    `tracks ${after.session.tracks.length}, loop ${after.session.loopLength?.toFixed(3)}, state ${after.state}, inLat ${after.inLat}`);
}

// ---------- e: calibration with a loopback delay ----------

async function checkCalibration(page: Page): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    if (e.c.state === 'playing' || e.c.state === 'overdubbing') e.command({ type: 'stop' });
    return e.calibrateLoopback(0.12);
  });
  const expected = 0.12 - d.outLat + d.limiterDelay;
  check('e1 calibration with loopback 120 ms: ok, inLat = d − (outLat − limiter delay) (±5 ms)', d.result.ok && Math.abs(d.result.inLat - expected) < 0.005,
    `ok ${d.result.ok} matched ${d.result.matched} inLat ${ms(d.result.inLat)} expected ${ms(expected)} spread ${ms(d.result.spread)}`);
}

// ---------- f: 15 s with 4 tracks, every event exactly once ----------

function fourTrackSession(): Session {
  const L = 1.37;
  const note = (pos: number, dur: number, midi: number, i: number, phrase = `p:${i}`, legatoNext = false) => ({ pos, dur, midi, vel: 0.8, phrase, legatoNext });
  const kinds = ['kick', 'hat', 'snare', 'hat'] as const;
  return {
    v: 1,
    loopLength: L,
    selectedId: 'tv',
    tracks: [
      { id: 'td', kind: 'drums', on: true, take: { id: 'kd', notes: [], hits: Array.from({ length: 14 }, (_, k) => ({ pos: k * 0.1, kind: kinds[k % 4], vel: 0.8 })) } },
      // violin and bass: legato phrases (gaps < 120 ms), so the hand-over margin can be checked
      { id: 'tv', kind: 'violin', on: true, take: { id: 'kv', hits: [], notes: [note(0, 0.4, 69, 0, 'kv:0', true), note(0.45, 0.4, 71, 1, 'kv:0', true), note(0.9, 0.4, 72, 2, 'kv:0')] } },
      { id: 'ts', kind: 'synth', on: true, take: { id: 'ks', hits: [], notes: [note(0.1, 0.2, 60, 0), note(0.35, 0.2, 64, 1), note(0.6, 0.2, 67, 2), note(0.85, 0.2, 72, 3), note(1.2, 0.4, 67, 4)] } },
      { id: 'tb', kind: 'bass', on: true, take: { id: 'kb', hits: [], notes: [note(0, 0.6, 40, 0, 'kb:0', true), note(0.7, 0.6, 43, 1, 'kb:0')] } },
    ],
  };
}

/** instruments: a legato continuation must be handed to the voice before the previous note's end + 0.25 s */
const LEGATO_HANDOVER_SEC = 0.25;

/** min over continuations of (previous note's end + 0.25 s) − hand-over time (log t); Infinity when none */
function legatoMargin(events: LogEvent[], session: Session): { min: number; n: number } {
  let min = Infinity;
  let n = 0;
  const logged = events.filter((e) => e.type === 'sched').map((e) => ({ t: e.t, s: e.data as unknown as Sched }));
  for (const tr of session.tracks) {
    const notes = tr.take?.notes ?? [];
    notes.forEach((prev, i) => {
      if (!prev.legatoNext || i + 1 >= notes.length) return;
      const next = notes[i + 1];
      for (const c of logged.filter((x) => x.s.trackId === tr.id && x.s.pos === next.pos)) {
        const p = logged.find((x) => x.s.trackId === tr.id && x.s.pos === prev.pos && x.s.cycle === c.s.cycle);
        if (!p) continue;
        min = Math.min(min, p.s.when + prev.dur + LEGATO_HANDOVER_SEC - c.t);
        n++;
      }
    });
  }
  return { min, n };
}

async function checkLongRun(page: Page, url: string): Promise<void> {
  const session = fourTrackSession();
  await page.evaluate((s) => (window as unknown as W).__eng.writeSession(s), session);
  await boot(page, url);
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    const restoredState = e.c.state;
    const t = e.now();
    e.command({ type: 'play' });
    await e.sleep(15);
    e.command({ type: 'stop' });
    await e.sleep(0.1);
    return { restoredState, events: e.events.filter((x) => x.t >= t) };
  });
  const start = d.events.find((e) => e.type === 'transport' && e.data?.action === 'start')?.data as { origin: number; loopLength: number; from: number };
  const stop = d.events.find((e) => e.type === 'transport' && e.data?.action === 'stop')?.data as { scheduledUntil: Record<string, number> };
  const L = session.loopLength!;
  const expected = new Set<string>();
  for (const tr of session.tracks) {
    const evs = tr.kind === 'drums' ? tr.take!.hits : tr.take!.notes;
    for (const ev of evs) for (let k = -1; k < 20; k++) {
      const heard = start.origin + ev.pos + k * L;
      if (heard >= start.from - 1e-6 && heard < stop.scheduledUntil[tr.id]) expected.add(`${tr.id}|${ev.pos.toFixed(5)}|${k}`);
    }
  }
  const sc = scheds(d.events);
  const actual = new Set(sc.map(key));
  const dups = duplicates(sc);
  const missing = [...expected].filter((k) => !actual.has(k));
  const extra = [...actual].filter((k) => !expected.has(k));
  const drops = d.events.filter((e) => e.type === 'drop').length;
  const late = sc.filter((s) => s.offset > 0 || s.at > s.when + 1e-9).length;
  const lm = legatoMargin(d.events, session);
  check('f3 legato continuations handed over before previous end + 0.25 s', lm.n > 10 && lm.min > 0, `${lm.n} continuations, min margin ${ms(lm.min)}`);
  check('f1 15 s, 4 tracks, L=1.37: count = expected, no dup/missing/extra', d.restoredState === 'stopped' && dups.length === 0 && missing.length === 0 && extra.length === 0 && expected.size > 250,
    `${sc.length} scheduled / ${expected.size} expected; dup ${dups.length} missing ${missing.length} extra ${extra.length}; drops ${drops}, late ${late}`);
}

async function checkTinyLoop(page: Page): Promise<void> {
  const d = await page.evaluate(() => (window as unknown as W).__eng.tinyLoop(0.05, 2));
  const L = 0.05;
  let expected = 0;
  for (const p of d.positions) for (let k = 0; k < 200; k++) {
    const heard = d.from + p + k * L;
    if (heard >= d.from - 1e-6 && heard < d.until) expected++;
  }
  const keys = new Set(d.events.map((s) => `${s.pos.toFixed(6)}|${s.cycle}`));
  check('f2 L = 50 ms (< lookahead window): every occurrence once', d.plays === expected && keys.size === d.events.length && expected > 100,
    `${d.plays} plays, ${expected} expected, ${d.events.length - keys.size} dup`);
}

// ---------- j: on/off ramps and catch-up on switch-on ----------

async function checkToggle(page: Page): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    e.command({ type: 'play' });
    await e.sleep(0.5);
    const tOff = e.now();
    e.c.toggleTrack('tb');
    await e.sleep(1.5);
    // switch on while bass note 0 (pos 0..0.6) is being heard at pos 0.15..0.4
    const pos = () => e.c.scheduler.pos(e.now()) ?? 0;
    while (!(pos() > 0.15 && pos() < 0.4)) await e.sleep(0.005);
    const posOn = pos();
    const tOn = e.now();
    e.c.toggleTrack('tb');
    await e.sleep(1);
    e.command({ type: 'stop' });
    return { tOff, tOn, posOn, outLat: e.outLat(), session: e.c.session, events: e.events.filter((x) => x.t >= tOff - 0.001 && x.type === 'sched') };
  });
  // the caught-up bass note 0 is legato into note 1: that continuation must still reach the voice in time
  const lm = legatoMargin(d.events.filter((e) => e.t >= d.tOn - 1e-6), d.session);
  check('j2 catch-up path: legato continuation still handed over in time', lm.n > 0 && lm.min > 0, `${lm.n} continuations, min margin ${ms(lm.min)}`);
  const bass = d.events.filter((e) => (e.data as unknown as Sched).trackId === 'tb');
  const whileOff = bass.filter((e) => e.t > d.tOff + 1e-6 && e.t < d.tOn - 1e-6);
  const catchUp = bass.map((e) => e.data as unknown as Sched).find((s) => s.pos === 0 && s.offset > 0);
  check('j1 off: nothing scheduled; on: sounding note resumes with offset', whileOff.length === 0 && !!catchUp && Math.abs(catchUp.offset - (d.posOn + catchUp.outLat)) < 0.02,
    `${whileOff.length} while off; catch-up offset ${catchUp ? ms(catchUp.offset) : 'none'} (pos at on ${ms(d.posOn)} + outLat)`);
}

// ---------- l: interruption (suspend → the engine resumes, scheduler resyncs) ----------

async function checkLifecycle(page: Page): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    const t = e.now();
    e.command({ type: 'play' });
    await e.sleep(0.6);
    await e.suspendBriefly();
    await e.sleep(1);
    e.command({ type: 'stop' });
    return e.events.filter((x) => x.t >= t);
  });
  const life = d.filter((e) => e.type === 'lifecycle').map((e) => String(e.data?.event));
  const resync = d.some((e) => e.type === 'transport' && e.data?.action === 'resync');
  const sc = scheds(d);
  check('l1 suspend → interrupted/resumed, scheduler resync, no duplicates', life.includes('interrupted') && life.includes('resumed') && resync && duplicates(sc).length === 0 && sc.length > 20,
    `lifecycle ${life.join(',')}; resync ${resync}; ${sc.length} events, dup ${duplicates(sc).length}`);
}

// ---------- k: the real getUserMedia path (Chromium fake capture from a WAV) ----------

async function checkRealMic(url: string): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const wavPath = path.join(dir, 'fake-mic-440.wav');
  const sr = 48000;
  const x = new Float32Array(sr * 4).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));
  fs.writeFileSync(wavPath, encodeWav16(x, sr));
  const browser = await launch('chromium', { fakeMicWav: wavPath });
  try {
    const page = await browser.newPage();
    await page.goto(`${url}dev/engine/index.html?real`);
    await page.click('#start');
    await page.waitForFunction(() => {
      const e = (window as unknown as W).__eng;
      return e?.booted || e?.error;
    }, null, { timeout: 20000 });
    const d = await page.evaluate(async () => {
      const e = (window as unknown as W).__eng;
      if (e.error) return { error: e.error, rms: 0, real: false, latency: null as number | null };
      await e.sleep(0.8);
      return { error: null, rms: e.ringRms(0.5), real: e.realMic, latency: e.mic.reportedLatency() };
    });
    check('k1 real getUserMedia → worklet → ring (fake-capture WAV, 0.5 sine)', !d.error && d.real && d.rms > 0.2,
      d.error ? d.error.split('\n')[0] : `ring RMS ${d.rms.toFixed(3)} (sine 0.5 → 0.354), reported latency ${d.latency}`);
  } finally {
    await browser.close();
  }
}

// ---------- r: the REAL analysis (src/analysis) on dsp's fixtures, incl. the window edges ----------

interface Truth {
  notes: { t: number; dur: number; midi: number }[];
  hits: { t: number; kind: string }[];
}

/** fixture notes overlapping fixture window [w0, w1) (a note may start up to `early` before w0), clipped */
function expectNotes(truth: Truth, w0: number, w1: number, early: number) {
  return truth.notes
    .filter((n) => n.t < w1 && n.t + n.dur > w0 && n.t >= w0 - early)
    .map((n) => ({ start: Math.max(n.t, w0), end: Math.min(n.t + n.dur, w1), midi: n.midi, clipped: n.t < w0, closed: n.t + n.dur > w1 }));
}

async function checkRealAnalysis(page: Page, url: string): Promise<void> {
  await page.goto(`${url}dev/engine/index.html?analysis=real`);
  await page.click('#start');
  await page.waitForFunction(() => {
    const e = (window as unknown as W).__eng;
    return e?.booted || e?.error;
  }, null, { timeout: 20000 });
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    if (e.error) throw new Error(e.error);
    await e.c.clearSession();
    const inLat = 0.02;
    await e.c.setDevice({ inLat });
    const cmaj = await e.loadFixture('sing-cmaj');
    const beat = await e.loadFixture('beatbox-basic');
    // r1 first take: fixture second 0.6 = t0 (the C4 at 0.5 starts in the pre-roll → clipped), stop inside F4 (5.265)
    const A = 0.6;
    const t0 = e.now() + 0.8;
    e.injectFixture('sing-cmaj', 0, 5.6, t0 - A + inLat);
    await e.waitUntil(t0 + 0.05);
    e.gesture({ type: 'tap', tDown: t0 });
    const stop = t0 + 4.8;
    await e.waitUntil(stop + 0.15);
    e.gesture({ type: 'tap', tDown: stop });
    const first = e.c.session.tracks[0];
    // r2 overdub (new synth lane): window = fixture [4.9, 9.7): G4 (4.593) starts 0.31 s before ts → clipped; A4 (9.176) is open at the end
    const S = 4.9;
    const ts = e.now() + 1.0;
    e.injectFixture('sing-cmaj', 4.1, 10.2, ts - (S - 4.1) + inLat);
    await e.waitUntil(ts + 0.05);
    e.gesture({ type: 'tap', tDown: ts });
    const lane2 = e.c.session.selectedId;
    await e.waitUntil(ts + 4.8 + inLat + 0.15 + 0.2);
    const state2 = e.c.state;
    // r3 drum overdub into a new drums lane: first hit 20 ms after ts; tap-commit 30 ms after the last hit (released 60 ms later)
    e.command({ type: 'create', kind: 'drums' });
    const lane3 = e.c.session.selectedId;
    const B = 0.48;
    const ts3 = e.now() + 0.6;
    e.injectFixture('beatbox-basic', 0.2, 5.1, ts3 - (B - 0.2) + inLat);
    await e.waitUntil(ts3 + 0.05);
    e.gesture({ type: 'tap', tDown: ts3 });
    const end3 = ts3 + (5.03 - B);
    await e.waitUntil(end3 + 0.06);
    e.gesture({ type: 'tap', tDown: end3 });
    const state3 = e.c.state;
    await e.sleep(0.2);
    e.command({ type: 'stop' });
    return {
      micStats: e.mic.stats(),
      inLat, A, t0, stop, S, ts, B, ts3, end3, state2, state3, cmaj, beat,
      session: e.c.session, firstId: first?.id ?? null, lane2, lane3,
      events: e.events.filter((x) => x.t >= t0 - 0.001 && (x.type === 'sched' || x.type === 'take')),
    };
  });
  console.log(`[r] mic stats ${JSON.stringify(d.micStats)}`);
  const L = d.session.loopLength ?? 0;
  const mod = (x: number) => ((x % L) + L) % L;
  const notesOf = (id: string | null) => d.session.tracks.find((t) => t.id === id)?.take?.notes ?? [];
  const tol = 0.03;

  // r1
  const want1 = expectNotes(d.cmaj, d.A, d.A + 4.8, Infinity).map((n) => ({ ...n, pos: n.start - d.A, endPos: n.end - d.A }));
  const got1 = notesOf(d.firstId);
  const err1 = want1.map((w, i) => (got1[i] && got1[i].midi === w.midi ? Math.abs(got1[i].pos - w.pos) : Infinity));
  const edge1 = got1.length > 0 && Math.abs(got1[0].pos) < 0.001 && Math.abs(got1[got1.length - 1].pos + got1[got1.length - 1].dur - L) < tol;
  check('r1 real analysis, first take: all notes ±30 ms, midi exact, start clip + end force-close', Math.abs(L - 4.8) < 0.001 && got1.length === want1.length && Math.max(...err1) <= tol && edge1,
    `L=${L.toFixed(3)} n=${got1.length}/${want1.length} worst ${ms(Math.max(...err1))} midi ${got1.map((n) => n.midi).join(',')} last end ${got1.length ? ms(got1[got1.length - 1].pos + got1[got1.length - 1].dur - L) : '-'}`);

  // r2
  const want2 = expectNotes(d.cmaj, d.S, d.S + L, 0.5).map((n) => ({ ...n, pos: mod(d.ts + n.start - d.S - d.t0), dur: n.end - n.start }));
  const got2 = notesOf(d.lane2);
  const match2 = want2.map((w) => got2.find((g) => g.midi === w.midi && Math.abs(mod(g.pos - w.pos + L / 2) - L / 2) <= tol));
  const err2 = want2.map((w, i) => (match2[i] ? Math.abs(mod(match2[i]!.pos - w.pos + L / 2) - L / 2) : Infinity));
  const c0 = want2.findIndex((w) => w.clipped);
  const cN = want2.findIndex((w) => w.closed);
  const edge2 = c0 >= 0 && cN >= 0 && !!match2[c0] && Math.abs(match2[c0]!.dur - want2[c0].dur) < tol && !!match2[cN] && Math.abs(match2[cN]!.dur - want2[cN].dur) < tol;
  check('r2 real analysis, overdub: all notes ±30 ms, midi exact, clipped first + force-closed last kept', d.state2 === 'playing' && got2.length === want2.length && Math.max(...err2) <= tol && edge2,
    `n=${got2.length}/${want2.length} worst ${ms(Math.max(...err2))}; clipped dur ${match2[c0]?.dur.toFixed(3)}/${want2[c0]?.dur.toFixed(3)} closed dur ${match2[cN]?.dur.toFixed(3)}/${want2[cN]?.dur.toFixed(3)}`);
  const commit2 = d.events.find((e) => e.type === 'take' && e.data?.phase === 'commit' && e.data?.trackId === d.lane2);
  const sched2 = d.events.filter((e) => e.type === 'sched' && (e.data as unknown as Sched).trackId === d.lane2);
  const early2 = sched2.filter((e) => (e.data as unknown as Sched).heard < d.ts + L - 1e-6).length;
  check('r3 real analysis, overdub: pending notes play from ts + L, before the commit', !!commit2 && sched2.length > 0 && early2 === 0 && sched2[0].t < commit2.t,
    `${sched2.length} sched, ${early2} before ts+L, first scheduled ${sched2[0]?.t.toFixed(3)} commit ${commit2?.t.toFixed(3)}`);

  // r4
  const want3 = d.beat.hits.filter((h) => h.t >= d.B && h.t < 5.03).map((h) => ({ pos: mod(d.ts3 + h.t - d.B - d.t0), kind: h.kind }));
  console.log(`[r4] window starts at pos ${mod(d.ts3 - d.t0).toFixed(3)}, tap at pos ${mod(d.end3 - d.t0).toFixed(3)}`);
  const got3 = d.session.tracks.find((t) => t.id === d.lane3)?.take?.hits ?? [];
  const err3 = want3.map((w) => {
    const g = got3.find((h) => Math.abs(mod(h.pos - w.pos + L / 2) - L / 2) <= tol);
    return g && g.kind === w.kind ? Math.abs(mod(g.pos - w.pos + L / 2) - L / 2) : Infinity;
  });
  check('r4 real analysis, drum overdub: all hits ±30 ms, right kind, first (20 ms after ts) and last (30 ms before tap) kept', d.state3 === 'playing' && got3.length === want3.length && Math.max(...err3) <= tol,
    `n=${got3.length}/${want3.length} worst ${ms(Math.max(...err3))}` +
    (err3.some((e) => e === Infinity) ? `; missing/wrong: ${want3.filter((_, i) => err3[i] === Infinity).map((w) => `${w.kind}@${w.pos.toFixed(3)}`).join(' ')}; got ${got3.map((h) => `${h.kind[0]}@${h.pos.toFixed(3)}`).join(' ')}` : ''));
}

// ---------- v: vocal takes (raw audio), seams, persistence; echo bus ----------

async function checkVocals(page: Page, url: string): Promise<void> {
  const d = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    await e.c.clearSession();
    const inLat = 0.02;
    await e.c.setDevice({ inLat });
    e.c.setEcho(0);
    const sr = e.sampleRate;
    const X = Math.round(0.02 * sr);
    const PRE = 0.3;
    /** best lag (samples) of loop[q] vs src[idx(q) + lag] over the sample positions qs */
    const align = (loop: Float32Array, src: Float32Array, idx: (q: number) => number, qs: number[]) => {
      let best = { lag: 0, err: Infinity };
      for (let lag = -240; lag <= 240; lag++) {
        let err = 0;
        let n = 0;
        for (const q of qs) {
          const i = idx(q) + lag;
          if (i < 0 || i >= src.length) continue;
          err += Math.abs(loop[q] - src[i]);
          n++;
        }
        if (n && err / n < best.err) best = { lag, err: err / n };
      }
      return best;
    };
    const spread = (from: number, to: number, skip: (q: number) => boolean) => {
      const qs: number[] = [];
      for (let k = 0; k < 3000; k++) {
        const q = Math.floor(from + ((to - from) * (k + 0.5)) / 3000);
        if (!skip(q)) qs.push(q);
      }
      return qs;
    };
    const nonzero = (p: number[] | null) => (p ?? []).filter((v) => v > 0).length;

    // v1: vocal FIRST take (sets L); noise A starts 0.3 s before t0
    e.command({ type: 'create', kind: 'vocals' });
    const lane1 = e.c.session.selectedId!;
    const t0 = e.now() + 0.5;
    const A = e.noise(11, Math.round(3.0 * sr));
    e.injectSamples(A, t0 - PRE + inLat);
    await e.waitUntil(t0 + 0.05);
    e.gesture({ type: 'tap', tDown: t0 });
    await e.waitUntil(t0 + 1.2);
    const live1 = nonzero(e.c.view().livePeaks);
    await e.waitUntil(t0 + 2.4 + 0.15);
    e.gesture({ type: 'tap', tDown: t0 + 2.4 });
    const L = e.c.session.loopLength!;
    const Ls = Math.round(L * sr);
    const buf1 = e.c.vocalAudio(lane1);
    const loop1 = buf1?.getChannelData(0) ?? new Float32Array(0);
    // the record-start beep's 80 ms exclusion sits right after pos 0 (zeroed by design): compare from 0.25 s on
    const a1 = align(loop1, A, (q) => q + Math.round(PRE * sr), spread(Math.round(0.25 * sr), Ls, () => false));
    let tailSame = loop1.length === Ls + X;
    for (let k = 0; k < X && tailSame; k++) tailSame = loop1[Ls + k] === loop1[k];
    const peaks1 = e.c.session.tracks.find((t) => t.id === lane1)?.take?.peaks ?? [];

    // v2: vocal OVERDUB into a new vocals lane (the selected one has a take); noise B from ts − 0.3
    const origin = e.c.scheduler.origin!;
    const ts = e.now() + 0.8;
    const B = e.noise(22, Math.round((L + 0.8) * sr));
    e.injectSamples(B, ts - PRE + inLat);
    await e.waitUntil(ts + 0.05);
    e.gesture({ type: 'tap', tDown: ts });
    const lane2 = e.c.session.selectedId!;
    await e.waitUntil(ts + 1.2);
    const live2 = nonzero(e.c.view().livePeaks);
    await e.waitUntil(ts + L + inLat + 0.05 + 0.2);
    const ps = Math.round((((ts - origin) % L) + L) % L * sr) % Ls;
    const loop2 = e.c.vocalAudio(lane2)?.getChannelData(0) ?? new Float32Array(0);
    const a2 = align(loop2, B, (q) => ((q - ps + Ls) % Ls) + Math.round(PRE * sr), spread(0, Ls, (q) => ((q - ps + Ls) % Ls) < X));
    const first2 = e.events.find((x) => x.type === 'sched' && (x.data as { trackId?: string }).trackId === lane2)?.data as { at: number; outLat: number; offset: number; heard: number } | undefined;

    // v3: sine overdub (330 Hz, phase jump at both seams) → seams must be click-free in the lane's output
    const ts3 = e.now() + 0.8;
    const n3 = Math.round((L + 0.8) * sr);
    const sine = new Float32Array(n3).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / sr));
    e.injectSamples(sine, ts3 - PRE + inLat);
    await e.waitUntil(ts3 + 0.05);
    e.gesture({ type: 'tap', tDown: ts3 });
    const lane3 = e.c.session.selectedId!;
    await e.waitUntil(ts3 + L + inLat + 0.05 + 0.3);
    const cap = await e.captureNode(e.c.voiceOutput(lane3)!, L + 0.4);
    const ps3 = Math.round((((ts3 - origin) % L) + L) % L * sr) % Ls;
    const ol = e.outLat();
    const seams: number[] = [];
    for (let k = -2; k < 40; k++) for (const off of [0, ps3]) {
      const f = Math.round((origin + k * L - ol) * sr) + off - cap.frame;
      if (f > 0.03 * sr && f < cap.pcm.length - 0.03 * sr) seams.push(f);
    }
    const W = Math.round(0.025 * sr);
    let seamJump = 0;
    let steadyJump = 0;
    for (let i = 1; i < cap.pcm.length; i++) {
      const j = Math.abs(cap.pcm[i] - cap.pcm[i - 1]);
      if (seams.some((f) => Math.abs(i - f) <= W)) seamJump = Math.max(seamJump, j);
      else steadyJump = Math.max(steadyJump, j);
    }
    e.command({ type: 'stop' });

    // v5 prep: checksums of all vocal audio, echo setting
    const sum = (id: string) => {
      const b = e.c.vocalAudio(id);
      if (!b) return null;
      let s = 0;
      const x = b.getChannelData(0);
      for (let i = 0; i < x.length; i++) s += Math.abs(x[i]) * ((i % 7) + 1);
      return `${x.length}:${s.toFixed(3)}`;
    };
    e.c.setEcho(0.37);
    await e.c.flush();
    return {
      sr, L, Ls, X, inLat, live1, live2, a1, a2, tailSame, peaks1, ts, first2, seams: seams.length, seamJump, steadyJump,
      sums: [lane1, lane2, lane3].map((id) => [id, sum(id)]), keys: await e.audioKeys(), micStats: e.mic.stats(),
    };
  });
  check('v1 vocal first take: audio = injected samples at the right offset (≤ 1 ms after inLat), tail = loop start, peaks',
    Math.abs(d.a1.lag) <= d.sr * 0.001 && d.a1.err < 1e-3 && d.tailSame && d.peaks1.length === 256 && d.peaks1.filter((p) => p > 0.3 && p <= 1).length >= 256 - 12,
    `mic gaps ${d.micStats.gaps} (${JSON.stringify(d.micStats.recent)}); lag ${d.a1.lag} samples, mean err ${d.a1.err.toExponential(1)}, tail copy ${d.tailSame}, peaks ${d.peaks1.length} (${d.peaks1.filter((p) => p <= 0.3).length} quiet bins: the beep exclusion)`);
  check('v2 vocal overdub: rotated audio = injected samples (≤ 1 ms), plays from the window end', Math.abs(d.a2.lag) <= d.sr * 0.001 && d.a2.err < 1e-3 &&
    !!d.first2 && d.first2.at + d.first2.outLat >= d.ts + d.L - 0.001 && d.first2.at + d.first2.outLat <= d.ts + d.L + 0.16,
    `lag ${d.a2.lag} samples, mean err ${d.a2.err.toExponential(1)}; first replay heard from ts+L+${d.first2 ? ms(d.first2.at + d.first2.outLat - d.ts - d.L) : '?'}`);
  const wantLive1 = (1.2 / 4) * 256;
  // first take: minus ≈ 5 bins of the beep exclusion (0.08 s of 4 s)
  check('v4 livePeaks: bins across max(elapsed, 4 s) for a first take, across L for an overdub', d.live1 >= wantLive1 - 9 && d.live1 <= wantLive1 + 3 && Math.abs(d.live2 - (1.2 / d.L) * 256) <= 4,
    `first take ${d.live1} bins (≈ ${wantLive1.toFixed(0)}), overdub ${d.live2} bins (≈ ${((1.2 / d.L) * 256).toFixed(0)})`);
  check('v3 seams click-free (sine with phase jumps): max sample jump at seams ≤ 1.2 × steady', d.seams >= 2 && d.steadyJump > 0.005 && d.seamJump <= 1.2 * d.steadyJump,
    `${d.seams} seams, jump ${d.seamJump.toFixed(4)} vs steady ${d.steadyJump.toFixed(4)}`);

  await boot(page, url);
  const after = await page.evaluate(async (ids) => {
    const e = (window as unknown as W).__eng;
    const sum = (id: string) => {
      const b = e.c.vocalAudio(id);
      if (!b) return null;
      let s = 0;
      const x = b.getChannelData(0);
      for (let i = 0; i < x.length; i++) s += Math.abs(x[i]) * ((i % 7) + 1);
      return `${x.length}:${s.toFixed(3)}`;
    };
    const out = { sums: ids.map((id) => [id, sum(id)]), echo: e.c.session.fx?.echo ?? null, keys: await e.audioKeys() };
    e.c.setEcho(0);
    return out;
  }, d.sums.map(([id]) => id as string));
  const same = JSON.stringify(after.sums) === JSON.stringify(d.sums);
  check('v5 reload: vocal audio restored bit-exact, echo restored, stored keys = referenced', same && after.echo === 0.37 && after.keys.length === 3 && d.sums.every(([, s]) => s !== null),
    `audio ${same ? 'same' : `differs ${JSON.stringify(after.sums)} vs ${JSON.stringify(d.sums)}`}, echo ${after.echo}, keys ${after.keys.length}`);
}

/** a late vocal start must play exactly the promised audio even when currentTime advances within the task */
async function checkLateVocalStart(page: Page): Promise<void> {
  const errs = await page.evaluate(() => (window as unknown as W).__eng.lateVocalStarts(20, 3));
  const off = errs.filter((e) => e !== 0);
  check('v8 late vocal start (3 ms of work after reading now): content at the promised frame in 20/20 starts', off.length === 0,
    `${errs.length - off.length}/${errs.length} exact${off.length ? `; off by ${off.join(',')} frames` : ''}`);
}

async function checkEcho(page: Page): Promise<void> {
  const run = (amount: number) => page.evaluate((a) => (window as unknown as W).__eng.echoProbe(a), amount);
  const dry = await run(0);
  const wet = await run(1);
  /** on the 2.5 ms RMS envelope (r.sampleRate = envelope frames per second) */
  const stats = (r: typeof dry) => {
    const n = (sec: number) => Math.round(sec * r.sampleRate);
    let ci = 0; // the direct click: envelope maximum in the first 0.3 s
    for (let i = 0; i < Math.min(r.pcm.length, n(0.3)); i++) if (r.pcm[i] > r.pcm[ci]) ci = i;
    let tailMax = 0;
    for (let i = ci + n(0.06); i < r.pcm.length; i++) tailMax = Math.max(tailMax, r.pcm[i]);
    let ri = ci + n(0.25);
    for (let i = ri; i < Math.min(r.pcm.length, ci + n(0.45)); i++) if (r.pcm[i] > r.pcm[ri]) ri = i;
    return { clickPeak: r.pcm[ci], tailMax, repeatAt: (ri - ci) / r.sampleRate, repeat: r.pcm[ri] };
  };
  const sd = stats(dry);
  const sw = stats(wet);
  check('v6 echo 0 = dry (no tail); echo 1 = a repeat at ≈ 0.33 s on master', sd.tailMax < 1e-4 && Math.abs(sw.repeatAt - 0.33) < 0.012 && sw.repeat > 0.05 * sw.clickPeak,
    `dry tail ${sd.tailMax.toExponential(1)}; wet repeat at ${ms(sw.repeatAt)} level ${(sw.repeat / sw.clickPeak).toFixed(2)} × click`);
  const c = await page.evaluate(async () => {
    const e = (window as unknown as W).__eng;
    e.c.setEcho(1);
    await e.sleep(0.3);
    const r = await e.calibrateLoopback(0.12);
    e.c.setEcho(0);
    return r;
  });
  const expected = 0.12 - c.outLat + c.limiterDelay;
  check('v7 calibration with echo 1 unaffected (clicks bypass the FX bus)', c.result.ok && Math.abs(c.result.inLat - expected) < 0.005,
    `ok ${c.result.ok} inLat ${ms(c.result.inLat)} expected ${ms(expected)} spread ${ms(c.result.spread)}`);
}

// ---------- h, i: probe and capture ----------

async function checkProbeCapture(page: Page): Promise<void> {
  const p = await page.evaluate(() => (window as unknown as W).__eng.probeLevel());
  check('h1 probe: −24 dBFS tone looped into the mic reads back (±15%)', Math.abs(p.level - p.expected) / p.expected < 0.15, `level ${p.level.toFixed(4)} expected ${p.expected.toFixed(4)}`);
  const c = await page.evaluate(() => (window as unknown as W).__eng.captureClick());
  check('i1 capture tap: click onset at its scheduled frame (±3 frames)', Math.abs(c.onsetFrame - c.expectedFrame) <= 3, `onset ${c.onsetFrame} expected ${c.expectedFrame} (${c.frames} frames)`);
  const l = await page.evaluate(() => (window as unknown as W).__eng.limiterDelay());
  const want = Math.round(0.006 * l.sampleRate);
  check('i2 limiter look-ahead = LIMITER_DELAY_SEC (6 ms, folded into outLat)', Math.abs(l.limiterFrame - l.masterFrame - want) <= 2,
    `${l.limiterFrame - l.masterFrame} frames, expected ${want}`);
}

// ---------- main ----------

async function runEngine(engine: Engine, url: string): Promise<void> {
  current = engine;
  const browser = await launch(engine);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[${engine} pageerror]`, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${engine} ${m.type()}]`, m.text());
  });
  try {
    await boot(page, url);
    await page.evaluate(() => (window as unknown as W).__eng.clearStore());
    await boot(page, url);
    const steps: [string, () => Promise<void>][] = [
      ['a', () => checkFirstTake(page)],
      ['b', () => checkOverdub(page)],
      ['c', () => checkStateTable(page)],
      ['g', () => checkHolds(page)],
      ['d', () => checkPersistence(page, url)],
      ['e', () => checkCalibration(page)],
      ['h', () => checkProbeCapture(page)],
      ['f', () => checkLongRun(page, url)],
      ['j', () => checkToggle(page)],
      ['l', () => checkLifecycle(page)],
      ['f2', () => checkTinyLoop(page)],
      ['v', () => checkVocals(page, url)],
      ['echo', () => checkEcho(page)],
      ['v8', () => checkLateVocalStart(page)],
    ];
    for (const [name, fn] of steps) {
      if (ONLY && !ONLY.includes(name)) continue;
      try {
        await fn();
      } catch (e) {
        check(`${name} (threw)`, false, e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    }
    try {
      if (!ONLY || ONLY.includes('r')) await checkRealAnalysis(page, url);
    } catch (e) {
      check('r (threw)', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    }
    await page.evaluate(() => (window as unknown as W).__eng.clearStore());
  } finally {
    await browser.close();
  }
}

const which = process.argv[2] ?? 'all';
/** ONLY=a,b,r runs just those scenarios (the steps' names above; r = real analysis, k = real mic) */
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const engines: Engine[] = which === 'all' ? ['chromium', 'webkit'] : [which as Engine];
const served = await startDev();
try {
  for (const e of engines) {
    try {
      await runEngine(e, served.url);
      current = e;
      if (e === 'chromium' && (!ONLY || ONLY.includes('k'))) await checkRealMic(served.url);
    } catch (err) {
      rows.push({ engine: e, check: 'boot', pass: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
} finally {
  await served.close();
}

const w = Math.max(...rows.map((r) => r.check.length));
console.log('');
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.engine.padEnd(8)}  ${r.check.padEnd(w)}  ${r.detail}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
