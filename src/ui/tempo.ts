// [shell] Tempo control for the top bar's left slot: [−] 92 [+] with "bpm" under the number.
//   − / +  : one step per press, press-and-hold repeats (400 ms, then every 120 ms)
//   number : short tap (< 450 ms) = metronome click on/off; hold >= 450 ms = native picker (a hidden <select> 40..200)
//   pulse  : while view.beat is non-null the number flashes on every beat (downbeat stronger), --rec while counting in /
//            recording, otherwise a subtle --fg; muted click = dim number with a slash, the pulse still shows
// Locked tempo (!view.tempoEditable): the buttons look dim, the picker never opens; a press still calls onSetTempo once
// (no repeat) so main.ts can say why it is refused.
// Picker: the hold dims/arms the number at 450 ms and opens the picker on RELEASE (a touch release grants the user
// activation that select.showPicker() needs). Without showPicker (or if it throws) the select is shown in place of the
// number and focused; one more tap opens it on iOS.
import { TEMPO_MAX_BPM, TEMPO_MIN_BPM, type AppState, type UiView } from '../types.ts';

export interface TempoOptions {
  view: () => UiView;
  onToggleClick(): void;
  onSetTempo(bpm: number): void;
  clickOn: () => boolean;
}

const HOLD_MS = 450; // number: >= this opens the picker
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 120;
const PULSE_DECAY_PHASE = 0.6; // the flash is gone after this share of the beat
/** flash strength (percent of the colour) at the start of a beat: [downbeat, other beat] */
const PULSE_PCT_REC: [number, number] = [60, 32];
const PULSE_PCT_FG: [number, number] = [24, 11];

const clampBpm = (bpm: number): number => Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, Math.round(bpm)));
const isRecordingish = (s: AppState): boolean => s === 'countIn' || s === 'recordingFirst' || s === 'overdubbing';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function mountTempo(slot: HTMLElement, opts: TempoOptions): () => void {
  const root = el('div', 'tempo');
  const down = el('button', 'tempo-step', '−');
  const up = el('button', 'tempo-step', '+');
  for (const [b, label, dir] of [[down, 'slower', -1], [up, 'faster', 1]] as const) {
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.dataset.tempo = dir < 0 ? 'down' : 'up';
  }

  const mid = el('div', 'tempo-mid');
  const num = el('button', 'tempo-num');
  num.type = 'button';
  num.setAttribute('aria-label', 'metronome (tap) · tempo (hold)');
  const value = el('span', 'tempo-val', String(opts.view().tempo.bpm));
  num.append(value, el('i', 'tempo-slash'));
  const unit = el('span', 'tempo-unit', 'bpm');
  const select = el('select', 'tempo-select');
  select.tabIndex = -1;
  select.setAttribute('aria-label', 'tempo');
  for (let bpm = TEMPO_MIN_BPM; bpm <= TEMPO_MAX_BPM; bpm++) select.append(new Option(String(bpm), String(bpm)));
  mid.append(num, select, unit);
  root.append(down, mid, up);
  slot.append(root);

  const currentBpm = (): number => opts.view().tempo.bpm;
  const editable = (): boolean => opts.view().tempoEditable;

  // ---------- − / + ----------
  let repeatTimer = 0;
  const stopRepeat = (): void => {
    window.clearTimeout(repeatTimer);
    window.clearInterval(repeatTimer);
    repeatTimer = 0;
  };
  function step(dir: -1 | 1): void {
    opts.onSetTempo(clampBpm(currentBpm() + dir));
  }
  function armStep(b: HTMLButtonElement, dir: -1 | 1): void {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
      stopRepeat();
      step(dir);
      if (!editable()) return;
      repeatTimer = window.setTimeout(() => {
        repeatTimer = window.setInterval(() => (editable() ? step(dir) : stopRepeat()), REPEAT_EVERY_MS);
      }, REPEAT_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, stopRepeat);
    b.addEventListener('click', (e) => {
      if (e.detail === 0) step(dir); // keyboard
    });
  }
  armStep(down, -1);
  armStep(up, 1);

  // ---------- number: tap = click on/off, hold = picker ----------
  let holdTimer = 0;
  let armed = false; // the 450 ms hold has elapsed while still pressed
  let pressing = false;
  select.addEventListener('change', () => {
    closePicker();
    opts.onSetTempo(clampBpm(Number(select.value)));
  });
  select.addEventListener('blur', closePicker);

  function closePicker(): void {
    root.classList.remove('picking');
    select.classList.remove('shown');
  }

  function openPicker(): void {
    if (!editable()) {
      opts.onSetTempo(currentBpm()); // refused by the controller; main says why
      return;
    }
    select.value = String(currentBpm());
    root.classList.add('picking');
    if (typeof select.showPicker === 'function') {
      try {
        select.showPicker();
        return;
      } catch {
        /* not allowed here: fall through to the visible select */
      }
    }
    select.classList.add('shown');
    select.focus();
  }

  num.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try {
      num.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    closePicker();
    pressing = true;
    armed = false;
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      armed = true;
      num.classList.add('armed');
      navigator.vibrate?.(10);
    }, HOLD_MS);
  });
  const endPress = (): void => {
    window.clearTimeout(holdTimer);
    num.classList.remove('armed');
    pressing = false;
    armed = false;
  };
  num.addEventListener('pointerup', () => {
    if (!pressing) return;
    const wasHold = armed;
    endPress();
    if (wasHold) openPicker();
    else opts.onToggleClick();
  });
  num.addEventListener('pointercancel', endPress);
  num.addEventListener('contextmenu', (e) => e.preventDefault());
  num.addEventListener('click', (e) => {
    if (e.detail === 0) opts.onToggleClick(); // keyboard
  });

  // ---------- render loop ----------
  let lastBpm = -1;
  let lastEditable: boolean | null = null;
  let lastMuted: boolean | null = null;
  let lastBackground = '';
  function frame(): void {
    raf = requestAnimationFrame(frame);
    const v = opts.view();
    if (v.tempo.bpm !== lastBpm) {
      lastBpm = v.tempo.bpm;
      value.textContent = String(v.tempo.bpm);
    }
    if (v.tempoEditable !== lastEditable) {
      lastEditable = v.tempoEditable;
      root.classList.toggle('locked', !v.tempoEditable);
    }
    const muted = !opts.clickOn();
    if (muted !== lastMuted) {
      lastMuted = muted;
      root.classList.toggle('muted', muted);
    }
    let background = '';
    if (v.beat) {
      const pct = (isRecordingish(v.state) ? PULSE_PCT_REC : PULSE_PCT_FG)[v.beat.beat === 1 ? 0 : 1];
      const decay = Math.max(0, 1 - v.beat.phase / PULSE_DECAY_PHASE);
      const strength = Math.round(pct * decay);
      if (strength > 0) background = `color-mix(in srgb, var(${isRecordingish(v.state) ? '--rec' : '--fg'}) ${strength}%, transparent)`;
    }
    if (background !== lastBackground) {
      lastBackground = background;
      num.style.background = background;
    }
  }
  let raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    stopRepeat();
    window.clearTimeout(holdTimer);
    root.remove();
  };
}
