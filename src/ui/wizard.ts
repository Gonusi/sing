// [shell] The setup wizard: full-screen cards, one per step (listening, mic, latency, drums, voice, commands).
// Each step is its own small module-level function so later versions can launch any single step.
import type { SetupApi, SetupStepId } from '../types.ts';

export interface WizardOptions {
  /** which steps, in order (default: all) */
  steps?: SetupStepId[];
  /** called when finished or skipped; `completed` = reached the end */
  onDone(completed: boolean): void;
}

export function mountWizard(_root: HTMLElement, _api: SetupApi, opts: WizardOptions): () => void {
  // STUB (shell replaces)
  queueMicrotask(() => opts.onDone(false));
  return () => {};
}
