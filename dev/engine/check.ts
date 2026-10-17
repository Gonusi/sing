// [engine] Engine check: `node dev/engine/check.ts [chromium|webkit|all]` (default all).
// Starts Vite (free port), opens dev/engine/index.html headless, drives the REAL engine modules with the test mic
// (sine tones injected at exact context times) and the fake analysis from dev/engine/fake-analysis.ts.
// Assertions read the controller/scheduler log. Prints a PASS/FAIL table; exits 1 on any failure.
//
// Scenarios: a first take · b overdub · c state table · g holds + state at tDown · d persistence (reload) ·
//            e calibration loopback · f 15 s / 4 tracks exactness · f2 tiny loop · j on/off catch-up ·
//            l interruption · h probe level · i capture tap frame accuracy · k real getUserMedia (Chromium only)
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
    e.gesture({ type: 'tap', tDown: stopT });
    const startAt = e.now();
    await e.waitUntil(stopT + 2 * 2.4 + 0.2);
    e.command({ type: 'stop' });
    const wav = e.c.lastTakeWav();
    return { t0, stopT, startAt, notes, mid, wavBytes: wav?.size ?? 0, sampleRate: e.sampleRate, session: e.c.session, events: e.events.filter((x) => x.t >= t0 - 0.001) };
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
  check('a7 lastTakeWav: 16-bit WAV of pre-roll + take', Math.abs(wavSec - wantSec) < 0.03, `${d.wavBytes} bytes = ${wavSec.toFixed(3)} s, expected ≈ ${wantSec.toFixed(3)} s`);
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
    first.offset > 0.02 && Math.abs(first.offset - (d.startAt - first.when)) < 0.006 && sc.every((s) => s.heard >= d.stopT - 1e-6),
    first ? `cycle ${first.cycle} pos ${first.pos.toFixed(3)} offset ${ms(first.offset)} (start lag ${ms(d.startAt - first.when)})` : 'no events');
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
  const expected = 0.12 - d.outLat;
  check('e1 calibration with loopback 120 ms: ok, inLat = d − outLat (±5 ms)', d.result.ok && Math.abs(d.result.inLat - expected) < 0.005,
    `ok ${d.result.ok} matched ${d.result.matched} inLat ${ms(d.result.inLat)} expected ${ms(expected)} spread ${ms(d.result.spread)}`);
}

// ---------- f: 15 s with 4 tracks, every event exactly once ----------

function fourTrackSession(): Session {
  const L = 1.37;
  const note = (pos: number, dur: number, midi: number, i: number) => ({ pos, dur, midi, vel: 0.8, phrase: `p:${i}`, legatoNext: false });
  const kinds = ['kick', 'hat', 'snare', 'hat'] as const;
  return {
    v: 1,
    loopLength: L,
    selectedId: 'tv',
    tracks: [
      { id: 'td', kind: 'drums', on: true, take: { id: 'kd', notes: [], hits: Array.from({ length: 14 }, (_, k) => ({ pos: k * 0.1, kind: kinds[k % 4], vel: 0.8 })) } },
      { id: 'tv', kind: 'violin', on: true, take: { id: 'kv', hits: [], notes: [note(0, 0.4, 69, 0), note(0.45, 0.4, 71, 1), note(0.9, 0.4, 72, 2)] } },
      { id: 'ts', kind: 'synth', on: true, take: { id: 'ks', hits: [], notes: [note(0.1, 0.2, 60, 0), note(0.35, 0.2, 64, 1), note(0.6, 0.2, 67, 2), note(0.85, 0.2, 72, 3), note(1.2, 0.4, 67, 4)] } },
      { id: 'tb', kind: 'bass', on: true, take: { id: 'kb', hits: [], notes: [note(0, 0.6, 40, 0), note(0.7, 0.6, 43, 1)] } },
    ],
  };
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
    return { tOff, tOn, posOn, outLat: e.outLat(), events: e.events.filter((x) => x.t >= tOff - 0.001 && x.type === 'sched') };
  });
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

// ---------- h, i: probe and capture ----------

async function checkProbeCapture(page: Page): Promise<void> {
  const p = await page.evaluate(() => (window as unknown as W).__eng.probeLevel());
  check('h1 probe: −24 dBFS tone looped into the mic reads back (±15%)', Math.abs(p.level - p.expected) / p.expected < 0.15, `level ${p.level.toFixed(4)} expected ${p.expected.toFixed(4)}`);
  const c = await page.evaluate(() => (window as unknown as W).__eng.captureClick());
  check('i1 capture tap: click onset at its scheduled frame (±3 frames)', Math.abs(c.onsetFrame - c.expectedFrame) <= 3, `onset ${c.onsetFrame} expected ${c.expectedFrame} (${c.frames} frames)`);
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
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        check(`${name} (threw)`, false, e instanceof Error ? e.message.split('\n')[0] : String(e));
      }
    }
    await page.evaluate(() => (window as unknown as W).__eng.clearStore());
  } finally {
    await browser.close();
  }
}

const which = process.argv[2] ?? 'all';
const engines: Engine[] = which === 'all' ? ['chromium', 'webkit'] : [which as Engine];
const served = await startDev();
try {
  for (const e of engines) {
    try {
      await runEngine(e, served.url);
      current = e;
      if (e === 'chromium') await checkRealMic(served.url);
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
