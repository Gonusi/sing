// [shell] Dev page: mounts the real UI modules on a scripted fake UiView. Pick the scene with ?s=<name>:
//   empty | four | five (four + vocals) | recording | recording-vocals | overdub | command | toast | settings | calibrating (settings + calibration running; ?ci=<ms> click period) | plus | menu (lane menu on violin) | many (12 lanes, scrolls)
//   transport-stopped (paused at bar 3 beat 2) | transport-countin | transport-recording (= overdub) | tempo-muted | tempo-locked | tempo-picker (native select shown)
// ?t=<seconds> freezes the loop position (used for stable screenshots). Tempo is 96 bpm 4/4, the loop 4 bars = 10 s.
// Actions only log (tempo -/+ and the click toggle also change the fake state).
// Test hooks: window.__gestures (every Gesture emitted), window.__actions (every action called), window.__lanes (posAt), window.__ready.
import '../../src/ui/style.css';
import type { DrumHit, Gesture, InstrumentKind, Note, Take, Track, UiView } from '../../src/types.ts';
import { mountInput } from '../../src/ui/input.ts';
import { mountLanes } from '../../src/ui/lanes.ts';
import { mountSheets } from '../../src/ui/sheet.ts';
import { mountStatus } from '../../src/ui/status.ts';
import { mountTempo } from '../../src/ui/tempo.ts';
import { mountTransport } from '../../src/ui/transport.ts';
import { TEMPO_MAX_BPM, TEMPO_MIN_BPM } from '../../src/types.ts';
import type { LanesApi } from '../../src/ui/lanes.ts';

declare global {
  interface Window {
    __gestures: Gesture[];
    __actions: string[];
    __ready: boolean;
    __lanes: LanesApi;
  }
}

const BPM = 96;
const BAR = (60 / BPM) * 4;
const LOOP = 4 * BAR; // 4 bars = 10 s
const SCALE = LOOP / 4; // the fake takes below are written for a 4 s loop
const TOAST_AT = performance.now(); // the toast scene shows a toast that was created at page load
const params = new URLSearchParams(location.search);
const scene = params.get('s') ?? 'four';
const frozenT = params.get('t');

window.__gestures = [];
window.__actions = [];
window.__ready = false;
const log = (action: string): void => {
  window.__actions.push(action);
  console.log('action', action);
};

// ---------- fake data ----------
let noteSeq = 0;
function note(pos: number, dur: number, midi: number, vel = 0.8): Note {
  return { pos: pos * SCALE, dur: dur * SCALE, midi, vel, phrase: `fake:${noteSeq++}`, legatoNext: false };
}
const take = (id: string, notes: Note[] = [], hits: DrumHit[] = [], peaks?: number[]): Take => ({ id, notes, hits, ...(peaks ? { peaks } : {}) });
const track = (id: string, kind: InstrumentKind, t: Take | null, on = true): Track => ({ id, kind, take: t, on });

function drumHits(): DrumHit[] {
  const hits: DrumHit[] = [];
  for (let i = 0; i < 16; i++) hits.push({ pos: i * 0.25 * SCALE, kind: 'hat', vel: i % 2 === 0 ? 0.9 : 0.5 });
  for (const pos of [0, 1, 2, 2.75]) hits.push({ pos: pos * SCALE, kind: 'kick', vel: 0.9 });
  for (const pos of [0.5, 1.5, 2.5, 3.5]) hits.push({ pos: pos * SCALE, kind: 'snare', vel: 0.75 });
  return hits;
}
const violinNotes = (): Note[] => [
  note(0, 0.45, 69), note(0.5, 0.45, 72), note(1, 0.9, 71), note(2, 0.45, 69), note(2.5, 0.45, 67), note(3, 0.9, 74),
];
const synthNotes = (): Note[] =>
  [60, 64, 67, 72, 67, 64, 60, 55].map((midi, i) => note(i * 0.5, 0.3, midi, 0.7));
