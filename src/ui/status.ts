// [shell] Toast (above the transport bar), command-mode overlay (tint + partial text), empty-state hint, flash.
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

// ---------- toast ----------
function toastOpacity(ageMs: number): number {
  if (ageMs >= TOAST_VISIBLE_MS) return 0;
  const fadeStart = TOAST_VISIBLE_MS - TOAST_FADE_MS;
  return ageMs <= fadeStart ? 1 : (TOAST_VISIBLE_MS - ageMs) / TOAST_FADE_MS;
}

export function mountStatus(root: HTMLElement, opts: { view: () => UiView }): () => void {
  const bottom = div('bottom');
  const toast = div('toast');
  bottom.append(toast);

  const hint = div('hint');
  hint.append(div('', 'press ● to record · hold to speak'), div('', '‘create violin track’'));

  const overlay = div('cmd-overlay');
  const partial = div('cmd-partial');
  overlay.append(div('cmd-label', 'LISTENING…'), partial);

  const flash = div('flash');
  root.append(hint, bottom, overlay, flash);

  // last rendered values, to touch the DOM only on change
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
