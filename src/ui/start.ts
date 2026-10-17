// [shell] "tap to start" screen. onTap is called SYNCHRONOUSLY in the pointer handler (iOS audio unlock).
export interface StartScreen {
  progress(fraction: number, label?: string): void;
  error(message: string): void;
  remove(): void;
}

export function mountStart(root: HTMLElement, onTap: () => void): StartScreen {
  // STUB (shell replaces)
  const el = document.createElement('button');
  el.textContent = 'tap to start';
  el.addEventListener('pointerup', () => onTap(), { once: true });
  root.append(el);
  return { progress: () => {}, error: (m) => void (el.textContent = m), remove: () => el.remove() };
}
