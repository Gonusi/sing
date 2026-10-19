// [shell] Canvas lanes: one horizontal band per track, notes/hits, live take, playhead, left strip (select, on/off).
// Holding a strip button 450 ms opens the lane menu (lanemenu.ts: mute/unmute, delete) instead of the tap action.
// One <canvas class="lanes"> is redrawn every animation frame from view(). The strip buttons are DOM <button>s
// (data-no-gesture) laid over the canvas; the canvas only paints their circle + letter.
// Swipe (iOS Voice Memos style): input.ts hands a sideways drag to `LanesApi.swipe`; the lane (canvas content + strip button) is drawn/translated
// left by the row offset, and a clipped DOM `.swipe-actions` box (duplicate / delete) at the lane's right edge is revealed behind it.
// State per swiped lane = a `Row` (offset x <= 0, optional animation). Only one row is open at a time. Rows are driven from the frame loop.
// Layout changes (a lane added/removed) slide the other lanes to their new place (`slides`, FLIP-style, canvas + strip buttons).
// Colours are read from the CSS tokens in style.css (single source of truth).
// Coordinates: "lane-local" x starts at the lane's left edge (LANE_MARGIN_X); all other x are canvas css px.
import { openLaneMenu } from './lanemenu.ts';
import type { DrumKind, InstrumentKind, Note, Sec, Tempo, Track, UiView } from '../types.ts';

type OpenNote = NonNullable<UiView['openNote']>;

export interface LanesApi {
  /** screen x (clientX) -> loop position in seconds, clamped to [0, L); null when there is no loop yet */
  posAt(clientX: number): Sec | null;
  /** pass to mountInput as `onSwipe` */
  swipe: {
    start(clientX: number, clientY: number): boolean;
    move(dx: number): void;
    end(dx: number, vx: number): void;
    open(): boolean;
    dismiss(): void;
  };
  destroy(): void;
}

export interface LanesOptions {
  view: () => UiView;
  onSelect(trackId: string): void;
  onToggle(trackId: string): void;
  /** holding a strip button (lane menu -> delete) */
  onDelete(trackId: string): void;
  /** the swipe action: add a copy of the track (below it) */
  onDuplicate(trackId: string): void;
}

// ---------- layout constants (css px) ----------
const LANE_MAX_H = 120;
const LANE_MIN_H = 56;
const LANE_GAP = 8;
const LANE_MARGIN_X = 12;
const LANE_RADIUS = 14;
const STRIP_W = 56;
const STRIP_CIRCLE_D = 32;
const STRIP_CIRCLE_X = 28; // lane-local centre
const BODY_LEFT = 64; // lane-local
const BODY_RIGHT_PAD = 12;
const HOLD_MS = 450; // holding a strip button this long opens the lane menu
const HOLD_HAPTIC_MS = 10;

// ---------- swipe actions ----------
const OPEN_W = 168; // the lane rests this far left when open (2 buttons of 84)
const SNAP_OPEN_PX = 80; // released further left than this -> opens
const FLICK_V = 0.5; // px/ms: a flick this fast opens (left) / closes (right)
const DELETE_FRAC = 0.6; // of the lane width ...
const DELETE_V = 0.8; // ... with a flick this fast = full-swipe delete
const RUBBER = 0.5; // the lane follows the finger by this factor beyond OPEN_W
const SNAP_MS = 180;
const REMOVE_MS = 200;
const REMOVE_TIMEOUT_MS = 800; // a lane that is still there this long after onDelete comes back
const SLIDE_MS = 220;
const ICON_COPY = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5"/></svg>';

// ---------- lane look ----------
const FILL_ALPHA = 0.08;
const FILL_ALPHA_SELECTED = 0.16;
const STROKE_ALPHA_SELECTED = 0.6;
const STROKE_W_SELECTED = 1.5;
const OFF_ALPHA = 0.35;
const REC_STROKE_W = 2;
const REC_PULSE_HZ = 1.5;
const REC_PULSE_MIN = 0.45;
const LETTER_FONT_PX = 15;
const RING_W = 2;

// ---------- notes and hits ----------
const NOTE_H = 6;
const NOTE_RADIUS = 3;
const NOTE_MIN_W = 4;
const NOTE_PAD_Y = 10;
const OPEN_NOTE_GLOW = 8;
const PITCH_MARGIN = 2; // semitones above/below the lane's notes
const PITCH_MIN_SPAN = 12;
const PITCH_DEFAULT_CENTRE = 60;
const DRUM_ROW: Record<DrumKind, number> = { hat: 0.25, snare: 0.5, kick: 0.75 }; // fraction of lane height
const DRUM_R = 4;
const KICK_R = 5;