const bassNotes = (): Note[] => [note(0, 0.9, 40), note(1, 0.9, 43), note(2, 0.9, 45), note(3, 0.9, 38)];

const PEAK_BINS = 256;
/** syllable-like envelope: bursts of sound separated by short gaps; `fraction` = share of bins filled (rest 0) */
function vocalPeaks(fraction = 1): number[] {
  const filled = Math.round(PEAK_BINS * fraction);
  return Array.from({ length: PEAK_BINS }, (_, i) => {
    if (i >= filled) return 0;
    const syllable = Math.abs(Math.sin((i / PEAK_BINS) * 11 * Math.PI)); // ~11 syllables per loop
    const phrase = 0.55 + 0.45 * Math.sin((i / PEAK_BINS) * 2.3 * Math.PI + 0.8);
    const jitter = 0.75 + 0.25 * Math.sin(i * 12.9898);
    const gap = Math.sin((i / PEAK_BINS) * 3 * Math.PI) < -0.9 ? 0.05 : 1; // two breaths
    return Math.min(1, Math.max(0.02, syllable ** 0.7 * phrase * jitter * gap));
  });
}

const fourTracks = (): Track[] => [
  track('drums', 'drums', take('t1', [], drumHits())),
  track('violin', 'violin', take('t2', violinNotes())),
  track('synth', 'synth', take('t3', synthNotes())),
  track('bass', 'bass', take('t4', bassNotes()), false),
];

const fiveTracks = (): Track[] => [...fourTracks(), track('vocals', 'vocals', take('t5', [], [], vocalPeaks()))];

function loopPos(): number {
  return frozenT !== null ? Number(frozenT) : (performance.now() / 1000) % LOOP;
}

/** the beat clock at a position (seconds from bar 1 beat 1) */
function beatAt(pos: number): NonNullable<UiView['beat']> {
  const index = pos / (60 / bpm);
  const whole = Math.floor(index);
  return { bar: Math.floor(whole / 4) + 1, beat: (whole % 4) + 1, phase: index - whole };
}

function baseView(): UiView {
  return {
    state: 'idle',
    session: { v: 1, loopLength: null, tracks: [], selectedId: null },
    livePeaks: null,
    recordingTrackId: null,
    liveNotes: [],
    liveHits: [],
    openNote: null,
    loopPos: null,
    elapsed: null,
    holding: false,
    partial: '',
    toast: null,
    voice: 'ready',
    voiceProgress: 1,
    tempo: { bpm, beatsPerBar: 4 },
    playhead: null,
    beat: null,
    countIn: null,
    tempoEditable,
  };
}

function fourView(): UiView {
  return {
    ...baseView(),
    state: 'playing',
    session: { v: 1, loopLength: LOOP, tracks: fourTracks(), selectedId: 'violin' },
    loopPos: loopPos(),
    playhead: loopPos(),
    beat: beatAt(loopPos()),
  };
}

function fiveView(): UiView {
  return { ...fourView(), session: { v: 1, loopLength: LOOP, tracks: fiveTracks(), selectedId: 'vocals' } };
}

function recordingVocalsView(): UiView {
  return {
    ...baseView(),
    state: 'recordingFirst',
    session: { v: 1, loopLength: null, tracks: [track('m1', 'vocals', null)], selectedId: 'm1' },
    recordingTrackId: 'm1',
    livePeaks: vocalPeaks(0.6),
    elapsed: 3.2,
    beat: beatAt(3.2),
  };
}

function recordingView(): UiView {
  return {
    ...baseView(),
    state: 'recordingFirst',
    session: { v: 1, loopLength: null, tracks: [track('s1', 'synth', null)], selectedId: 's1' },
    recordingTrackId: 's1',
    liveNotes: [note(0.3, 0.4, 62), note(0.8, 0.3, 64), note(1.2, 0.5, 66), note(1.9, 0.3, 64), note(2.4, 0.35, 62)],
    openNote: { pos: 2.9, midi: 65.4 },
    elapsed: 3.2,
    beat: beatAt(3.2),
  };
}

