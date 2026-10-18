// [shell] The setup wizard: a full-screen layer with step dots, "skip setup", one centred card per step and a
// back / next row. The steps live in src/ui/setup/ (one module each, see setup/kit.ts SetupStep); this file only
// runs them in order: mount on enter, cleanup on leave, "next" enabled once the step reports a result.
import type { SetupApi, SetupStepId } from '../types.ts';
import { ALL_STEPS } from './setup/index.ts';
import { el, type SetupStep } from './setup/kit.ts';

export interface WizardOptions {
  /** which steps, in order (default: all) */
  steps?: SetupStepId[];
  /** called when finished or skipped; `completed` = reached the end */
  onDone(completed: boolean): void;
}

function textButton(className: string, label: string): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  return b;
}

export function mountWizard(root: HTMLElement, api: SetupApi, opts: WizardOptions): () => void {
  const steps: SetupStep[] = opts.steps ? opts.steps.map((id) => ALL_STEPS.find((s) => s.id === id)).filter((s): s is SetupStep => !!s) : ALL_STEPS;
  if (steps.length === 0) {
    queueMicrotask(() => opts.onDone(false));
    return () => {};
  }

  // ----- skeleton -----
  const layer = el('div', 'wizard');
  layer.dataset.noGesture = '';
  const dots = el('div', 'wiz-dots');
  const dotEls = steps.map(() => el('span', 'wiz-dot'));
  dots.append(...dotEls);
  const skipSetup = textButton('wiz-text-btn', 'skip setup');
  skipSetup.dataset.wiz = 'skip-setup';
  const top = el('div', 'wiz-top');
  top.append(dots, skipSetup);

  const card = el('div', 'wiz-card');
  const main = el('div', 'wiz-main');
  main.append(card);

  const back = textButton('wiz-text-btn', 'back');
  back.dataset.wiz = 'back';
  const skipStep = textButton('wiz-text-btn wiz-small', 'skip this step');
  skipStep.dataset.wiz = 'skip-step';
  const next = textButton('wiz-next', 'next');
  next.dataset.wiz = 'next';
  const bottom = el('div', 'wiz-bottom');
  bottom.append(back, skipStep, next);

  layer.append(top, main, bottom);
  root.append(layer);

  // ----- running the steps -----
  const results = new Map<SetupStepId, boolean>();
  let index = 0;
  let cleanup: (() => void) | null = null;
  let gen = 0; // a done() from a step that was already left must not enable the next step's button
  let finished = false;

  function leave(): void {
    gen++;
    const c = cleanup;
    cleanup = null;
    try {
      c?.();
    } catch (e) {
      console.error(e);
    }
  }

  function enter(i: number): void {
    leave();
    index = i;
    const step = steps[i]!;
    const mine = gen;
    dotEls.forEach((d, k) => d.classList.toggle('on', k === i));
    back.style.visibility = i === 0 ? 'hidden' : 'visible'; // keeps the middle link in place
    next.textContent = i === steps.length - 1 ? 'done' : 'next';
    next.disabled = !results.has(step.id);
    layer.dataset.step = step.id;
    card.replaceChildren(el('h1', 'wiz-title', step.title));
    cleanup = step.mount(card, api, (ok) => {
      if (mine !== gen) return;
      results.set(step.id, ok);
      next.disabled = false;
    });
  }

  function finish(completed: boolean): void {
    if (finished) return;
    finished = true;
    leave();
    opts.onDone(completed);
  }

  function advance(): void {
    if (index >= steps.length - 1) finish(true);
    else enter(index + 1);
  }

  next.addEventListener('click', advance);
  skipStep.addEventListener('click', advance);
  back.addEventListener('click', () => index > 0 && enter(index - 1));
  skipSetup.addEventListener('click', () => finish(false));

  enter(0);

  return () => {
    finished = true;
    leave();
    layer.remove();
  };
}
