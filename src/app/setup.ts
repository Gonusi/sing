// [engine] The setup wizard's access to the app: tones, mic level, calibration, drum teaching, sing-along, commands.
// Nothing here changes the song; learned settings go to DeviceSettings via controller.setDevice.
//
// guessOutput heuristic: ctx.outputLatency > BLUETOOTH_LATENCY_SEC (Bluetooth links add 100–300 ms) → 'bluetooth';
// otherwise 'speaker' — the browser can't tell wired headphones from the speaker (no audiooutput devices on iOS), and
// 'speaker' is the safe default (echo cancellation on). The user corrects it in the step.
// tryCommand: the recogniser's onCommand also reaches main.ts's hold-to-talk handler, which RUNS commands; while a try
// is active `tryingCommand()` is true and that handler must ignore commands (main.ts checks it first).
import type {
  Command, Controller, DeviceSettings, DrumKind, DrumTemplate, MicBlock, OutputKind, PitchFrame, Recognizer, Sec, SetupApi,
} from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';
import { calibrate as runCalibration } from '../audio/latency.ts';
import { blockRms } from '../audio/probe.ts';
import { createOnsetDetector } from '../analysis/drums.ts';
import { createPitchTracker } from '../analysis/pitch.ts';
import { heldNote, pitchOffset } from '../analysis/voice-profile.ts';
import { hzToMidi, midiToHz } from '../analysis/autotune.ts';

export interface SetupDeps {
  engine: AudioEngine;
  mic: Mic;
  controller: Controller;
  recognizer: Recognizer;
  /** the recogniser's load progress 0..1 (main.ts tracks it) */
  voiceProgress?: () => number;
}

export interface EngineSetupApi extends SetupApi {
  /** true while tryCommand() listens: main.ts's onCommand handler must not run commands then */
  tryingCommand(): boolean;
}

/** outputLatency above this means a Bluetooth route */
export const BLUETOOTH_LATENCY_SEC = 0.1;
/** a built-in microphone's label (iOS: "iPhone Microphone"; desktop: "Built-in Microphone", "Internal Microphone") */
const BUILT_IN_MIC_RE = /iphone|ipad|built-?in|internal/i;
const TONE_LEVEL = 0.25;
const TONE_FADE_SEC = 0.01;
/** sing-along: the reference plays this long, quieter, then the user hums alone */
const REFERENCE_SEC = 1;
const REFERENCE_LEVEL = 0.12;
const LEVEL_SMOOTHING = 0.3;