function overdubView(): UiView {
  const tracks = [
    track('drums', 'drums', take('t1', [], drumHits())),
    track('synth', 'synth', take('t3', synthNotes())),
    track('bass', 'bass', take('t4', bassNotes())),
    track('violin', 'violin', null),
  ];
  return {
    ...baseView(),
    state: 'overdubbing',
    session: { v: 1, loopLength: LOOP, tracks, selectedId: 'violin' },
    recordingTrackId: 'violin',
    liveNotes: [note(0.2, 0.5, 69), note(0.8, 0.3, 71)],
    openNote: { pos: 1.2, midi: 70.3 },
    loopPos: loopPos(),
    playhead: loopPos(),
    beat: beatAt(loopPos()),
    elapsed: 2.3,
  };
}

/** paused at bar 3 beat 2 of the 4-bar loop */
function stoppedView(): UiView {
  return { ...fourView(), state: 'stopped', loopPos: null, playhead: 2 * BAR + 60 / bpm, beat: null };
}

/** count-in "3" before a first take (one empty violin lane) */
function countInView(): UiView {
  return {
    ...baseView(),
    state: 'countIn',
    session: { v: 1, loopLength: null, tracks: [track('v1', 'violin', null)], selectedId: 'v1' },
    recordingTrackId: 'v1',
    countIn: 3,
    beat: { ...beatAt(loopPos()), bar: 1, beat: 2 },
  };
}

function toastView(): UiView {
  return {
    ...baseView(),
    session: { v: 1, loopLength: null, tracks: [track('v1', 'violin', null)], selectedId: 'v1' },
    toast: { text: 'violin track', kind: 'ok', at: TOAST_AT },
  };
}
/** 12 lanes: more than fit at the minimum lane height, so the lanes area scrolls */
function manyView(): UiView {
  const kinds: InstrumentKind[] = ['drums', 'violin', 'synth', 'bass'];
  const tracks = Array.from({ length: 12 }, (_, i) => track(`m${i}`, kinds[i % 4]!, take(`mt${i}`, synthNotes(), drumHits())));
  return { ...baseView(), state: 'playing', session: { v: 1, loopLength: LOOP, tracks, selectedId: 'm1' }, loopPos: loopPos() };
}

const SCENES: Record<string, () => UiView> = {
  empty: baseView,
  four: fourView,
  five: fiveView,
  recording: recordingView,
  'recording-vocals': recordingVocalsView,
  overdub: overdubView,
  command: () => ({ ...fourView(), holding: true, partial: 'create violin' }),
  toast: toastView,
  many: manyView,
  settings: fourView,
  calibrating: fourView,
  plus: fourView,
  menu: fourView,
  'transport-stopped': stoppedView,
  'transport-countin': countInView,
  'transport-recording': overdubView,
  'tempo-muted': fourView,
  'tempo-locked': fiveView,
  'tempo-picker': fourView,
};
const baseSceneView = SCENES[scene] ?? fourView;
/** fake tempo / click state (the real ones live in the controller) */
let bpm = BPM;
let clickOn = scene !== 'tempo-muted' && params.get('click') !== '0';
const tempoEditable = scene !== 'tempo-locked' && params.get('locked') !== '1';
/** tracks removed by onDelete (the fake session keeps them out of every later view) */
const deleted = new Set<string>();
const view = (): UiView => {
  const v = baseSceneView();
  return deleted.size === 0 ? v : { ...v, session: { ...v.session, tracks: v.session.tracks.filter((t) => !deleted.has(t.id)) } };
};

// ---------- mount (same order as src/main.ts) ----------
const stage = document.createElement('div');
stage.className = 'stage';
document.getElementById('app')!.append(stage);

