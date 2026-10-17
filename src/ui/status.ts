// [shell] Status pill (bottom centre), toast, command-mode overlay (tint + partial text), empty-state hint, flash.
// Everything is DOM, updated in one requestAnimationFrame loop; each element is touched only when its
// text / class / opacity actually changed.
import type { AppState, UiView } from '../types.ts';

const TOAST_VISIBLE_MS = 1600;
const TOAST_FADE_MS = 400;
const FLASH_ALPHA = 0.07;
const FLASH_MS = 180;

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

const seconds = (s: number): string => `${Math.max(0, s).toFixed(1)} s`;

// ---------- pill ----------
/** changes exactly when the pill's text or structure must be rebuilt (the playing bar's fill is separate) */
function pillKey(v: UiView): string {
  switch (v.state) {
    case 'idle':
      return v.voice === 'loading' ? `idle|${Math.round(v.voiceProgress * 100)}` : 'idle';
    case 'recordingFirst':
      return `recordingFirst|${seconds(v.elapsed ?? 0)}`;
    case 'playing':
      return `playing|${seconds(v.session.loopLength ?? 0)}`;
    case 'overdubbing':
      return `overdubbing|${seconds(v.elapsed ?? 0)}`;
    case 'stopped':
      return 'stopped';
  }
}

/** every piece is its own element: adjacent text nodes would merge into one flex item and lose the gap */
function pillChildren(v: UiView, barFill: HTMLElement): HTMLElement[] {
  const text = (t: string): HTMLElement => span('', t);
  switch (v.state) {
    case 'idle':
      return [text(v.voice === 'loading' ? `ready · voice ${Math.round(v.voiceProgress * 100)}%` : 'ready')];
    case 'recordingFirst':
      return [span('pill-dot', ''), text(seconds(v.elapsed ?? 0))];
    case 'playing': {
      const bar = span('pill-bar', '');
      bar.append(barFill);
      return [text('▶'), bar, text(seconds(v.session.loopLength ?? 0))];
    }
    case 'overdubbing':
      return [span('pill-dot', ''), text('overdub'), text(seconds(v.elapsed ?? 0))];
    case 'stopped':
      return [text('■ stopped · tap to play')];
  }
}

// ---------- toast ----------
function toastOpacity(ageMs: number): number {
  if (ageMs >= TOAST_VISIBLE_MS) return 0;
  const fadeStart = TOAST_VISIBLE_MS - TOAST_FADE_MS;
  return ageMs <= fadeStart ? 1 : (TOAST_VISIBLE_MS - ageMs) / TOAST_FADE_MS;
}

export function mountStatus(root: HTMLElement, opts: { view: () => UiView }): () => void {
  const bottom = div('bottom');
  const pill = div('pill');
  const barFill = span('pill-bar-fill', '');
  const toast = div('toast');
  bottom.append(toast, pill);

  const hint = div('hint');
  hint.append(div('', 'tap to sing · hold to speak'), div('', '‘create violin track’'));

  const overlay = div('cmd-overlay');
  const partial = div('cmd-partial');
  overlay.append(div('cmd-label', 'LISTENING…'), partial);

  const flash = div('flash');
  root.append(hint, bottom, overlay, flash);

  // last rendered values, to touch the DOM only on change
  let lastPillKey = '';
  let lastBarWidth = '';
  let lastToastText = '';
  let lastToastKind = '';
  let lastToastOpacity = '';
  let lastPartial = '';
  let lastHolding = false;
  let lastHint = false;
  // flash triggers: no flash for what is already there at mount
  const first = opts.view();
  let lastState: AppState = first.state;
  let lastToastAt: number | null = first.toast?.at ?? null;

  function doFlash(): void {
    flash.animate([{ opacity: FLASH_ALPHA }, { opacity: 0 }], { duration: FLASH_MS, easing: 'ease-out' });
  }

  function updatePill(v: UiView): void {
    const key = pillKey(v);
    if (key !== lastPillKey) {
      lastPillKey = key;
      pill.className = `pill ${v.state}`;
      pill.replaceChildren(...pillChildren(v, barFill));
      lastBarWidth = '';
    }
    if (v.state === 'playing') {
      const length = v.session.loopLength ?? 0;
      const frac = length > 0 && v.loopPos !== null ? Math.min(1, Math.max(0, v.loopPos / length)) : 0;
      const width = `${(frac * 100).toFixed(1)}%`;
      if (width !== lastBarWidth) {
        lastBarWidth = width;
        barFill.style.width = width;
      }
    }
  }

  function updateToast(v: UiView, nowMs: number): void {
    const t = v.toast;
    if (t && t.at !== lastToastAt) {
      lastToastAt = t.at;
      doFlash();
    }
    if (!t) return;
    if (t.text !== lastToastText) {
      lastToastText = t.text;
      toast.textContent = t.text;
    }
    if (t.kind !== lastToastKind) {
      lastToastKind = t.kind;
      toast.classList.toggle('err', t.kind === 'err');
    }
    const opacity = String(toastOpacity(nowMs - t.at));
    if (opacity !== lastToastOpacity) {
      lastToastOpacity = opacity;
      toast.style.opacity = opacity;
    }
  }

  function updateOverlay(v: UiView): void {
    if (v.holding !== lastHolding) {
      lastHolding = v.holding;
      overlay.classList.toggle('on', v.holding);
    }
    if (v.partial !== lastPartial) {
      lastPartial = v.partial;
      partial.textContent = v.partial;
    }
  }

  function updateHint(v: UiView): void {
    const show = v.session.tracks.length === 0 && v.state === 'idle';
    if (show === lastHint) return;
    lastHint = show;
    hint.classList.toggle('on', show);
  }

  let raf = 0;
  function frame(nowMs: number): void {
    raf = requestAnimationFrame(frame);
    const v = opts.view();
    if (v.state !== lastState) {
      lastState = v.state;
      doFlash();
    }
    updatePill(v);
    updateToast(v, nowMs);
    updateOverlay(v);
    updateHint(v);
  }
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    hint.remove();
    bottom.remove();
    overlay.remove();
    flash.remove();
  };
}
