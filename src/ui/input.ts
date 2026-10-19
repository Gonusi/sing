// [shell] Gesture layer: tap (< holdMs, fires on release) vs hold (holdStart at holdMs, holdEnd on release) vs swipe (hand-off to opts.onSwipe).
// A tap carries x/y (client coordinates at pointerdown; absent for the Space key). Times come from opts.now() (ctx.currentTime) at pointerdown. Targets inside [data-no-gesture] are ignored.
// One press at a time: the first pointer (or the Space key) owns the gesture until it ends.
// Moving the finger never cancels a tap/hold, except a sideways swipe: before the hold timer fires, a move of > SWIPE_SLOP_PX with |dx| > SWIPE_RATIO * |dy|
// calls onSwipe.start(x0, y0); true -> the press is a swipe (move/end are forwarded, no tap/hold is emitted); false -> the rest of the press is ignored.
// Extras (optional members of onSwipe, used by lanes): open() = something is swiped open, so a plain tap on the stage only calls dismiss() (no tap/hold emitted);
// targets marked [data-swipe-through] (lane strip buttons) are inside a no-gesture zone but can still start a swipe (a plain press there is left to the button).
// Only pointercancel / window blur end a press early.
import type { Gesture, Sec } from '../types.ts';

export interface SwipeHandler {
  /** a sideways move began at (x, y) client px; true = a swipe takes the press */
  start(x: number, y: number): boolean;
  /** dx = pointer x - x at pointerdown (px) */
  move(dx: number): void;
  /** release/cancel; vx = px per ms over the last ~80 ms (0 when the finger rested) */
  end(dx: number, vx: number): void;
  /** true while a swipe is open: the next plain tap on the stage only calls dismiss() */
  open?(): boolean;
  dismiss?(): void;
}

export interface InputOptions {
  now: () => Sec;
  onGesture: (g: Gesture) => void;
  holdMs?: number;
  onSwipe?: SwipeHandler;
}

const DEFAULT_HOLD_MS = 300;
const NO_GESTURE_SELECTOR = '[data-no-gesture]';
const SWIPE_THROUGH_SELECTOR = '[data-swipe-through]';
const SWIPE_SLOP_PX = 12;
const SWIPE_RATIO = 1.5;
const VELOCITY_WINDOW_MS = 80;
/** pseudo pointer id used for the Space key (real pointer ids are >= 0) */
const KEYBOARD_ID = -1;

function inZone(target: EventTarget | null, selector: string): boolean {
  return target instanceof Element && target.closest(selector) !== null;
}

type SwipeMode = 'pending' | 'swipe' | 'ignored';

export function mountInput(el: HTMLElement, opts: InputOptions): () => void {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;

  let activeId: number | null = null;
  let tDown: Sec = 0;
  let downX: number | undefined;
  let downY: number | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdStarted = false;
  let swipeMode: SwipeMode = 'pending';
  /** the press began on a [data-swipe-through] button: only a swipe is ours, a plain press is the button's */
  let swipeOnly = false;
  /** a swipe was open at pointerdown: a plain release dismisses it instead of emitting a gesture */
  let dismissMode = false;
  let lastDx = 0;
  let samples: Array<{ t: number; x: number }> = [];

  function clearTimer(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
  }

  function reset(): void {
    clearTimer();
    activeId = null;
    holdStarted = false;
    swipeMode = 'pending';
    swipeOnly = false;
    dismissMode = false;
    samples = [];
    lastDx = 0;
  }

  function press(id: number, x?: number, y?: number, flags: { swipeOnly?: boolean } = {}): void {
    if (activeId !== null) return;
    activeId = id;
    holdStarted = false;
    swipeMode = 'pending';
    swipeOnly = flags.swipeOnly === true;
    dismissMode = !swipeOnly && x !== undefined && opts.onSwipe?.open?.() === true;
    samples = [];
    lastDx = 0;
    tDown = opts.now();
    downX = x;
    downY = y;
    if (swipeOnly || dismissMode) return;
    const downAt = tDown;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      holdStarted = true;
      opts.onGesture({ type: 'holdStart', tDown: downAt });
    }, holdMs);
  }

  function velocity(): number {
    const now = performance.now();
    samples.push({ t: now, x: lastDx });
    const recent = samples.filter((s) => s.t >= now - VELOCITY_WINDOW_MS);
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
  }

  function finishSwipe(): void {
    opts.onSwipe?.end(lastDx, velocity());
    reset();
  }

  function release(id: number): void {
    if (activeId !== id) return;
    if (swipeMode === 'swipe') return finishSwipe();
    if (swipeMode === 'ignored' || swipeOnly) return reset();
    if (dismissMode) {
      opts.onSwipe?.dismiss?.();
      return reset();
    }
    clearTimer();
    if (holdStarted) opts.onGesture({ type: 'holdEnd', tDown, tUp: opts.now() });
    else opts.onGesture({ type: 'tap', tDown, ...(downX !== undefined && downY !== undefined ? { x: downX, y: downY } : {}) });
    reset();
  }

  /** pointercancel / blur: a started hold still ends (so the recogniser stops); a pending tap is dropped */
  function cancel(id: number): void {
    if (activeId !== id) return;
    if (swipeMode === 'swipe') return finishSwipe();
    clearTimer();
    if (holdStarted) opts.onGesture({ type: 'holdEnd', tDown, tUp: opts.now() });
    reset();
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activeId !== null) return;
    if (inZone(e.target, NO_GESTURE_SELECTOR)) {
      // lane strip buttons: not ours, except for a sideways swipe
      if (opts.onSwipe && inZone(e.target, SWIPE_THROUGH_SELECTOR)) press(e.pointerId, e.clientX, e.clientY, { swipeOnly: true });
      return;
    }
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic or already-ended pointers cannot be captured; the gesture still works
    }
    press(e.pointerId, e.clientX, e.clientY);
  }
  function onPointerMove(e: PointerEvent): void {
    const swipe = opts.onSwipe;
    if (!swipe || e.pointerId !== activeId || downX === undefined || downY === undefined) return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    if (swipeMode === 'pending') {
      if (holdStarted || Math.abs(dx) <= SWIPE_SLOP_PX || Math.abs(dx) <= SWIPE_RATIO * Math.abs(dy)) return;
      clearTimer();
      swipeMode = swipe.start(downX, downY) ? 'swipe' : 'ignored';
    }
    if (swipeMode !== 'swipe') return;
    lastDx = dx;
    samples.push({ t: performance.now(), x: dx });
    if (samples.length > 40) samples.splice(0, samples.length - 40);
    swipe.move(dx);
  }
  const onPointerUp = (e: PointerEvent): void => release(e.pointerId);
  const onPointerCancel = (e: PointerEvent): void => cancel(e.pointerId);

  /** stops the iOS magnifier / callout; never on no-gesture zones, or their buttons would lose their click */
  function onTouchStart(e: TouchEvent): void {
    if (!inZone(e.target, NO_GESTURE_SELECTOR)) e.preventDefault();
  }
  function onContextMenu(e: Event): void {
    e.preventDefault();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.code !== 'Space' || inZone(e.target, NO_GESTURE_SELECTOR)) return;
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
  el.addEventListener('pointermove', onPointerMove);
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
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerCancel);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