export function createSetupApi(deps: SetupDeps): EngineSetupApi {
  const { engine, mic, controller, recognizer } = deps;
  const { ctx } = engine;

  /** run `onBlock` for every mic block until `until` (context time) or stop(); resolves when done */
  const listen = (onBlock: (b: MicBlock) => void, until = Infinity): { done: Promise<void>; stop: () => void } => {
    let stop = () => {};
    const done = new Promise<void>((resolve) => {
      const off = mic.subscribe((b) => {
        onBlock(b);
        if ((b.frame + b.samples.length) / mic.sampleRate >= until) stop();
      });
      const timer = until < Infinity ? setTimeout(() => stop(), (until - ctx.currentTime + 2) * 1000) : null;
      stop = () => {
        off();
        if (timer) clearTimeout(timer);
        resolve();
      };
    });
    return { done, stop: () => stop() };
  };

  const tone = (midi: number, sec: Sec, level: number) => {
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(midiToHz(midi), t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + TONE_FADE_SEC);
    g.gain.setValueAtTime(level, t + Math.max(TONE_FADE_SEC, sec - TONE_FADE_SEC));
    g.gain.linearRampToValueAtTime(0, t + sec);
    osc.connect(g).connect(engine.master); // master only: never the echo bus
    osc.start(t);
    osc.stop(t + sec + 0.02);
    osc.onended = () => g.disconnect();
    return t;
  };

  /** pitch frames from the mic for `sec` seconds; onPitch live; frames before `collectFrom` are not kept */
  const trackPitch = async (sec: Sec, onPitch: (midi: number | null) => void, collectFrom = 0): Promise<PitchFrame[]> => {
    const tracker = createPitchTracker();
    const frames: PitchFrame[] = [];
    const start = ctx.currentTime;
    const l = listen((b) => {
      for (const f of tracker.push(b, mic.sampleRate)) {
        onPitch(f.hz ? hzToMidi(f.hz) : null);
        if (f.t >= start + collectFrom) frames.push(f);
      }
    }, start + sec);
    await l.done;
    return frames;
  };

  let level = 0;
  let levelOn = false;
  let trying = false;

  return {
    guessOutput(): OutputKind {
      return (ctx.outputLatency || 0) > BLUETOOTH_LATENCY_SEC ? 'bluetooth' : 'speaker';
    },
    async applyOutput(kind) {
      const ec = kind === 'speaker';
      // bluetooth: the headset's mic is the narrow-band HFP one (and may force HFP playback) → prefer the built-in mic;
      // wired/speaker: the default input (a wired headset's own mic) — a stale built-in choice must not stick
      const builtIn = kind === 'bluetooth' ? (await mic.listInputs()).find((i) => BUILT_IN_MIC_RE.test(i.label)) : undefined;
      const patch: Partial<DeviceSettings> = { output: kind, ec, micId: builtIn?.id ?? null };
      await controller.setDevice(patch);
      await mic.setEc(ec);
    },
    playTone(midi, sec) {
      tone(midi, sec, TONE_LEVEL);
    },
    level() {
      if (!levelOn) {
        levelOn = true;
        mic.subscribe((b) => (level += (blockRms(b.samples) - level) * LEVEL_SMOOTHING));
      }
      return Math.min(1, level);
    },
    async noiseFloor(sec) {
      const rms: number[] = [];
      await listen((b) => rms.push(blockRms(b.samples)), ctx.currentTime + sec).done;
      if (!rms.length) return 0;
      rms.sort((a, b) => a - b);
      return rms[Math.floor(rms.length / 2)]; // median: a cough doesn't count
    },
    async calibrate(onClick) {
      if (controller.state === 'playing' || controller.state === 'overdubbing') controller.command({ type: 'stop' }, ctx.currentTime);
      const r = await runCalibration(engine, mic, { onClick });
      if (!r.ok) return { ok: false, text: `not clear (heard ${r.heard}/${r.measured}) — clap or say “ta” on each low click` };
      await controller.setDevice({ inLat: r.inLat, calibrated: true });
      return { ok: true, text: `latency ${Math.round(r.inLat * 1000)} ms · heard ${r.heard}/${r.measured}` };
    },
    async teachDrum(kind: DrumKind, count, onHit, timeoutSec) {
      const det = createOnsetDetector({ captureFeatures: true });
      const templates: DrumTemplate[] = [];
      const l = listen((b) => {
        for (const h of det.push(b, mic.sampleRate)) {
          if (templates.length >= count) break;
          templates.push({ kind, features: h.features ?? [] });
          onHit(templates.length);
          if (templates.length >= count) setTimeout(() => l.stop(), 0);
        }
      }, ctx.currentTime + timeoutSec);
      await l.done;
      return templates;
    },
    testDrums(templates, onHit) {
      const det = createOnsetDetector({ templates });
      return listen((b) => {
        for (const h of det.push(b, mic.sampleRate)) onHit(h.kind);
      }).stop;
    },
    async singAlong(midi, sec, onPitch) {
      tone(midi, Math.min(REFERENCE_SEC, sec), REFERENCE_LEVEL);
      // frames while the reference plays are not measured (on a speaker the mic hears the reference itself)
      const frames = await trackPitch(sec, onPitch, Math.min(REFERENCE_SEC, sec * 0.5));
      return pitchOffset(frames, midi);
    },
    async captureRange(_which, sec, onPitch) {
      return heldNote(await trackPitch(sec, onPitch));
    },
    tryCommand() {
      if (recognizer.status !== 'ready') return { stop: async () => ({ text: '', command: null }) };
      trying = true;
      let text = '';
      let early: Command | null = null;
      const offPartial = recognizer.onPartial((t) => (text = t));
      const offCommand = recognizer.onCommand((c) => (early ??= c));
      recognizer.begin(ctx.currentTime);
      return {
        async stop() {
          try {
            const c = await recognizer.end();
            return { text, command: c ?? early };
          } finally {
            offPartial();
            offCommand();
            trying = false;
          }
        },
      };
    },
    tryingCommand: () => trying,
    voiceStatus() {
      const status = recognizer.status;
      return { status, progress: status === 'ready' ? 1 : (deps.voiceProgress?.() ?? 0) };
    },
    save: (patch) => controller.setDevice(patch),
    device: () => controller.device,
  };
}
