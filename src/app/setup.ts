// [engine] The setup wizard's access to the app: tones, mic level, calibration, drum teaching, sing-along, commands.
import type { Controller, Recognizer, SetupApi } from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';

export interface SetupDeps {
  engine: AudioEngine;
  mic: Mic;
  controller: Controller;
  recognizer: Recognizer;
}

export function createSetupApi(deps: SetupDeps): SetupApi {
  // STUB (engine replaces)
  const { controller } = deps;
  return {
    guessOutput: () => 'speaker',
    applyOutput: async (output) => controller.setDevice({ output }),
    playTone: () => {},
    level: () => 0,
    noiseFloor: async () => 0,
    calibrate: async () => ({ ok: false, text: 'not available' }),
    teachDrum: async () => [],
    testDrums: () => () => {},
    singAlong: async () => ({ ok: false, offset: 0, spread: 0 }),
    captureRange: async () => null,
    tryCommand: () => ({ stop: async () => ({ text: '', command: null }) }),
    voiceStatus: () => ({ status: deps.recognizer.status, progress: 0 }),
    save: (patch) => controller.setDevice(patch),
    device: () => controller.device,
  };
}
