// [shell] Shared bits of the setup wizard steps: the SetupStep contract, DOM helpers, the card skeleton and a tiny
// lifetime helper so every step can stop its audio/timers/rAF in one cleanup.
import type { SetupApi, SetupStepId } from '../../types.ts';

/**
 * One wizard step. `mount` fills `card` (the wizard has already put the title in it), calls `done(ok)` when the step
 * has a result (this enables "next"; ok=false = tried but problems), and returns a cleanup that stops everything.
 * A step must work alone (the wizard may launch just one later) and must ignore async results after cleanup.
 */
export interface SetupStep {
  id: SetupStepId;
  title: string;
  mount(card: HTMLElement, api: SetupApi, done: (ok: boolean) => void): () => void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** big touch target (>= 48 px); `kind` 'go' = the step's main action */
export function button(text: string, kind: '' | 'go' = ''): HTMLButtonElement {
  const b = el('button', `wiz-btn${kind ? ` ${kind}` : ''}`, text);
  b.type = 'button';
  return b;
}

// ---------- card skeleton: instruction, live visual (body), result line ----------
export interface CardParts {
  instruction: HTMLElement;
  body: HTMLElement;
  result: HTMLElement;
}

export function buildCard(card: HTMLElement, instruction: string): CardParts {
  const parts: CardParts = { instruction: el('p', 'wiz-instruction', instruction), body: el('div', 'wiz-body'), result: el('div', 'wiz-result') };
  card.append(parts.instruction, parts.body, parts.result);
  return parts;
}

/** 'ok' = --fg, 'bad' = --rec (a problem), 'dim' = progress text */
export function setResult(parts: CardParts, text: string, kind: 'ok' | 'bad' | 'dim' = 'ok'): void {
  parts.result.textContent = text;
  parts.result.className = `wiz-result ${kind}`;
}

// ---------- lifetime ----------
export interface Life {
  /** false after end(): async continuations must return without touching the DOM or calling done */
  alive(): boolean;
  /** register something to stop on end() (timers, rAF, api stop functions) */
  onEnd(fn: () => void): void;
  end(): void;
}

export function createLife(): Life {
  let alive = true;
  const fns: Array<() => void> = [];
  return {
    alive: () => alive,
    onEnd: (fn) => fns.push(fn),
    end: () => {
      if (!alive) return;
      alive = false;
      fns.splice(0).forEach((fn) => fn());
    },
  };
}

/** run `fn` every animation frame until the life ends */
export function frames(life: Life, fn: () => void): void {
  let raf = 0;
  const tick = (): void => {
    fn();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  life.onEnd(() => cancelAnimationFrame(raf));
}

export function wait(life: Life, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    life.onEnd(() => clearTimeout(id));
  });
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** 57 -> "A3" */
export function midiName(midi: number): string {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

/** read a colour token from :root (style.css is the single source) */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
