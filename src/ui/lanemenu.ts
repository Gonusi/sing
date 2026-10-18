// [shell] Lane menu: small popover opened by holding a lane's strip button (see lanes.ts). Items: mute/unmute, delete.
// Anchored right of the strip, vertically centred on the strip button, clamped inside the viewport.
// A transparent full-screen backdrop closes it on tap; Escape closes it too. Everything is data-no-gesture.
import type { Track } from '../types.ts';

export interface LaneMenuActions {
  onToggle(trackId: string): void;
  onDelete(trackId: string): void;
}

const ANCHOR_OVERLAP = 0; // px the menu overlaps the strip's right edge
const VIEWPORT_PAD = 8;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  node.dataset.noGesture = '';
  return node;
}

/** opens the menu for `track` next to `anchor`; returns close() */
export function openLaneMenu(parent: HTMLElement, anchor: HTMLElement, track: Track, actions: LaneMenuActions): () => void {
  const layer = el('div', 'lane-menu-layer');
  const backdrop = el('div', 'lane-menu-backdrop');
  const menu = el('div', 'lane-menu');
  menu.setAttribute('role', 'menu');
  menu.append(el('div', 'lane-menu-title', `${track.kind} track`));

  function close(): void {
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  }
  function item(label: string, className: string, run: () => void): void {
    const button = el('button', `lane-menu-item ${className}`.trim(), label);
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => {
      close();
      run();
    });
    menu.append(button);
  }

  item(track.on ? 'mute' : 'unmute', '', () => actions.onToggle(track.id));
  item('delete', 'danger', () => actions.onDelete(track.id));

  // The press that opened the menu ends on the backdrop (it now covers the strip), and its click must not close the menu:
  // only a click that began with a pointerdown on the backdrop closes it.
  let pressedOnBackdrop = false;
  backdrop.addEventListener('pointerdown', () => {
    pressedOnBackdrop = true;
  });
  backdrop.addEventListener('click', () => {
    if (pressedOnBackdrop) close();
  });
  layer.append(backdrop, menu);
  parent.append(layer);

  const a = anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  const top = Math.min(Math.max(VIEWPORT_PAD, a.top + a.height / 2 - h / 2), window.innerHeight - h - VIEWPORT_PAD);
  const left = Math.min(a.right - ANCHOR_OVERLAP, window.innerWidth - menu.offsetWidth - VIEWPORT_PAD);
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  window.addEventListener('keydown', onKey, true);
  return close;
}
