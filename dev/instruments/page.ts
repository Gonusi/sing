// [instruments] Dev check page: every instrument rendered offline (render.ts) and measured (analysis.ts).
// window.runInstrumentChecks() → { results, wavs } is called by dev/instruments/check.ts in Chromium and WebKit;
// the "Run checks" button does the same by hand and adds play buttons for listening.
import { setContext } from 'tone';
import { playBlip } from '../../src/instruments/blip.ts';
import { createVoice, preloadInstruments } from '../../src/instruments/index.ts';
import { loadViolinAssets } from '../../src/instruments/violin-assets.ts';
import type { DrumHit, DrumKind, InstrumentKind, Note, Sec, Voice } from '../../src/types.ts';
import * as A from './analysis.ts';
import { renderBlip, renderVoice, SR, type Act, type Feed } from './render.ts';

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface CheckRun {
  results: CheckResult[];
  /** rendered audio, name → base64 16-bit mono WAV */
  wavs: Record<string, string>;
  ms: number;
}

declare global {
  interface Window {
    runInstrumentChecks(): Promise<CheckRun>;
    runRealtimeSmoke(): Promise<CheckResult[]>;
  }
}

const results: CheckResult[] = [];
const wavs: Record<string, string> = {};
const pcms: Record<string, Float32Array> = {};

/** cents tolerance of a detected fundamental */
const PITCH_TOL = 30;
/** legato: the envelope never falls further than this below its median between onset and release */
const LEGATO_MAX_DIP_DB = 6;
/** legato: the level may not rise this much at an inner note boundary (that would be a new attack) */
const LEGATO_MAX_RISE_DB = 3;
/** largest sample jump / 99.9th percentile jump: above this there is a click */
const MAX_JUMP_RATIO = 3;
/** legato: 80–200 ms after a pitch change the previous pitch is at least this far below the new one (dB) */
const LEGATO_MAX_GHOST_DB = -12;
/** periodicity-break detector (analysis.ts): a steady bowed tone stays ≤ 0.2; a bow change or a click gives 0.4–1.1 */
const MAX_PERIODICITY_BREAK = 0.3;
/** the same inside a pitch transition (5 ms windows; calibrated against a hard sample switch, notes/instruments.md) */
const MAX_GLIDE_BREAK = 0.3;
/** stopAll: 30 ms after it the level is this far below the level before it */
const STOP_SILENCE_DB = 40;

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function keep(name: string, pcm: Float32Array): void {
  pcms[name] = pcm;
  wavs[name] = A.wavBase64(pcm, SR);
}

let phraseCounter = 0;
function note(midi: number, dur: Sec, o: { vel?: number; phrase?: string; legatoNext?: boolean } = {}): Note {
  return { pos: 0, dur, midi, vel: o.vel ?? 0.8, phrase: o.phrase ?? `check:${phraseCounter++}`, legatoNext: o.legatoNext ?? false };
}

function hit(kind: DrumKind, vel = 0.8): DrumHit {
  return { pos: 0, kind, vel };
}

/** consecutive notes of one phrase: each starts where the previous ends; legatoNext on all but the last */
function legatoFeeds(t0: Sec, notes: [midi: number, dur: Sec][], phrase: string, lastLegato = false): Feed[] {
  let t = t0;
  return notes.map(([midi, dur], i) => {
    const f = { ev: note(midi, dur, { phrase, legatoNext: lastLegato || i < notes.length - 1 }), when: t };
    t += dur;
    return f;
  });
}

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : String(v));
const errorsOf = (r: { errors: string[] }) => (r.errors.length ? ` · ERRORS ${r.errors.join('; ')}` : '');

// ---------- (a) pitch per note ----------

