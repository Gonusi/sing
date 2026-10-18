// [shell] Setup step 5: your voice. Hum along with a reference note (api.singAlong) -> pitch offset saved as
// tuningOffset; then an optional "your range" (lowest / highest comfortable note via api.captureRange) saved as range.
import { buildCard, button, createLife, el, midiName, setResult, token, type CardParts, type Life, type SetupStep } from './kit.ts';

const TARGET_MIDI = 57; // A3
const SING_SEC = 4;
const RANGE_SEC = 3;
/** vertical span of the pitch view in semitones above/below the target */
const SPAN = 2;
const ON_PITCH_SEMITONES = 0.3;
/** |offset| below this many cents reads as "right on pitch" */
const ON_PITCH_CENTS = 10;
const VIEW_HEIGHT = 160;
const PAD = 14;

/** distance in semitones from the target, folded by octaves (a low voice sings the note an octave down) */
export function foldedDistance(midi: number, target: number): number {
  const d = midi - target;
  return d - 12 * Math.round(d / 12);
}

interface PitchView {
  canvas: HTMLCanvasElement;
  /** forget the trail and start the clock */
  reset(): void;
  push(midi: number | null): void;
}

function createPitchView(life: Life): PitchView {
  const canvas = el('canvas', 'wiz-pitch');
  let points: Array<{ t: number; d: number | null }> = [];
  let t0 = performance.now();
  const colors = { fg: token('--fg'), dim: token('--dim'), line: token('--line'), ok: token('--vocals') };

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(VIEW_HEIGHT * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    const mid = VIEW_HEIGHT / 2;
    const yOf = (d: number): number => mid - (Math.max(-SPAN, Math.min(SPAN, d)) / SPAN) * (mid - PAD);
    g.lineWidth = 1;
    g.strokeStyle = colors.line;
    g.setLineDash([4, 4]);
    for (const d of [-1, 1]) {
      g.beginPath();
      g.moveTo(0, yOf(d));
      g.lineTo(w, yOf(d));
      g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = colors.dim; // the target
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();
    const x = (t: number): number => Math.min(1, t / (SING_SEC * 1000)) * (w - 2 * PAD) + PAD;
    g.strokeStyle = colors.fg;
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (const p of points) {
      if (p.d === null) {
        pen = false;
        continue;
      }
      if (pen) g.lineTo(x(p.t), yOf(p.d));
      else g.moveTo(x(p.t), yOf(p.d));
      pen = true;
    }
    g.stroke();
    const last = points[points.length - 1];
    if (last && last.d !== null) {
      g.fillStyle = Math.abs(last.d) < ON_PITCH_SEMITONES ? colors.ok : colors.fg;
      g.beginPath();
      g.arc(x(last.t), yOf(last.d), 7, 0, Math.PI * 2);
      g.fill();
    }
  }
  // the canvas has no size until attached; draw once on the first push/reset
  return {
    canvas,
    reset: () => {
      points = [];
      t0 = performance.now();
      if (life.alive() && canvas.isConnected) draw();
    },
    push: (midi) => {
      if (!life.alive() || !canvas.isConnected) return;
      points.push({ t: performance.now() - t0, d: midi === null ? null : foldedDistance(midi, TARGET_MIDI) });
      draw();
    },
  };
}

function describeOffset(offset: number): string {
  const cents = Math.round(Math.abs(offset) * 100);
  if (cents < ON_PITCH_CENTS) return 'you sing right on pitch';
  return `you sing ${cents} cents ${offset < 0 ? 'flat' : 'sharp'} — I’ll correct for that`;
}

export const voiceStep: SetupStep = {
  id: 'voice',
  title: 'Your voice',
  mount(card, api, done) {
    const life = createLife();
    const ui = buildCard(card, 'Hum along with this note.');
    const view = createPitchView(life);
    const note = el('div', 'wiz-note'); // live note name during the range sub-step
    note.hidden = true;
    const start = button('start', 'go');
    const rangeBtn = button('your range');
    rangeBtn.hidden = true;
    const buttons = el('div', 'wiz-pair'); // range is optional: "next" is already enabled after the first result
    buttons.append(start, rangeBtn);
    ui.body.append(view.canvas, note, buttons);
    queueMicrotask(() => view.reset()); // first paint once attached

    async function sing(): Promise<void> {
      start.hidden = true;
      rangeBtn.hidden = true;
      view.reset();
      setResult(ui, 'hum along…', 'dim');
      let r: { ok: boolean; offset: number; spread: number };
      try {
        r = await api.singAlong(TARGET_MIDI, SING_SEC, view.push);
      } catch (e) {
        console.error(e);
        r = { ok: false, offset: 0, spread: 0 };
      }
      if (!life.alive()) return;
      if (!r.ok) {
        setResult(ui, 'I couldn’t hear a steady note — try again', 'bad');
        start.textContent = 'try again';
        start.hidden = false;
        done(false);
        return;
      }
      setResult(ui, describeOffset(r.offset), 'ok');
      try {
        await api.save({ tuningOffset: r.offset });
      } catch (e) {
        console.error(e);
      }
      if (!life.alive()) return;
      start.textContent = 'again';
      start.hidden = false;
      rangeBtn.hidden = false;
      done(true);
    }

    async function captureBoth(): Promise<void> {
      start.hidden = true;
      rangeBtn.hidden = true;
      view.canvas.hidden = true;
      note.hidden = false;
      const lo = await captureOne(ui, 'low');
      const hi = lo === null ? null : await captureOne(ui, 'high');
      if (!life.alive()) return;
      note.hidden = true;
      view.canvas.hidden = false;
      if (lo !== null && hi !== null && hi > lo) {
        ui.instruction.textContent = 'Hum along with this note.';
        try {
          await api.save({ range: { lo, hi } });
        } catch (e) {
          console.error(e);
        }
        if (!life.alive()) return;
        setResult(ui, `range ${midiName(lo)} – ${midiName(hi)} saved`, 'ok');
        start.hidden = false;
      } else {
        setResult(ui, 'I couldn’t get a clear range — try again', 'bad');
        rangeBtn.hidden = false;
        start.hidden = false;
      }
    }

    /** lowest / highest note: live note name while humming, resolves the held integer midi or null */
    async function captureOne(parts: CardParts, which: 'low' | 'high'): Promise<number | null> {
      parts.instruction.textContent = which === 'low' ? 'Hum your lowest comfortable note.' : 'Now hum your highest comfortable note.';
      note.textContent = '–';
      setResult(parts, 'hum…', 'dim');
      let held: number | null = null;
      try {
        held = await api.captureRange(which, RANGE_SEC, (m) => {
          if (life.alive()) note.textContent = m === null ? '–' : midiName(m);
        });
      } catch (e) {
        console.error(e);
      }
      if (!life.alive()) return null;
      if (held !== null) {
        note.textContent = midiName(held);
        setResult(parts, `${which === 'low' ? 'lowest' : 'highest'}: ${midiName(held)}`, 'ok');
        await new Promise((r) => setTimeout(r, 900));
      }
      return held;
    }

    start.addEventListener('click', () => void sing());
    rangeBtn.addEventListener('click', () => void captureBoth());
    return life.end;
  },
};
