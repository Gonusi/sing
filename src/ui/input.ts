// [shell] Gesture layer: tap (< holdMs, fires on release) vs hold (holdStart at holdMs, holdEnd on release).
// A tap carries x/y (client coordinates at pointerdown; absent for the Space key). Times come from opts.now() (ctx.currentTime) at pointerdown. Targets inside [data-no-gesture] are ignored.
// One press at a time: the first pointer (or the Space key) owns the gesture until it ends.
// Moving the finger never cancels. Only pointercancel / window blur end a press early.
import type { Gesture, Sec } from '../types.ts';

export interface InputOptions {
  now: () => Sec;
  onGesture: (g: Gesture) => void;
  holdMs?: number;
}

const DEFAULT_HOLD_MS = 300;
const NO_GESTURE_SELECTOR = '[data-no-gesture]';
/** pseudo pointer id used for the Space key (real pointer ids are >= 0) */
const KEYBOARD_ID = -1;

function inNoGestureZone(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NO_GESTURE_SELECTOR) !== null;
}

export function mountInput(el: HTMLElement, opts: InputOptions): () => void {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;

  let activeId: number | null = null;
  let tDown: Sec = 0;
  let downX: number | undefined;
  let downY: number | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdStarted = false;

  function clearTimer(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function press(id: number, x?: number, y?: number): void {
    if (activeId !== null) return;
    activeId = id;
    holdStarted = false;
    tDown = opts.now();
    downX = x;
    downY = y;
    const downAt = tDown;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holdStarted = true;
      opts.onGesture({ type: 'holdStart', tDown: downAt });
    }, holdMs);
  }

  function release(id: number): void {
    if (activeId !== id) return;
    clearTimer();
    if (holdStarted) opts.onGesture({ type: 'holdEnd', tDown, tUp: opts.now() });
    else opts.onGesture({ type: 'tap', tDown, ...(downX !== undefined && downY !== undefined ? { x: downX, y: downY } : {}) });
    activeId = null;
    holdStarted = false;
  }

  /** pointercancel / blur: a started hold still ends (so the recogniser stops); a pending tap is dropped */
  function cancel(id: number): void {
    if (activeId !== id) return;
    clearTimer();
    if (holdStarted) opts.onGesture({ type: 'holdEnd', tDown, tUp: opts.now() });
    activeId = null;
    holdStarted = false;
  }

  function onPointerDown(e: PointerEvent): void {
    if (inNoGestureZone(e.target)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activeId !== null) return;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already-ended pointers cannot be captured; the gesture still works
    }
    press(e.pointerId, e.clientX, e.clientY);
  }
  const onPointerUp = (e: PointerEvent): void => release(e.pointerId);
  const onPointerCancel = (e: PointerEvent): void => cancel(e.pointerId);

  /** stops the iOS magnifier / callout; never on no-gesture zones, or their buttons would lose their click */
  function onTouchStart(e: TouchEvent): void {
    if (!inNoGestureZone(e.target)) e.preventDefault();
  }
  function onContextMenu(e: Event): void {
    e.preventDefault();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.code !== 'Space' || inNoGestureZone(e.target)) return;
    e.preventDefault();
    if (!e.repeat) press(KEYBOARD_ID);
  }
  function onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') release(KEYBOARD_ID);
  }
  function onBlur(): void {
    if (activeId !== null) cancel(activeId);
  }

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('touchstart', onTouchStart, { passive: false });
  el.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return () => {
    clearTimer();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
