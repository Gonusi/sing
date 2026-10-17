// [shell] "tap to start" screen. onTap is called SYNCHRONOUSLY in the pointerup handler (iOS audio unlock).
// Phases: waiting -> starting (first tap) -> error (main.ts calls error()) -> next tap reloads the page.
// progress() shows a thin bar at 30% from the bottom; remove() fades the whole screen out.
export interface StartScreen {
  progress(fraction: number, label?: string): void;
  error(message: string): void;
  remove(): void;
}

const TEXT_WAITING = 'tap to start';
const TEXT_STARTING = 'starting…';
const TEXT_RETRY = 'tap to retry';
const FADE_MS = 200;

type Phase = 'waiting' | 'starting' | 'error';

function div(className: string, text?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function mountStart(root: HTMLElement, onTap: () => void): StartScreen {
  let phase: Phase = 'waiting';

  const el = div('start');
  el.setAttribute('role', 'button');
  const text = div('start-text', TEXT_WAITING);
  const progressBox = div('start-progress');
  const fill = div('start-fill');
  const track = div('start-track');
  const label = div('start-label');
  track.append(fill);
  progressBox.append(track, label);
  el.append(div('start-wordmark', 'Sing'), text, progressBox);
  root.append(el);

  function showError(message: string): void {
    phase = 'error';
    text.className = 'start-text error';
    text.textContent = message;
    text.append(document.createElement('br'), div('start-retry', TEXT_RETRY));
    progressBox.classList.remove('visible');
  }

  el.addEventListener('pointerup', () => {
    if (phase === 'starting') return;
    if (phase === 'error') {
      location.reload();
      return;
    }
    phase = 'starting';
    text.textContent = TEXT_STARTING;
    try {
      onTap();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    }
  });

  return {
    progress(fraction, newLabel) {
      if (phase === 'error') return;
      const clamped = Math.min(1, Math.max(0, fraction));
      progressBox.classList.add('visible');
      fill.style.width = `${clamped * 100}%`;
      if (newLabel !== undefined) label.textContent = newLabel;
    },
    error: showError,
    remove() {
      el.classList.add('fading');
      setTimeout(() => el.remove(), FADE_MS);
    },
  };
}
