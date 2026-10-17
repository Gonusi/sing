// [shell] Canvas lanes: one horizontal band per track, notes/hits, live take, playhead, left strip (select, on/off).
import type { UiView } from '../types.ts';

export interface LanesOptions {
  view: () => UiView;
  onSelect(trackId: string): void;
  onToggle(trackId: string): void;
}

export function mountLanes(_root: HTMLElement, _opts: LanesOptions): () => void {
  // STUB (shell replaces)
  return () => {};
}
