// [shell] Canvas lanes: one horizontal band per track, notes/hits, live take, playhead, left strip (select, on/off).
// One <canvas class="lanes"> is redrawn every animation frame from view(). The strip buttons are DOM <button>s
// (data-no-gesture) laid over the canvas; the canvas only paints their circle + letter.
// Colours are read from the CSS tokens in style.css (single source of truth).
// Coordinates: "lane-local" x starts at the lane's left edge (LANE_MARGIN_X); all other x are canvas css px.
import type { DrumKind, InstrumentKind, Note, Sec, Track, UiView } from '../types.ts';

type OpenNote = NonNullable<UiView['openNote']>;

export interface LanesOptions {
  view: () => UiView;
  onSelect(trackId: string): void;
  onToggle(trackId: string): void;
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

// ---------- time axis and playhead ----------
const FIRST_TAKE_MIN_LENGTH: Sec = 4;
const PLAYHEAD_W = 1.5;
const PLAYHEAD_ALPHA = 0.7;
const DASH: [number, number] = [4, 6];

const LETTERS: Record<InstrumentKind, string> = { drums: 'D', violin: 'V', synth: 'S', bass: 'B' };
const KINDS: InstrumentKind[] = ['drums', 'violin', 'synth', 'bass'];

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

function drawLaneContent(env: DrawEnv, lane: Rect, track: Track, view: UiView, axis: Axis): void {
  const color = env.p.kind[track.kind];
  const body = bodyOf(lane);
  const recording = view.recordingTrackId === track.id;
  if (!track.take && !recording) drawEmptyLine(env, body);
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

function drawPlayhead(env: DrawEnv, view: UiView, axis: Axis, areaW: number, laneH: number): void {
  const count = view.session.tracks.length;
  if (count === 0) return;
  const body = bodyOf(laneRect(0, laneH, areaW));
  let pos: Sec | null = null;
  let color = rgba(env.p.fg, PLAYHEAD_ALPHA);
  if (view.state === 'recordingFirst') {
    pos = view.elapsed ?? 0;
    color = rgba(env.p.rec, 1);
  } else if (view.loopPos !== null && view.session.loopLength) {
    pos = view.loopPos;
  }
  if (pos === null) return;
  const { g } = env;
  const x = xAt(body, axis, pos);
  g.beginPath();
  g.moveTo(x, 0);
  g.lineTo(x, count * laneH + (count - 1) * LANE_GAP);
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

export function mountLanes(root: HTMLElement, opts: LanesOptions): () => void {
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

  function handleStripClick(trackId: string): void {
    if (opts.view().session.selectedId === trackId) opts.onToggle(trackId);
    else opts.onSelect(trackId);
  }

  function createStrip(track: Track): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'lane-strip';
    button.dataset.noGesture = '';
    button.dataset.id = track.id;
    button.setAttribute('aria-label', `${track.kind} lane`);
    button.addEventListener('click', () => handleStripClick(track.id));
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

  function applyLayout(tracks: Track[], dpr: number): void {
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
  }

  let raf = 0;
  function frame(nowMs: number): void {
    raf = requestAnimationFrame(frame);
    if (areaW === 0 || areaH === 0) return;
    const view = opts.view();
    const tracks = view.session.tracks;
    const dpr = window.devicePixelRatio || 1;
    applyLayout(tracks, dpr);

    const env: DrawEnv = { g, p: palette, dpr, nowMs };
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, areaW, layout.contentH);
    const axis = axisOf(view);
    tracks.forEach((track, i) => drawLane(env, i, layout.laneH, areaW, track, view, axis));
    drawPlayhead(env, view, axis, areaW, layout.laneH);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    resizeObserver.disconnect();
    area.remove();
    strips.clear();
  };
}