window.__lanes = mountLanes(stage, {
  view,
  onSelect: (id) => log(`select:${id}`),
  onToggle: (id) => log(`toggle:${id}`),
  onDelete: (id) => {
    deleted.add(id);
    log(`delete:${id}`);
  },
});
mountStatus(stage, { view });
mountTransport(stage, { view, onAction: (a) => log(`transport:${a}`) });
let ec = false;
let echo = 0.4;
let smoothing = 0.5;
let mic: string | null = null;
/** ?ci=<ms> sets the fake calibration click period (slow for the mid-measure screenshot) */
const clickMs = Number(params.get('ci') ?? 100);
mountSheets(stage, {
  create: (kind) => log(`create:${kind}`),
  openSetup: () => log('openSetup'),
  getEcho: () => echo,
  setEcho: (amount) => {
    echo = amount;
    log(`setEcho:${amount}`);
  },
  getSmoothing: () => smoothing,
  setSmoothing: (amount) => {
    smoothing = amount;
    log(`setSmoothing:${amount}`);
  },
  getEc: () => ec,
  setEc: async (next) => {
    ec = next;
    log(`setEc:${next}`);
  },
  calibrate: (onClick) =>
    new Promise((resolve) => {
      const LISTEN = 4;
      const MEASURE = 12;
      let i = 0;
      log('calibrate');
      const timer = setInterval(() => {
        i += 1;
        if (i <= LISTEN) onClick(i, LISTEN, 'listen');
        else onClick(i - LISTEN, MEASURE, 'measure');
        if (i === LISTEN + MEASURE) {
          clearInterval(timer);
          resolve('latency 312 ms · heard 9/12');
        }
      }, clickMs);
    }),
  listMics: async () => [
    { id: 'iphone', label: 'iPhone Microphone' },
    { id: 'airpods', label: 'AirPods Pro' },
  ],
  getMic: () => mic,
  setMic: async (id) => {
    mic = id;
    log(`setMic:${id}`);
    return true;
  },
  probe: () => {
    log('probe');
    return { level: () => 0.02 + 0.015 * Math.sin(performance.now() / 150), stop: () => log('probe-stop') };
  },
  exportTake: () => {
    log('export');
    return new Blob([new Uint8Array(44)], { type: 'audio/wav' });
  },
  clearSession: async () => log('clear'),
  info: () => ['input latency 10 ms (default)', 'output latency 23 ms', 'voice ready'],
  credits: 'Violin samples: VSCO 2 Community Edition via nbrosowsky/tonejs-instruments (CC-BY 3.0). Speech: Vosk (Apache-2.0).',
});
mountInput(stage, {
  now: () => performance.now() / 1000,
  onGesture: (g) => window.__gestures.push(g),
});

const topbarLeft = document.querySelector<HTMLElement>('.topbar-left')!;
mountTempo(topbarLeft, {
  view,
  clickOn: () => clickOn,
  onToggleClick: () => {
    clickOn = !clickOn;
    log('toggleClick');
  },
  onSetTempo: (next) => {
    log(`setTempo:${next}`);
    if (tempoEditable) bpm = Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, next));
  },
});

if (scene === 'tempo-picker') {
  // no showPicker -> the select is shown in place of the number; a real hold (pointer events) on the number
  Object.defineProperty(HTMLSelectElement.prototype, 'showPicker', { value: undefined, configurable: true });
  const num = document.querySelector<HTMLElement>('.tempo-num')!;
  num.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' }));
  setTimeout(() => num.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch' })), 600);
}
if (scene === 'settings' || scene === 'calibrating') document.querySelector<HTMLElement>('[data-action="settings"]')!.click();
if (scene === 'calibrating') document.querySelector<HTMLElement>('[data-row="calibrate"]')!.click();
if (scene === 'plus') document.querySelector<HTMLElement>('[data-action="new-track"]')!.click();
if (scene === 'menu') {
  // a real hold on the violin strip (pointer events), so the scene exercises the same path as a finger
  const press = (): void => {
    const strip = document.querySelector<HTMLElement>('.lane-strip[data-id="violin"]');
    if (!strip || strip.offsetHeight === 0) return void requestAnimationFrame(press);
    strip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'touch' }));
  };
  requestAnimationFrame(press);
}
window.__ready = true;
