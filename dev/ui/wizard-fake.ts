// [shell] Dev page: mounts the real setup wizard on a FAKE SetupApi. Query params:
//   steps=listening,mic,...  which steps (default all)      ms=<n>   fake click/hit period in ms (default 120)
//   t=<x>  scale for the fake waits (default 1)             voice=loading|ready|error|off  (default loading->ready after ~2.5 s)
//   miss=1 first tryCommand hears nothing                    quiet=1  the fake mic is too quiet
// Test hooks: window.__wiz (counters and logs), window.__gestures (gestures that leaked to the stage under the wizard).
import '../../src/ui/style.css';
import type { DeviceSettings, DrumKind, DrumTemplate, Gesture, SetupApi, SetupStepId, VoiceStatus } from '../../src/types.ts';
import { mountInput } from '../../src/ui/input.ts';
import { ALL_STEPS } from '../../src/ui/setup/index.ts';
import { mountWizard } from '../../src/ui/wizard.ts';

interface WizHooks {
  /** onDone(completed) calls, in order */
  done: boolean[];
  mounts: Record<string, number>;
  cleanups: Record<string, number>;
  /** api.level() calls (a step that leaves must stop polling it) */
  levelCalls: number;
  testDrumsStops: number;
  tryCommandStops: number;
  tones: number;
  outputs: string[];
  saves: Array<Partial<DeviceSettings>>;
  ready: boolean;
}
declare global {
  interface Window {
    __wiz: WizHooks;
    __gestures: Gesture[];
  }
}

const params = new URLSearchParams(location.search);
const T = Number(params.get('t') ?? 1);
const PERIOD = Number(params.get('ms') ?? 120);
const voiceMode = params.get('voice') ?? 'auto';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const hooks: WizHooks = { done: [], mounts: {}, cleanups: {}, levelCalls: 0, testDrumsStops: 0, tryCommandStops: 0, tones: 0, outputs: [], saves: [], ready: false };
window.__wiz = hooks;
window.__gestures = [];

let quietPhase = false;
let device: DeviceSettings = { inLat: 0.12, ec: false, calibrated: false };
let missesLeft = params.has('miss') ? 1 : 0;
let loadStart = 0; // the fake download starts the first time someone asks about the voice
const LOAD_MS = 2500;

const fakeTemplate = (kind: DrumKind, i: number): DrumTemplate => ({ kind, features: [i, i + 1, i + 2] });

const api: SetupApi = {
  guessOutput: () => 'bluetooth',
  applyOutput: async (kind) => {
    await sleep(150);
    hooks.outputs.push(kind);
  },
  playTone: () => {
    hooks.tones++;
  },
  level: () => {
    hooks.levelCalls++;
    if (quietPhase) return 0.004;
    const amp = params.has('quiet') ? 0.015 : 0.14;
    return amp * (0.45 + 0.55 * Math.abs(Math.sin(performance.now() / 260)));
  },
  noiseFloor: async (sec) => {
    quietPhase = true;
    await sleep(sec * 1000 * T);
    quietPhase = false;
    return 0.004;
  },
  calibrate: (onClick) =>
    new Promise((resolve) => {
      let i = 0;
      const id = setInterval(() => {
        i++;
        if (i <= 4) onClick(i, 4, 'listen');
        else onClick(i - 4, 12, 'measure');
        if (i === 16) {
          clearInterval(id);
          resolve({ ok: true, text: 'latency 312 ms · heard 9/12' });
        }
      }, PERIOD);
    }),
  teachDrum: async (kind, count, onHit) => {
    for (let i = 0; i < count; i++) {
      await sleep(PERIOD * 2);
      onHit(i);
    }
    return Array.from({ length: count }, (_, i) => fakeTemplate(kind, i));
  },
  testDrums: (_templates, onHit) => {
    const kinds: DrumKind[] = ['kick', 'hat', 'snare', 'hat'];
    let i = 0;
    const id = setInterval(() => onHit(kinds[i++ % kinds.length]!), PERIOD * 3);
    return () => {
      clearInterval(id);
      hooks.testDrumsStops++;
    };
  },
  singAlong: (midi, _sec, onPitch) =>
    new Promise((resolve) => {
      const n = 40;
      let i = 0;
      const id = setInterval(() => {
        i++;
        const settle = Math.max(0, 1 - i / 14);
        onPitch(i < 4 ? null : midi - 0.33 + settle * 1.4 * Math.sin(i / 2) + 0.08 * Math.sin(i * 1.7));
        if (i === n) {
          clearInterval(id);
          resolve({ ok: true, offset: -0.33, spread: 0.12 });
        }
      }, 50 * T);
    }),
  captureRange: async (which, _sec, onPitch) => {
    const note = which === 'low' ? 45 : 64;
    for (let i = 0; i < 8; i++) {
      onPitch(note + (i % 3 === 0 ? 0.2 : -0.1));
      await sleep(60 * T);
    }
    return note;
  },
  tryCommand: () => ({
    stop: async () => {
      hooks.tryCommandStops++;
      await sleep(150);
      if (missesLeft > 0) {
        missesLeft--;
        return { text: '', command: null };
      }
      return { text: 'create violin track', command: { type: 'create', kind: 'violin' } };
    },
  }),
  voiceStatus: () => {
    if (loadStart === 0) loadStart = performance.now();
    const f = Math.min(1, (performance.now() - loadStart) / LOAD_MS);
    const fixed: Record<string, VoiceStatus> = { ready: 'ready', error: 'error', off: 'off' };
    const status = fixed[voiceMode] ?? (f >= 1 ? 'ready' : 'loading');
    return { status, progress: f };
  },
  save: async (patch) => {
    device = { ...device, ...patch };
    hooks.saves.push(patch);
  },
  device: () => device,
};

// count mounts and cleanups per step (the wizard runs ALL_STEPS objects, so wrapping them in place is enough)
for (const step of ALL_STEPS) {
  const mount = step.mount;
  hooks.mounts[step.id] = 0;
  hooks.cleanups[step.id] = 0;
  step.mount = (card, a, done) => {
    hooks.mounts[step.id]!++;
    const cleanup = mount(card, a, done);
    return () => {
      hooks.cleanups[step.id]!++;
      cleanup();
    };
  };
}

// a stage with the real gesture layer under the wizard: nothing done in the wizard may reach it
const root = document.getElementById('app')!;
const stage = document.createElement('div');
stage.className = 'stage';
root.append(stage);
mountInput(stage, { now: () => performance.now() / 1000, onGesture: (g) => window.__gestures.push(g) });

const steps = params.get('steps')?.split(',') as SetupStepId[] | undefined;
let unmount = (): void => {};
unmount = mountWizard(root, api, {
  ...(steps ? { steps } : {}),
  onDone: (completed) => {
    hooks.done.push(completed);
    unmount();
  },
});
hooks.ready = true;
