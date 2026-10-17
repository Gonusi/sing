// [shell] Gesture layer: tap (< holdMs, fires on release) vs hold (holdStart at holdMs, holdEnd on release).
// Times come from opts.now() (ctx.currentTime) at pointerdown. Targets inside [data-no-gesture] are ignored.
import type { Gesture, Sec } from '../types.ts';

export interface InputOptions {
  now: () => Sec;
  onGesture: (g: Gesture) => void;
  holdMs?: number;
}

export function mountInput(_el: HTMLElement, _opts: InputOptions): () => void {
  // STUB (shell replaces)
  return () => {};
}
