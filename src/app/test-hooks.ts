// [tester] window.__sing (SingTestApi). Loaded by main.ts with a dynamic import, only with ?test.
import type { Command, Controller, Recognizer, Sec } from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';

export interface TestHookDeps {
  engine: AudioEngine;
  mic: Mic;
  controller: Controller;
  recognizer: Recognizer;
  /** run a command exactly like a recognised voice command (blip + toast + controller.command) */
  run(c: Command, tDown: Sec): void;
}

export function installTestHooks(_deps: TestHookDeps): void {
  // STUB (tester replaces)
}