async function checkPitch(kind: InstrumentKind, midis: number[]): Promise<void> {
  const DUR = 0.6;
  const GAP = 0.25;
  const T0 = 0.2;
  const feeds = midis.map((m, i) => ({ ev: note(m, DUR), when: T0 + i * (DUR + GAP) }));
  const r = await renderVoice(kind, T0 + midis.length * (DUR + GAP) + 0.8, feeds);
  keep(`${kind}-notes`, r.pcm);
  const env = A.envelope(r.pcm, SR);
  const errs: number[] = [];
  const levels: number[] = [];
  for (const f of feeds) {
    const m = (f.ev as Note).midi;
    const hz = A.fundamental(r.pcm, SR, f.when + 0.15, f.when + DUR - 0.05, 440 * 2 ** ((m - 69) / 12));
    errs.push(hz ? A.cents(hz, m) : NaN);
    levels.push(A.rmsDb(r.pcm, SR, f.when + 0.15, f.when + DUR - 0.05));
  }
  const onset = A.onsetTime(env, T0 - 0.05, T0 + 0.3);
  const pass = errs.every((c) => Math.abs(c) <= PITCH_TOL) && r.errors.length === 0;
  record(
    `${kind}: pitch of ${midis.join(' ')}`,
    pass,
    `cents ${errs.map((c) => fmt(c, 0)).join(' ')} · note level ${levels.map((l) => fmt(l, 0)).join(' ')} dBFS · ` +
      `onset −20 dB at +${fmt(((onset ?? NaN) - T0) * 1000, 0)} ms · peak ${fmt(A.db(A.peak(r.pcm)))} dBFS${errorsOf(r)}`,
  );
}

// ---------- (b) violin legato, long note ----------

/** what makes a phrase legato, measured between its first onset (t0) and its last note's end */
interface LegatoStats {
  attacks: Sec[];
  dip: number;
  /** level rise at each inner note boundary */
  rises: number[];
  /** energy of the previous pitch relative to the new one, from 80 ms after each pitch change (dB) */
  ghosts: number[];
  /** periodicity-break detector over the sustained stretches (clicks) */
  breaks: { max: number; median: number; at: Sec };
  /** the same over the pitch transitions, with 5 ms windows (a glide changes the period within a 10 ms window) */
  glideBreaks: { max: number; median: number; at: Sec };
}