// ---------- vocal waveform ----------
const WAVE_PAD_Y = 10; // lane height minus 2 x this = height of a peak of 1.0
const WAVE_ALPHA = 0.85;
const WAVE_MIN_BAR_H = 1;
const WAVE_GAP = 1; // px between bars, only when bars are wider than WAVE_GAP_MIN_BAR_W
const WAVE_GAP_MIN_BAR_W = 2.5;

// ---------- time axis and playhead ----------
const FIRST_TAKE_MIN_LENGTH: Sec = 4;
const PLAYHEAD_W = 1.5;
const PLAYHEAD_ALPHA = 0.7;
const PLAYHEAD_STOPPED_ALPHA = 0.4;
const POS_EPSILON: Sec = 1e-6; // posAt stays strictly below the loop length
const DASH: [number, number] = [4, 6];

// ---------- beat grid ----------
const BAR_LINE_ALPHA = 0.12;
const BEAT_LINE_ALPHA = 0.05;
const GRID_LINE_W = 1;

const LETTERS: Record<InstrumentKind, string> = { drums: 'D', violin: 'V', synth: 'S', bass: 'B', vocals: 'M' };
const KINDS: InstrumentKind[] = ['drums', 'violin', 'synth', 'bass', 'vocals'];

// ---------- palette (from CSS) ----------
type Rgb = [number, number, number];

interface Palette {
  bg: Rgb;
  fg: Rgb;
  rec: Rgb;
  line: Rgb;
  kind: Record<InstrumentKind, Rgb>;
  font: string;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseHex(hex: string): Rgb {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readPalette(): Palette {
  const kind = {} as Record<InstrumentKind, Rgb>;
  for (const k of KINDS) kind[k] = parseHex(cssVar(`--${k}`));
  return {
    bg: parseHex(cssVar('--bg')),
    fg: parseHex(cssVar('--fg')),
    rec: parseHex(cssVar('--rec')),
    line: parseHex(cssVar('--line')),
    kind,
    font: getComputedStyle(document.body).fontFamily,
  };
}

function rgba(c: Rgb, alpha: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

// ---------- geometry ----------
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  laneH: number;
  contentH: number;
}

/** time axis of the lanes: the loop, or (first take, no loop yet) a window that grows with the recording */
interface Axis {
  length: Sec;
  wrap: boolean;
}

function computeLayout(areaH: number, laneCount: number): Layout {
  if (laneCount === 0) return { laneH: LANE_MAX_H, contentH: areaH };
  const fit = (areaH - LANE_GAP * (laneCount - 1)) / laneCount;
  const laneH = Math.max(LANE_MIN_H, Math.min(LANE_MAX_H, fit));
  const needed = laneCount * laneH + LANE_GAP * (laneCount - 1);
  return { laneH, contentH: Math.max(areaH, needed) };
}

function laneRect(index: number, laneH: number, areaW: number): Rect {
  return { x: LANE_MARGIN_X, y: index * (laneH + LANE_GAP), w: areaW - 2 * LANE_MARGIN_X, h: laneH };
}

function bodyOf(lane: Rect): Rect {
  return { x: lane.x + BODY_LEFT, y: lane.y, w: lane.w - BODY_LEFT - BODY_RIGHT_PAD, h: lane.h };
}

function axisOf(view: UiView): Axis {
  const loop = view.session.loopLength;
  if (loop) return { length: loop, wrap: true };
  return { length: Math.max(view.elapsed ?? 0, FIRST_TAKE_MIN_LENGTH), wrap: false };
}

function xAt(body: Rect, axis: Axis, pos: Sec): number {
  return body.x + (Math.min(Math.max(pos, 0), axis.length) / axis.length) * body.w;
}

/** [start, end] second spans a note covers; a note crossing the loop end continues at 0 */
function spansOf(pos: Sec, dur: Sec, axis: Axis): Array<[Sec, Sec]> {
  const start = axis.wrap ? ((pos % axis.length) + axis.length) % axis.length : pos;
  const end = start + dur;
  if (end <= axis.length) return [[start, end]];
  return axis.wrap ? [[start, axis.length], [0, end - axis.length]] : [[start, axis.length]];
}

// ---------- pitch mapping ----------
interface PitchRange {
  lo: number;
  hi: number;
}

function pitchRange(midis: number[]): PitchRange {
  if (midis.length === 0) {
    return { lo: PITCH_DEFAULT_CENTRE - PITCH_MIN_SPAN / 2, hi: PITCH_DEFAULT_CENTRE + PITCH_MIN_SPAN / 2 };
  }
  let lo = Math.min(...midis) - PITCH_MARGIN;
  let hi = Math.max(...midis) + PITCH_MARGIN;
  if (hi - lo < PITCH_MIN_SPAN) {
    const centre = (lo + hi) / 2;
    lo = centre - PITCH_MIN_SPAN / 2;
    hi = centre + PITCH_MIN_SPAN / 2;
  }
  return { lo, hi };
}

/** y of a note's vertical centre */
function pitchY(lane: Rect, range: PitchRange, midi: number): number {
  const frac = (midi - range.lo) / (range.hi - range.lo);
  return lane.y + NOTE_PAD_Y + (1 - frac) * (lane.h - 2 * NOTE_PAD_Y);
}

// ---------- drawing ----------
interface DrawEnv {
  g: CanvasRenderingContext2D;
  p: Palette;
  dpr: number;
  nowMs: number;
}

function roundedRect(g: CanvasRenderingContext2D, r: Rect, radius: number): void {
  g.beginPath();
  g.roundRect(r.x, r.y, r.w, r.h, radius);
}

function drawLaneBackground(env: DrawEnv, lane: Rect, color: Rgb, selected: boolean): void {
  const { g } = env;
  roundedRect(g, lane, LANE_RADIUS);
  g.fillStyle = rgba(color, selected ? FILL_ALPHA_SELECTED : FILL_ALPHA);
  g.fill();
  if (selected) {
    g.lineWidth = STROKE_W_SELECTED;
    g.strokeStyle = rgba(color, STROKE_ALPHA_SELECTED);
    g.stroke();
  }
}

function drawRecordingEdge(env: DrawEnv, lane: Rect): void {
  const { g, p, nowMs } = env;
  const wave = (Math.sin((nowMs / 1000) * 2 * Math.PI * REC_PULSE_HZ) + 1) / 2;
  roundedRect(g, lane, LANE_RADIUS);
  g.lineWidth = REC_STROKE_W;
  g.strokeStyle = rgba(p.rec, REC_PULSE_MIN + (1 - REC_PULSE_MIN) * wave);
  g.stroke();
}

function drawStrip(env: DrawEnv, lane: Rect, kind: InstrumentKind, on: boolean): void {
  const { g, p } = env;
  const color = p.kind[kind];
  const cx = lane.x + STRIP_CIRCLE_X;
  const cy = lane.y + lane.h / 2;
  g.beginPath();
  if (on) {
    g.arc(cx, cy, STRIP_CIRCLE_D / 2, 0, 2 * Math.PI);
    g.fillStyle = rgba(color, 1);
    g.fill();
  } else {
    g.arc(cx, cy, STRIP_CIRCLE_D / 2 - RING_W / 2, 0, 2 * Math.PI);
    g.lineWidth = RING_W;
    g.strokeStyle = rgba(color, 1);
    g.stroke();
  }
  g.font = `700 ${LETTER_FONT_PX}px ${p.font}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = on ? rgba(p.bg, 1) : rgba(color, 1);
  g.fillText(LETTERS[kind], cx, cy + 0.5);
}

function drawEmptyLine(env: DrawEnv, body: Rect): void {
  const { g, p } = env;
  g.beginPath();
  g.setLineDash(DASH);
  g.lineWidth = 1;
  g.strokeStyle = rgba(p.line, 1);
  g.moveTo(body.x, body.y + body.h / 2);
  g.lineTo(body.x + body.w, body.y + body.h / 2);
  g.stroke();
  g.setLineDash([]);
}

function drawNoteBar(env: DrawEnv, body: Rect, axis: Axis, from: Sec, to: Sec, yCentre: number, color: Rgb): void {
  const x = xAt(body, axis, from);
  const w = Math.max(NOTE_MIN_W, ((to - from) / axis.length) * body.w);
  const { g } = env;
  g.beginPath();
  g.roundRect(x, yCentre - NOTE_H / 2, w, NOTE_H, NOTE_RADIUS);
  g.fillStyle = rgba(color, 1);
  g.fill();
}

/** the note being sung right now: a glowing bar from its start to the current position */
function drawOpenNote(env: DrawEnv, lane: Rect, body: Rect, axis: Axis, open: OpenNote, now: Sec, range: PitchRange, color: Rgb): void {
  let dur = now - open.pos;
  if (dur < 0 && axis.wrap) dur += axis.length;
  const { g, dpr } = env;
  g.save();
  g.shadowColor = rgba(color, 1);
  g.shadowBlur = OPEN_NOTE_GLOW * dpr; // shadowBlur ignores the canvas transform
  for (const [from, to] of spansOf(open.pos, Math.max(dur, 0), axis)) {
    drawNoteBar(env, body, axis, from, to, pitchY(lane, range, open.midi), color);
  }
  g.restore();
}

/** notes of a non-drum lane (plus the open note on the recording lane); the pitch range covers all of them */
function drawPitched(env: DrawEnv, lane: Rect, body: Rect, axis: Axis, notes: Note[], open: OpenNote | null, now: Sec, color: Rgb): void {
  const range = pitchRange([...notes.map((n) => n.midi), ...(open ? [open.midi] : [])]);
  for (const note of notes) {
    const y = pitchY(lane, range, note.midi);
    for (const [from, to] of spansOf(note.pos, note.dur, axis)) drawNoteBar(env, body, axis, from, to, y, color);
  }
  if (open) drawOpenNote(env, lane, body, axis, open, now, range, color);
}

function drawDrums(env: DrawEnv, lane: Rect, body: Rect, axis: Axis, hits: UiView['liveHits'], color: Rgb): void {
  const { g } = env;
  for (const hit of hits) {
    g.beginPath();
    g.arc(xAt(body, axis, hit.pos), lane.y + lane.h * DRUM_ROW[hit.kind], hit.kind === 'kick' ? KICK_R : DRUM_R, 0, 2 * Math.PI);
    g.fillStyle = rgba(color, 0.5 + 0.5 * hit.vel);
    g.fill();
  }
}

/** peaks[i] covers loop positions [i*L/n, (i+1)*L/n) (L = axis.length); bars mirrored around the lane's vertical centre */
function drawWaveform(env: DrawEnv, lane: Rect, body: Rect, peaks: number[], color: Rgb): void {
  const n = peaks.length;
  if (n === 0) return;
  const { g } = env;
  const step = body.w / n;
  const barW = Math.max(1, step > WAVE_GAP_MIN_BAR_W ? step - WAVE_GAP : step);
  const maxH = lane.h - 2 * WAVE_PAD_Y;
  const cy = lane.y + lane.h / 2;
  g.fillStyle = rgba(color, WAVE_ALPHA);
  for (let i = 0; i < n; i++) {
    const h = Math.max(WAVE_MIN_BAR_H, Math.min(1, Math.max(0, peaks[i]!)) * maxH);
    g.fillRect(body.x + i * step, cy - h / 2, barW, h);
  }
}

/** bar lines (12% fg) and beat lines (5% fg) across one lane body, from t=0 up to the axis length; two paths per lane */
function drawGrid(env: DrawEnv, body: Rect, axis: Axis, tempo: Tempo): void {
  const { g, p } = env;
  if (!(tempo.bpm > 0) || !(tempo.beatsPerBar > 0)) return;
  const beatSec = 60 / tempo.bpm;
  const count = Math.ceil(axis.length / beatSec - 1e-6); // beats that start inside the axis
  const bars = new Path2D();
  const beats = new Path2D();
  for (let i = 0; i < count; i++) {
    const x = Math.round(xAt(body, axis, i * beatSec) * env.dpr) / env.dpr + 0.5 / env.dpr;
    (i % tempo.beatsPerBar === 0 ? bars : beats).rect(x - GRID_LINE_W / 2, body.y, GRID_LINE_W, body.h);
  }
  g.fillStyle = rgba(p.fg, BEAT_LINE_ALPHA);
  g.fill(beats);
  g.fillStyle = rgba(p.fg, BAR_LINE_ALPHA);
  g.fill(bars);
}

function drawLaneContent(env: DrawEnv, lane: Rect, track: Track, view: UiView, axis: Axis): void {
  const color = env.p.kind[track.kind];
  const body = bodyOf(lane);
  const recording = view.recordingTrackId === track.id;
  drawGrid(env, body, axis, view.tempo);
  if (!track.take && !recording) drawEmptyLine(env, body);
  if (track.kind === 'vocals') {
    const peaks = recording ? view.livePeaks : track.take?.peaks;
    if (peaks) drawWaveform(env, lane, body, peaks, color);
    return;
  }
  if (track.kind === 'drums') {
    drawDrums(env, lane, body, axis, [...(track.take?.hits ?? []), ...(recording ? view.liveHits : [])], color);
    return;
  }
  const notes = [...(track.take?.notes ?? []), ...(recording ? view.liveNotes : [])];
  const open = recording ? view.openNote : null;
  const now = view.loopPos ?? view.elapsed ?? 0; // looping: heard position; first take: seconds recorded
  drawPitched(env, lane, body, axis, notes, open, now, color);
}

function drawLane(env: DrawEnv, index: number, laneH: number, areaW: number, track: Track, view: UiView, axis: Axis): void {
  const { g, p } = env;
  const lane = laneRect(index, laneH, areaW);
  const color = p.kind[track.kind];
  g.save();
  g.globalAlpha = track.on ? 1 : OFF_ALPHA;
  drawLaneBackground(env, lane, color, view.session.selectedId === track.id);
  if (view.recordingTrackId === track.id) drawRecordingEdge(env, lane);
  drawStrip(env, lane, track.kind, track.on);
  drawLaneContent(env, lane, track, view, axis);
  g.restore();
}

/** per-lane offset of the lane being swiped (dx) and of lanes sliding to a new place (dy) */
type OffsetOf = (trackId: string) => { dx: number; dy: number };

function drawPlayhead(env: DrawEnv, view: UiView, axis: Axis, areaW: number, laneH: number, offsetOf: OffsetOf): void {
  const tracks = view.session.tracks;
  const count = tracks.length;
  if (count === 0) return;
  const body = bodyOf(laneRect(0, laneH, areaW));
  const { fg, rec } = env.p;
  let pos: Sec | null = null;
  let color = rgba(fg, PLAYHEAD_ALPHA);
  if (view.state === 'recordingFirst') {
    pos = view.elapsed ?? 0;
    color = rgba(rec, 1);
  } else if (view.state === 'countIn') {
    pos = view.playhead ?? 0; // where the take will start
    color = rgba(rec, 1);
  } else if (view.state === 'overdubbing') {
    pos = view.loopPos ?? view.playhead;
    color = rgba(rec, 1);
  } else if (view.state === 'playing') {
    pos = view.loopPos ?? view.playhead;
  } else if (view.playhead !== null) {
    pos = view.playhead; // stopped (or idle with a position): the resume point, dimmed
    color = rgba(fg, PLAYHEAD_STOPPED_ALPHA);
  }
  if (pos === null) return;
  const { g } = env;
  const x = xAt(body, axis, pos);
  g.beginPath();
  // one segment per lane (so a swiped lane carries its piece of the playhead); the gap below a lane is bridged when it and the next lane are at rest
  tracks.forEach((t, i) => {
    const o = offsetOf(t.id);
    const next = i < count - 1 ? offsetOf(tracks[i + 1]!.id) : null;
    const top = i * (laneH + LANE_GAP) + o.dy;
    const bridge = next !== null && o.dx === 0 && next.dx === 0 ? LANE_GAP : 0;
    g.moveTo(x + o.dx, top);
    g.lineTo(x + o.dx, top + laneH + bridge);
  });
  g.lineWidth = PLAYHEAD_W;
  g.strokeStyle = color;
  g.stroke();
}

// ---------- DOM ----------
function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

// ---------- swipe rows ----------
interface Anim {
  from: number;
  to: number;
  start: number;
  ms: number;
  done?: () => void;
}

/** one swiped lane: x = how far it is shifted left (<= 0), el = the clipped action box behind it */
interface Row {
  id: string;
  x: number;
  base: number; // x when the current drag began
  dragging: boolean;
  open: boolean; // resting (or heading) open; the only state that makes taps elsewhere close it
  removing: boolean; // flying off for onDelete
  removedAt: number;
  anim: Anim | null;
  el: HTMLDivElement;
  geom: string;
}

const easeOut = (t: number): number => 1 - (1 - t) ** 3;

function actionButton(className: string, icon: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `swipe-btn ${className}`;
  b.innerHTML = `${icon}<span>${label}</span>`;
  b.setAttribute('aria-label', label);
  return b;
}

export function mountLanes(root: HTMLElement, opts: LanesOptions): LanesApi {
  const palette = readPalette();
  const area = div('lanes-area');
  const content = div('lanes-content');
  const canvas = document.createElement('canvas');
  canvas.className = 'lanes';
  content.append(canvas);
  area.append(content);
  root.append(area);
  const g = canvas.getContext('2d')!;

  // size of the lanes area, kept by the ResizeObserver
  let areaW = 0;
  let areaH = 0;
  const resizeObserver = new ResizeObserver(() => {
    areaW = area.clientWidth;
    areaH = area.clientHeight;
  });
  resizeObserver.observe(area);

  // layout cache: re-applied only when one of these changes
  let layoutKey = '';
  let layout: Layout = { laneH: LANE_MAX_H, contentH: 0 };
  const strips = new Map<string, HTMLButtonElement>();
  const stripTransform = new Map<string, string>();

  // ---------- swipe state ----------
  const rows = new Map<string, Row>();
  /** lanes sliding to a new y after the lane list changed: dy = from * (1 - ease(t)) */
  const slides = new Map<string, { from: number; start: number }>();
  let lastY = new Map<string, number>(); // base y of each lane at the last layout
  let swipeId: string | null = null; // the row under the finger
  let cancelPendingHold: (() => void) | null = null;
  let swallowClick = false; // set after a lane-menu hold, a swipe, or a closing tap; the next strip click is ignored
  let swallowOutsideClick = false;
  let lastFrameMs = 0;

  const anyOpen = (): boolean => [...rows.values()].some((r) => r.open && !r.removing);

  function slideDy(id: string, nowMs: number): number {
    const s = slides.get(id);
    if (!s) return 0;
    const t = (nowMs - s.start) / SLIDE_MS;
    if (t >= 1) {
      slides.delete(id);
      return 0;
    }
    return s.from * (1 - easeOut(Math.max(0, t)));
  }
  const offsetOf = (id: string, nowMs = lastFrameMs): { dx: number; dy: number } => ({ dx: rows.get(id)?.x ?? 0, dy: slideDy(id, nowMs) });

  function animateTo(row: Row, to: number, ms: number, done?: () => void): void {
    if (row.x === to && !row.anim) {
      done?.();
      return;
    }
    row.anim = { from: row.x, to, start: performance.now(), ms, ...(done ? { done } : {}) };
  }
  function openRow(row: Row): void {
    row.open = true;
    animateTo(row, -OPEN_W, SNAP_MS);
  }
  function closeRow(row: Row): void {
    row.open = false;
    animateTo(row, 0, SNAP_MS);
  }
  function closeAll(except?: string): void {
    for (const row of rows.values()) if (row.id !== except && (row.open || row.x < 0) && !row.removing) closeRow(row);
  }
  /** full swipe / Delete button: the lane flies off to the left, then onDelete (the others slide up when the track is gone) */
  function deleteRow(row: Row): void {
    row.open = false;
    row.dragging = false;
    row.removing = true;
    row.removedAt = performance.now();
    row.el.classList.add('deleting');
    animateTo(row, -areaW, REMOVE_MS, () => opts.onDelete(row.id));
  }

  function createRow(id: string): Row {
    const el = div('swipe-actions');
    el.dataset.noGesture = '';
    el.dataset.id = id;
    const row: Row = { id, x: 0, base: 0, dragging: false, open: false, removing: false, removedAt: 0, anim: null, el, geom: '' };
    const dup = actionButton('swipe-dup', ICON_COPY, 'duplicate');
    const del = actionButton('swipe-del', ICON_TRASH, 'delete');
    dup.addEventListener('click', () => {
      opts.onDuplicate(id);
      closeRow(row);
    });
    del.addEventListener('click', () => deleteRow(row));
    el.append(dup, del);
    content.append(el);
    rows.set(id, row);
    return row;
  }
  function dropRow(row: Row): void {
    row.el.remove();
    rows.delete(row.id);
  }

  /** advance animations, drop finished/orphaned rows, place the action boxes */
  function stepRows(nowMs: number, tracks: Track[]): void {
    for (const row of [...rows.values()]) {
      const index = tracks.findIndex((t) => t.id === row.id);
      if (index < 0) {
        dropRow(row);
        continue;
      }
      const a = row.anim;
      if (a) {
        const t = Math.min(1, Math.max(0, (nowMs - a.start) / a.ms));
        row.x = a.from + (a.to - a.from) * easeOut(t);
        if (t >= 1) {
          row.anim = null;
          row.x = a.to;
          a.done?.();
        }
      }
      if (row.removing && !row.anim && performance.now() - row.removedAt > REMOVE_TIMEOUT_MS) {
        row.removing = false; // onDelete changed nothing: bring the lane back
        row.el.classList.remove('deleting');
        closeRow(row);
      }
      if (!row.dragging && !row.anim && !row.open && !row.removing && row.x === 0) {
        dropRow(row);
        continue;
      }
      const reveal = Math.max(0, -row.x);
      const y = laneRect(index, layout.laneH, areaW).y + slideDy(row.id, nowMs);
      const geom = `${reveal.toFixed(1)}|${y.toFixed(1)}|${layout.laneH}`;
      if (geom === row.geom) continue;
      row.geom = geom;
      row.el.style.display = reveal < 0.5 ? 'none' : 'flex';
      row.el.style.width = `${reveal}px`;
      row.el.style.top = `${y}px`;
      row.el.style.height = `${layout.laneH}px`;
    }
  }

  // ---------- strips ----------
  function handleStripClick(trackId: string): void {
    if (opts.view().session.selectedId === trackId) opts.onToggle(trackId);
    else opts.onSelect(trackId);
  }

  // Hold: pointerdown arms a timer; if it fires while still pressed the lane menu opens and the release's click is swallowed.
  // `swallowClick` is cleared at the next pointerdown, so a release that never produces a click on the strip cannot eat a later tap.
  let closeMenu: (() => void) | null = null;

  function openMenu(trackId: string, button: HTMLElement): void {
    const track = opts.view().session.tracks.find((t) => t.id === trackId);
    if (!track) return;
    try {
      navigator.vibrate?.(HOLD_HAPTIC_MS);
    } catch {
      /* haptics are optional */
    }
    closeMenu?.();
    closeMenu = openLaneMenu(root, button, track, opts);
  }

  function armHold(button: HTMLButtonElement, trackId: string): void {
    let timer = 0;
    const cancel = (): void => window.clearTimeout(timer);
    button.addEventListener('pointerdown', (e) => {
      swallowClick = false;
      if (e.button !== 0) return;
      cancel();
      cancelPendingHold = cancel;
      timer = window.setTimeout(() => {
        swallowClick = true;
        openMenu(trackId, button);
      }, HOLD_MS);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, cancel);
  }

  function createStrip(track: Track): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'lane-strip';
    button.dataset.noGesture = '';
    button.dataset.swipeThrough = ''; // input.ts lets a sideways swipe start here
    button.dataset.id = track.id;
    button.setAttribute('aria-label', `${track.kind} lane`);
    button.addEventListener('click', () => {
      if (swallowClick) swallowClick = false;
      else if (anyOpen()) closeAll(); // a tap while a lane is open only closes it
      else handleStripClick(track.id);
    });
    armHold(button, track.id);
    content.append(button);
    return button;
  }

  /** one strip button per track, positioned over the lane's left 56 px */
  function syncStrips(tracks: Track[]): void {
    const ids = new Set(tracks.map((t) => t.id));
    for (const [id, button] of strips) {
      if (ids.has(id)) continue;
      button.remove();
      strips.delete(id);
      stripTransform.delete(id);
    }
    tracks.forEach((track, i) => {
      const button = strips.get(track.id) ?? createStrip(track);
      strips.set(track.id, button);
      const lane = laneRect(i, layout.laneH, areaW);
      button.style.left = `${lane.x}px`;
      button.style.top = `${lane.y}px`;
      button.style.width = `${STRIP_W}px`;
      button.style.height = `${lane.h}px`;
    });
  }

  function applyLayout(tracks: Track[], dpr: number, nowMs: number): void {
    const key = `${areaW}x${areaH}|${dpr}|${tracks.map((t) => t.id).join(',')}`;
    if (key === layoutKey) return;
    layoutKey = key;
    layout = computeLayout(areaH, tracks.length);
    content.style.height = `${layout.contentH}px`;
    canvas.style.width = `${areaW}px`;
    canvas.style.height = `${layout.contentH}px`;
    canvas.width = Math.round(areaW * dpr);
    canvas.height = Math.round(layout.contentH * dpr);
    syncStrips(tracks);
    // lanes that stay but change place slide from where they were drawn
    const next = new Map<string, number>();
    tracks.forEach((t, i) => {
      const y = laneRect(i, layout.laneH, areaW).y;
      next.set(t.id, y);
      const before = lastY.get(t.id);
      if (before !== undefined && Math.abs(before + slideDy(t.id, nowMs) - y) > 0.5) slides.set(t.id, { from: before + slideDy(t.id, nowMs) - y, start: nowMs });
    });
    lastY = next;
    for (const row of rows.values()) row.geom = '';
  }

  function applyStripTransforms(tracks: Track[], nowMs: number): void {
    for (const t of tracks) {
      const button = strips.get(t.id);
      if (!button) continue;
      const o = offsetOf(t.id, nowMs);
      const value = o.dx === 0 && o.dy === 0 ? '' : `translate(${o.dx}px, ${o.dy}px)`;
      if (stripTransform.get(t.id) === value) continue;
      stripTransform.set(t.id, value);
      button.style.transform = value;
    }
  }

  let raf = 0;
  function frame(nowMs: number): void {
    raf = requestAnimationFrame(frame);
    lastFrameMs = nowMs;
    if (areaW === 0 || areaH === 0) return;
    const view = opts.view();
    const tracks = view.session.tracks;
    const dpr = window.devicePixelRatio || 1;
    applyLayout(tracks, dpr, nowMs);
    stepRows(nowMs, tracks);

    const env: DrawEnv = { g, p: palette, dpr, nowMs };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, areaW, layout.contentH);
    const axis = axisOf(view);
    tracks.forEach((track, i) => {
      const o = offsetOf(track.id, nowMs);
      g.save();
      g.translate(o.dx, o.dy);
      drawLane(env, i, layout.laneH, areaW, track, view, axis);
      g.restore();
    });
    drawPlayhead(env, view, axis, areaW, layout.laneH, (id) => offsetOf(id, nowMs));
    applyStripTransforms(tracks, nowMs);
  }
  raf = requestAnimationFrame(frame);

  // A press on a button/control outside the open lane (transport, top bar, another strip's menu ...) closes it and does nothing else.
  // Presses on the stage itself are handled by input.ts (swipe.open / swipe.dismiss); the lane's own strip and action buttons are exempt.
  function onWindowPointerDown(e: PointerEvent): void {
    swallowOutsideClick = false;
    if (!anyOpen() || !(e.target instanceof Element)) return;
    const t = e.target;
    if (!t.closest('[data-no-gesture]') || t.closest('.swipe-actions') || t.closest('[data-swipe-through]')) return;
    closeAll();
    swallowOutsideClick = true;
    e.stopPropagation();
  }
  function onWindowClick(e: MouseEvent): void {
    if (!swallowOutsideClick) return;
    swallowOutsideClick = false;
    e.stopPropagation();
    e.preventDefault();
  }
  window.addEventListener('pointerdown', onWindowPointerDown, true);
  window.addEventListener('click', onWindowClick, true);

  /** the track whose lane row is under clientY (lane rows only, not the gaps or empty space) */
  function trackAtY(clientY: number): string | null {
    const tracks = opts.view().session.tracks;
    const y = clientY - area.getBoundingClientRect().top + area.scrollTop;
    const stride = layout.laneH + LANE_GAP;
    const index = Math.floor(y / stride);
    if (y < 0 || index >= tracks.length || y - index * stride > layout.laneH) return null;
    return tracks[index]!.id;
  }

  const swipe: LanesApi['swipe'] = {
    start(_clientX, clientY) {
      const id = trackAtY(clientY);
      if (id === null) return false;
      cancelPendingHold?.();
      swallowClick = true;
      closeAll(id);
      const row = rows.get(id) ?? createRow(id);
      if (row.removing) return false;
      row.anim = null;
      row.base = row.x;
      row.dragging = true;
      swipeId = id;
      return true;
    },
    move(dx) {
      const row = swipeId === null ? undefined : rows.get(swipeId);
      if (!row?.dragging) return;
      const total = Math.min(0, row.base + dx);
      row.x = total < -OPEN_W ? -OPEN_W + (total + OPEN_W) * RUBBER : total;
    },
    end(dx, vx) {
      const row = swipeId === null ? undefined : rows.get(swipeId);
      swipeId = null;
      if (!row?.dragging) return;
      row.dragging = false;
      const total = Math.min(0, row.base + dx);
      if (total < -(areaW - 2 * LANE_MARGIN_X) * DELETE_FRAC && vx < -DELETE_V) deleteRow(row);
      else if (vx > FLICK_V) closeRow(row);
      else if (total < -SNAP_OPEN_PX || vx < -FLICK_V) openRow(row);
      else closeRow(row);
    },
    open: anyOpen,
    dismiss: () => closeAll(),
  };

  /** the lane body (x BODY_LEFT .. laneWidth - BODY_RIGHT_PAD, lane-local) is the time axis; taps left/right of it clamp */
  function posAt(clientX: number): Sec | null {
    const length = opts.view().session.loopLength;
    if (!length) return null;
    const bodyLeft = area.getBoundingClientRect().left + LANE_MARGIN_X + BODY_LEFT;
    const bodyW = area.clientWidth - 2 * LANE_MARGIN_X - BODY_LEFT - BODY_RIGHT_PAD;
    if (bodyW <= 0) return null;
    const frac = (clientX - bodyLeft) / bodyW;
    return Math.min(Math.max(frac, 0) * length, length - POS_EPSILON);
  }

  return {
    posAt,
    swipe,
    destroy: () => {
      cancelAnimationFrame(raf);
      closeMenu?.();
      window.removeEventListener('pointerdown', onWindowPointerDown, true);
      window.removeEventListener('click', onWindowClick, true);
      resizeObserver.disconnect();
      area.remove();
      strips.clear();
      rows.clear();
    },
  };
}