function hzOf(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** a pitch change counts as a transition from 10 ms before its note starts to TRANSITION after */
const TRANSITION: Sec = 0.08;

function legatoStats(pcm: Float32Array, feeds: Feed[], t0: Sec, end: Sec): LegatoStats {
  const env = A.envelope(pcm, SR);
  const midis = feeds.map((f) => (f.ev as Note).midi);
  const changes = feeds.slice(1).map((f, i) => ({ tb: f.when, from: midis[i], to: midis[i + 1] }));
  const inTransition = (t: Sec) => changes.find((c) => c.from !== c.to && t >= c.tb - 0.01 && t <= c.tb + TRANSITION);
  const noteAt = (t: Sec): [number, number] => {
    let k = 0;
    while (k + 1 < feeds.length && feeds[k + 1].when <= t) k++;
    return [hzOf(midis[k]), hzOf(midis[k])];
  };
  // sustained stretches: 10 ms windows at the note's pitch; transitions: 5 ms windows over the whole glide range
  const sustain = A.periodicityBreak(pcm, SR, t0 + 0.1, end - 0.02, (t) => (inTransition(t) ? [0, 0] : noteAt(t)));
  let glide = { max: 0, median: 0, at: 0 };
  for (const c of changes.filter((c) => c.from !== c.to)) {
    const range: [number, number] = [hzOf(Math.min(c.from, c.to)), hzOf(Math.max(c.from, c.to))];
    const b = A.periodicityBreak(pcm, SR, c.tb - 0.01, c.tb + TRANSITION, () => range, 0.005);
    if (b.max > glide.max) glide = b;
  }
  return {
    attacks: A.attacks(env),
    dip: A.maxDip(env, t0 + 0.1, end),
    rises: changes.map((c) => A.boundaryRise(env, c.tb)),
    ghosts: changes.filter((c) => c.from !== c.to).map((c) => ghost(pcm, c.tb, c.from, c.to)),
    breaks: sustain,
    glideBreaks: glide,
  };
}

/**
 * Energy of the old pitch relative to the new one from 80 ms after a pitch change (the glide is over). The window
 * is long enough that the two pitches' FFT main lobes do not overlap (Hann: ±2/T Hz), at least 120 ms.
 */
function ghost(pcm: Float32Array, tb: Sec, from: number, to: number): number {
  const window = Math.max(0.12, 5 / Math.abs(hzOf(to) - hzOf(from)));
  const t0 = tb + TRANSITION;
  return A.bandDb(pcm, SR, t0, t0 + window, hzOf(from)) - A.bandDb(pcm, SR, t0, t0 + window, hzOf(to));
}

function legatoOk(s: LegatoStats): boolean {
  return (
    s.attacks.length === 1 &&
    s.dip <= LEGATO_MAX_DIP_DB &&
    s.rises.every((v) => v < LEGATO_MAX_RISE_DB) &&
    s.ghosts.every((g) => g < LEGATO_MAX_GHOST_DB) &&
    s.breaks.max < MAX_PERIODICITY_BREAK &&
    s.glideBreaks.max < MAX_GLIDE_BREAK
  );
}

function legatoText(s: LegatoStats): string {
  return (
    `attacks ${s.attacks.length} (at ${s.attacks.map((t) => fmt(t, 2)).join(', ')}) · max dip ${fmt(s.dip)} dB · ` +
    `boundary rises ${s.rises.map((v) => fmt(v)).join(' ')} dB · old pitch after change ${s.ghosts.map((g) => fmt(g, 0)).join(' ')} dB · ` +
    `periodicity break: sustain max ${fmt(s.breaks.max, 3)} (median ${fmt(s.breaks.median, 3)}, at ${fmt(s.breaks.at, 3)} s), ` +
    `transitions max ${fmt(s.glideBreaks.max, 3)} (at ${fmt(s.glideBreaks.at, 3)} s)`
  );
}

async function checkLegato(kind: InstrumentKind, notes: [number, number][], name: string): Promise<void> {
  const T0 = 0.2;
  const feeds = legatoFeeds(T0, notes, `${name}:phrase`);
  feeds[3].arrive = feeds[3].when + 0.004; // handed over 4 ms late: `when` is already in the past
  const end = feeds[feeds.length - 1].when + notes[notes.length - 1][1];
  const r = await renderVoice(kind, end + 1.2, feeds);
  keep(name, r.pcm);
  const stats = legatoStats(r.pcm, feeds, T0, end);
  const errs = feeds.map((f, i) => {
    const m = (f.ev as Note).midi;
    const hz = A.fundamental(r.pcm, SR, f.when + 0.1, f.when + notes[i][1] - 0.03, hzOf(m));
    return hz ? A.cents(hz, m) : NaN;
  });
  record(
    `${kind}: legato phrase ${notes.map((n) => n[0]).join(' ')}`,
    legatoOk(stats) && errs.every((c) => Math.abs(c) <= PITCH_TOL) && r.errors.length === 0,
    `${legatoText(stats)} · cents ${errs.map((c) => fmt(c, 0)).join(' ')}${errorsOf(r)}`,
  );
}

/** a repeated pitch inside a phrase gets a portato dip (audible rhythm) without a new attack or a gap */
async function checkRepeat(kind: InstrumentKind, midi: number): Promise<void> {
  const T0 = 0.2;
  const notes: [number, number][] = [[midi, 0.5], [midi, 0.5], [midi + 3, 0.5]];
  const feeds = legatoFeeds(T0, notes, `${kind}:repeat`);
  const r = await renderVoice(kind, 2.6, feeds);
  keep(`${kind}-repeat`, r.pcm);
  const env = A.envelope(r.pcm, SR);
  const tb = feeds[1].when;
  const level = A.medianDb(env, T0 + 0.15, tb - 0.06);
  const dip = level - A.minDb(env, tb - 0.06, tb + 0.06);
  const atk = A.attacks(env);
  record(
    `${kind}: repeated pitch inside a phrase is articulated (portato dip, one attack)`,
    atk.length === 1 && dip >= 2 && dip < LEGATO_MAX_DIP_DB && r.errors.length === 0,
    `dip at the repeat ${fmt(dip)} dB · attacks ${atk.length}${errorsOf(r)}`,
  );
}

async function checkLongNote(midi: number, seconds: Sec): Promise<void> {
  const T0 = 0.1;
  const r = await renderVoice('violin', T0 + seconds + 1, [{ ev: note(midi, seconds), when: T0 }]);
  keep(`violin-long-${midi}`, r.pcm);
  const env = A.envelope(r.pcm, SR);
  const dip = A.maxDip(env, T0 + 0.3, T0 + seconds - 0.05);
  const jump = A.jumpRatio(r.pcm, SR, T0 + 0.2, T0 + seconds);
  const breaks = A.periodicityBreak(r.pcm, SR, T0 + 0.2, T0 + seconds - 0.02, () => [hzOf(midi), hzOf(midi)]);
  const atk = A.attacks(env);
  const pass =
    dip <= LEGATO_MAX_DIP_DB &&
    jump.ratio < MAX_JUMP_RATIO &&
    breaks.max < MAX_PERIODICITY_BREAK &&
    atk.length === 1 &&
    r.errors.length === 0;
  record(
    `violin: ${seconds} s note ${midi} (loops its sustain)`,
    pass,
    `max dip ${fmt(dip)} dB · max jump ${fmt(jump.ratio, 2)}× p99.9 · periodicity break max ${fmt(breaks.max, 3)} ` +
      `(median ${fmt(breaks.median, 3)}, at ${fmt(breaks.at, 3)} s) · attacks ${atk.length}${errorsOf(r)}`,
  );
}

/**
 * White box: every prepared sample is free of bow changes from its onset to its loop end, and its loop wraps
 * seamlessly (the last 100 ms before loopEnd spliced onto the first 100 ms after loopStart, as playback does).
 */
async function checkSamples(): Promise<void> {
  const assets = await loadViolinAssets(new OfflineAudioContext(1, SR, SR));
  const parts: string[] = [];
  let pass = true;
  for (const s of assets.samples) {
    const x = s.buffer.getChannelData(0);
    const sr = s.buffer.sampleRate;
    const hz = hzOf(s.root);
    const inside = A.periodicityBreak(x, sr, 0.1, s.loopEnd - 0.02, () => [hz, hz]);
    const n = Math.round(0.1 * sr);
    const a = Math.round(s.loopStart * sr);
    const spliced = new Float32Array(2 * n);
    spliced.set(x.subarray(x.length - n));
    spliced.set(x.subarray(a, a + n), n);
    const seam = A.periodicityBreak(spliced, sr, 0.05, 0.15, () => [hz, hz]);
    pass &&= inside.max < MAX_PERIODICITY_BREAK && seam.max < MAX_PERIODICITY_BREAK;
    parts.push(`${s.name} [${fmt(s.loopStart, 1)}–${fmt(s.loopEnd, 1)} s] inside ${fmt(inside.max, 2)} seam ${fmt(seam.max, 2)}`);
  }
  record('violin samples: no bow change before the loop end, seamless loop wrap', pass, parts.join(' · '));
}

// ---------- (c) staccato ----------

async function checkStaccato(kind: InstrumentKind, midis: number[]): Promise<void> {
  const DUR = 0.4;
  const GAP = 0.2;
  const T0 = 0.2;
  const feeds = midis.map((m, i) => ({ ev: note(m, DUR), when: T0 + i * (DUR + GAP) }));
  const r = await renderVoice(kind, T0 + midis.length * (DUR + GAP) + 1, feeds);
  keep(`${kind}-staccato`, r.pcm);
  const env = A.envelope(r.pcm, SR);
  const atk = A.attacks(env);
  const drops = feeds.slice(0, -1).map((f) => {
    const level = A.medianDb(env, f.when + 0.1, f.when + DUR);
    return level - A.minDb(env, f.when + DUR, f.when + DUR + GAP);
  });
  const pass = atk.length === midis.length && drops.every((d) => d >= 10) && r.errors.length === 0;
  record(
    `${kind}: staccato ${midis.join(' ')} (gaps ${GAP} s)`,
    pass,
    `attacks ${atk.length} · level drop in gaps ${drops.map((d) => fmt(d)).join(' ')} dB${errorsOf(r)}`,
  );
}

// ---------- (d) drums ----------

async function checkDrums(): Promise<void> {
  const centroids: Record<string, number> = {};
  const peaks: Record<string, number> = {};
  for (const kind of ['kick', 'snare', 'hat'] as const) {
    const r = await renderVoice('drums', 0.8, [{ ev: hit(kind), when: 0.1 }]);
    keep(`drums-${kind}`, r.pcm);
    centroids[kind] = A.spectralCentroid(r.pcm, SR, 0.1, 0.25);
    peaks[kind] = A.db(A.peak(r.pcm));
  }
  const ordered = centroids.kick < centroids.snare && centroids.snare < centroids.hat;
  const audible = Object.values(peaks).every((p) => p > -26);
  record(
    'drums: kick < snare < hat (spectral centroid)',
    ordered && audible,
    `centroid kick ${fmt(centroids.kick, 0)} Hz · snare ${fmt(centroids.snare, 0)} Hz · hat ${fmt(centroids.hat, 0)} Hz · ` +
      `peak kick ${fmt(peaks.kick)} snare ${fmt(peaks.snare)} hat ${fmt(peaks.hat)} dBFS`,
  );

  const flams: Feed[] = [];
  for (const [i, kind] of (['kick', 'snare', 'hat'] as const).entries()) {
    const t = 0.1 + i * 0.25;
    flams.push({ ev: hit(kind), when: t }, { ev: hit(kind), when: t + 0.001 });
  }
  for (const kind of ['kick', 'snare', 'hat'] as const) flams.push({ ev: hit(kind), when: 0.9 }, { ev: hit(kind), when: 0.9 });
  const r = await renderVoice('drums', 1.6, flams);
  keep('drums-flams', r.pcm);
  record(
    'drums: hits 1 ms apart and same-time hits do not throw',
    r.errors.length === 0 && A.allFinite(r.pcm) && A.peak(r.pcm) > 0.05,
    `errors ${r.errors.length} · warnings ${r.warnings.length} · peak ${fmt(A.db(A.peak(r.pcm)))} dBFS${errorsOf(r)}`,
  );

  // a groove to listen to: 2 bars at 100 BPM
  const beat = 60 / 100;
  const groove: Feed[] = [];
  for (let b = 0; b < 8; b++) {
    const t = 0.1 + b * beat;
    groove.push({ ev: hit(b % 2 === 0 ? 'kick' : 'snare', b % 4 === 3 ? 0.95 : 0.75), when: t });
    groove.push({ ev: hit('hat', 0.6), when: t }, { ev: hit('hat', 0.4), when: t + beat / 2 });
  }
  const g = await renderVoice('drums', 0.1 + 8 * beat + 0.6, groove);
  keep('drums-groove', g.pcm);
}

// ---------- (e) catch-up ----------

async function checkCatchUp(kind: InstrumentKind, midi: number): Promise<void> {
  const WHEN = 0.3;
  const ref = await renderVoice(kind, 2, [{ ev: note(midi, 0.7), when: WHEN }]);
  const late = await renderVoice(kind, 2, [{ ev: note(midi, 1.0), when: WHEN, offset: 0.3, arrive: WHEN }]);
  keep(`${kind}-catchup`, late.pcm);
  const lenRef = A.soundLength(A.envelope(ref.pcm, SR));
  const lenLate = A.soundLength(A.envelope(late.pcm, SR));
  const pass = Math.abs(lenRef - lenLate) <= 0.05 && late.errors.length === 0;
  record(
    `${kind}: catch-up (dur 1.0, offset 0.3) sounds like a 0.7 s note`,
    pass,
    `length above −20 dB: 0.7 s note ${fmt(lenRef, 3)} s · caught-up note ${fmt(lenLate, 3)} s${errorsOf(late)}`,
  );
}

// ---------- a note handed over after its time starts without a click ----------

async function checkLateStart(kind: InstrumentKind): Promise<void> {
  const WHEN = 0.3;
  const r = await renderVoice(kind, 1.2, [{ ev: note(64, 0.5), when: WHEN, arrive: WHEN + 0.005 }]);
  const p = A.peak(r.pcm);
  let first = 0;
  while (first < r.pcm.length && Math.abs(r.pcm[first]) < 1e-4) first++;
  // largest level in the first 0.5 ms of sound, relative to the note's peak: an attack begun in the past jumps
  const head = A.peak(r.pcm.subarray(first, first + Math.round(0.0005 * SR)));
  const startMs = ((first / SR - WHEN) * 1000);
  record(
    `${kind}: a note handed over 5 ms late starts cleanly`,
    head / p < 0.15 && r.errors.length === 0,
    `starts ${fmt(startMs, 1)} ms after its time · first 0.5 ms at ${fmt(A.db(head / p))} dB re peak${errorsOf(r)}`,
  );
}

// ---------- (f) a phrase wrapping across the loop end; an orphaned open phrase still ends ----------

async function checkWrap(kind: InstrumentKind, a: number, b: number): Promise<void> {
  const L = 2;
  const T0 = 0.2;
  const phrase = `${kind}:wrap`;
  const n1 = note(a, 1, { phrase, legatoNext: true });
  const n2 = note(b, 1, { phrase, legatoNext: true }); // the last note of the take continues into the first
  const feeds: Feed[] = [0, 1].flatMap((k) => [
    { ev: n1, when: T0 + k * L },
    { ev: n2, when: T0 + k * L + 1 },
  ]);
  const end = T0 + 2 * L;
  const r = await renderVoice(kind, end + 3, feeds);
  keep(`${kind}-wrap`, r.pcm);
  const stats = legatoStats(r.pcm, feeds, T0, end);
  const tail = A.rmsDb(r.pcm, SR, end + 2, end + 2.9);
  record(
    `${kind}: phrase wrapping across the loop end stays legato; the open phrase ends by itself`,
    legatoOk(stats) && tail < -80 && r.errors.length === 0,
    `${legatoText(stats)} · level 2 s after the last note ${fmt(tail)} dBFS${errorsOf(r)}`,
  );
}

// ---------- stopAll ----------

async function checkStopAll(kind: InstrumentKind): Promise<void> {
  const STOP = 1;
  const stop: Act = { at: STOP, run: (v: Voice) => v.stopAll(STOP) };
  let feeds: Feed[];
  if (kind === 'drums') {
    feeds = [
      { ev: hit('kick'), when: 0.5 },
      { ev: hit('kick'), when: 0.9 },
      { ev: hit('hat'), when: 0.95 },
      { ev: hit('snare'), when: 1.05, arrive: 0.93 }, // handed over before the stop, due after it
      { ev: hit('snare'), when: 1.5 },
    ];
  } else {
    const p = `${kind}:stop`;
    feeds = [
      { ev: note(60, 1.9, { phrase: p, legatoNext: true }), when: 0.1 },
      { ev: note(67, 0.3), when: 1.05, arrive: 0.93 }, // handed over before the stop, due after it
      { ev: note(64, 0.5, { phrase: p }), when: 1.5 }, // a continuation after stopAll starts a fresh phrase
    ];
  }
  const r = await renderVoice(kind, 2.6, feeds, [stop]);
  keep(`${kind}-stopall`, r.pcm);
  const env = A.envelope(r.pcm, SR);
  const before = kind === 'drums' ? A.db(A.peak(r.pcm.subarray(0, STOP * SR))) : A.rmsDb(r.pcm, SR, 0.6, 0.95);
  const after = A.rmsDb(r.pcm, SR, STOP + 0.03, 1.45);
  const again = A.maxDb(env, 1.5, 1.9);
  const silent = after <= before - STOP_SILENCE_DB || after < -70;
  const pass = silent && again > before - 20 && r.errors.length === 0;
  record(
    `${kind}: stopAll silent within 30 ms (incl. a note handed over before it); plays again after`,
    pass,
    `before ${fmt(before)} dBFS · 30–450 ms after stop ${fmt(after)} dBFS · next note ${fmt(again)} dBFS${errorsOf(r)}`,
  );
}

// ---------- blips ----------

async function checkBlips(): Promise<void> {
  const AT = 0.1;
  const parts: string[] = [];
  let pass = true;
  for (const kind of ['ok', 'err', 'click'] as const) {
    const pcm = await renderBlip((ctx, at) => playBlip(ctx, kind, at), 0.6, AT);
    keep(`blip-${kind}`, pcm);
    const p = A.peak(pcm);
    let first = 0;
    while (first < pcm.length && Math.abs(pcm[first]) < 0.01) first++;
    const onsetMs = ((first - AT * SR) / SR) * 1000;
    pass &&= p > 0.05 && A.allFinite(pcm) && (kind !== 'click' || Math.abs(onsetMs) < 0.05);
    parts.push(`${kind} peak ${fmt(A.db(p))} dBFS onset ${fmt(onsetMs, 2)} ms`);
  }
  record('blips: ok, err, click render (click onset exact)', pass, parts.join(' · '));
}

// ---------- run ----------

async function runAll(): Promise<CheckRun> {
  const t0 = performance.now();
  results.length = 0;
  const steps: [string, () => Promise<void>][] = [
    ['pitch synth', () => checkPitch('synth', [60, 64, 67, 72])],
    ['pitch violin', () => checkPitch('violin', [55, 60, 62, 64, 67, 69, 72, 74, 76, 79, 84])],
    ['pitch bass', () => checkPitch('bass', [36, 40, 43, 45, 48])],
    // C5 D5 (glide in the C5 sample) E5 G5 A4 C5 (each a crossfade to another sample)
    ['legato violin', () => checkLegato('violin', [[72, 0.5], [74, 0.5], [76, 0.5], [79, 0.5], [69, 0.5], [72, 0.6]], 'violin-legato')],
    ['legato bass', () => checkLegato('bass', [[36, 0.4], [40, 0.4], [43, 0.4], [48, 0.4], [45, 0.5]], 'bass-legato')],
    ['repeat violin', () => checkRepeat('violin', 64)],
    ['repeat bass', () => checkRepeat('bass', 40)],
    ['long violin', () => checkLongNote(69, 20)],
    ['violin samples', () => checkSamples()],
    ['staccato violin', () => checkStaccato('violin', [60, 64, 67, 72])],
    ['drums', () => checkDrums()],
    ['catch-up violin', () => checkCatchUp('violin', 64)],
    ['catch-up synth', () => checkCatchUp('synth', 64)],
    ['catch-up bass', () => checkCatchUp('bass', 40)],
    // drums are exempt: a kick is meant to reach its peak within a millisecond
    ...(['violin', 'synth', 'bass'] as const).map((k): [string, () => Promise<void>] => [`late ${k}`, () => checkLateStart(k)]),
    ['wrap violin', () => checkWrap('violin', 72, 76)],
    ['wrap bass', () => checkWrap('bass', 43, 48)],
    ...(['violin', 'synth', 'bass', 'drums'] as const).map((k): [string, () => Promise<void>] => [`stopAll ${k}`, () => checkStopAll(k)]),
    ['blips', () => checkBlips()],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      record(name, false, `threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }
  return { results: [...results], wavs, ms: Math.round(performance.now() - t0) };
}

window.runInstrumentChecks = runAll;
window.runRealtimeSmoke = realtimeSmoke;

// ---------- real-time smoke: a live AudioContext, as the engine runs it ----------

/**
 * Every voice on a live AudioContext with Tone.setContext(ctx) (as the engine does): notes handed over 0.12 s ahead
 * by setTimeout, a legato continuation, captured through a ScriptProcessor tap. Checks it sounds, at the right pitch,
 * and nothing throws. Runs in real time (~1.5 s per voice).
 */
async function realtimeSmoke(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  setContext(ctx);
  await preloadInstruments(ctx);
  const sleep = (s: Sec) => new Promise((r) => setTimeout(r, s * 1000));
  for (const kind of ['violin', 'synth', 'bass', 'drums'] as const) {
    const errors: string[] = [];
    const chunks: Float32Array[] = [];
    const tap = ctx.createScriptProcessor(2048, 1, 1);
    tap.onaudioprocess = (e) => chunks.push(e.inputBuffer.getChannelData(0).slice());
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tap.connect(mute).connect(ctx.destination);
    let voice: Voice | null = null;
    try {
      voice = createVoice(kind, ctx);
      voice.output.connect(tap);
      const t0 = ctx.currentTime + 0.15;
      const phrase = `rt:${kind}`;
      const first: Note | DrumHit = kind === 'drums' ? hit('kick') : note(kind === 'bass' ? 40 : 64, 0.5, { phrase, legatoNext: true });
      const second: Note | DrumHit = kind === 'drums' ? hit('snare') : note(kind === 'bass' ? 43 : 67, 0.5, { phrase });
      voice.play(first, t0);
      await sleep(t0 + 0.5 - 0.12 - ctx.currentTime);
      voice.play(second, t0 + 0.5);
      await sleep(1.2);
    } catch (e) {
      errors.push(String(e));
    }
    tap.disconnect();
    voice?.dispose();
    const pcm = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((o, c) => (pcm.set(c, o), o + c.length), 0);
    const level = A.db(A.peak(pcm));
    let pitch = '';
    let pass = errors.length === 0 && level > -40;
    if (kind !== 'drums') {
      // the capture's start is not aligned to t0: look for the second note's pitch anywhere in the capture
      const m = kind === 'bass' ? 43 : 67;
      const sr = ctx.sampleRate;
      let best = Infinity;
      for (let t = 0; t + 0.3 < pcm.length / sr; t += 0.1) {
        const hz = A.fundamental(pcm, sr, t, t + 0.3, hzOf(m));
        if (hz) best = Math.min(best, Math.abs(A.cents(hz, m)));
      }
      pass &&= best <= PITCH_TOL;
      pitch = ` · best second-note pitch error ${fmt(best, 0)} cents`;
    }
    out.push({
      name: `${kind}: real-time AudioContext smoke`,
      pass,
      detail: `peak ${fmt(level)} dBFS${pitch} · rate ${ctx.sampleRate} Hz${errors.length ? ` · ERRORS ${errors.join('; ')}` : ''}`,
    });
  }
  await ctx.close();
  return out;
}

// ---------- manual use: run, read, listen ----------

let live: AudioContext | null = null;
document.getElementById('run')!.addEventListener('click', async () => {
  const out = document.getElementById('out')!;
  out.textContent = 'running…';
  const run = await runAll();
  out.textContent = run.results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`).join('\n');
  const box = document.getElementById('renders')!;
  box.replaceChildren(
    ...Object.keys(pcms).map((name) => {
      const b = document.createElement('button');
      b.textContent = `▶ ${name}`;
      b.onclick = () => {
        live ??= new AudioContext();
        const buf = live.createBuffer(1, pcms[name].length, SR);
        buf.getChannelData(0).set(pcms[name]);
        const src = live.createBufferSource();
        src.buffer = buf;
        src.connect(live.destination);
        src.start();
      };
      return b;
    }),
  );
});
