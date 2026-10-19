// Wiring only. Each area's module does the work; this file connects them.
// Boot: tap to start (iOS audio unlock) → audio engine → device settings → mic → instruments → controller → UI.
import './ui/style.css';
import type { Command, Gesture, InstrumentKind, Sec, UiView } from './types.ts';
import { createAudioEngine, type AudioEngine } from './audio/context.ts';
import { createMic } from './audio/mic.ts';
import { calibrate } from './audio/latency.ts';
import { startProbe } from './audio/probe.ts';
import { loadDevice } from './app/session.ts';
import { createController } from './app/controller.ts';
import { preloadInstruments } from './instruments/index.ts';
import { playBlip } from './instruments/blip.ts';
import { createRecognizer } from './voice/recognizer.ts';
import { describeCommand } from './voice/grammar.ts';
import { DEFAULT_SMOOTHING } from './analysis/clean.ts';
import { mountStart } from './ui/start.ts';
import { mountInput } from './ui/input.ts';
import { mountLanes } from './ui/lanes.ts';
import { mountStatus } from './ui/status.ts';
import { mountSheets } from './ui/sheet.ts';
import { mountTransport } from './ui/transport.ts';
import { mountTempo } from './ui/tempo.ts';
import { mountWizard } from './ui/wizard.ts';
import { createSetupApi } from './app/setup.ts';

const params = new URLSearchParams(location.search);
/** ?test: no getUserMedia (mic audio only via window.__sing.mic.play), window.__sing installed */
const TEST = params.has('test');
/** the real recogniser loads unless testing; tests opt in with ?test&voice */
const VOICE = !TEST || params.has('voice');
const MODEL_URL = new URL(`${import.meta.env.BASE_URL}vosk/vosk-model-small-en-us-0.15.tar.gz`, location.href).href;
const CREDITS = 'Violin samples: VSCO 2 Community Edition via nbrosowsky/tonejs-instruments (CC-BY 3.0). Speech: Vosk (Apache-2.0).';

const root = document.getElementById('app')!;

const start = mountStart(root, () => {
  // synchronous inside the tap: creates and resumes the AudioContext (iOS unlock)
  const engineP = createAudioEngine();
  boot(engineP).catch((e: unknown) => {
    console.error(e);
    start.error(e instanceof Error ? e.message : String(e));
  });
});

async function boot(engineP: Promise<AudioEngine>): Promise<void> {
  const engine = await engineP;
  const { ctx } = engine;
  start.progress(0.1, 'audio');
  const device = await loadDevice();
  const mic = await createMic(engine, { test: TEST, ec: device.ec });
  start.progress(0.25, 'microphone');
  await preloadInstruments(ctx, (f) => start.progress(0.25 + 0.65 * f, 'instruments'));
  const controller = await createController({ engine, mic, device, test: TEST });
  const recognizer = createRecognizer({ ctx, mic, modelUrl: MODEL_URL });
  start.progress(1);
  start.remove();

  const ui = { holding: false, partial: '', toast: null as UiView['toast'], voiceProgress: 0 };
  const view = (): UiView => ({ ...controller.view(), ...ui, voice: recognizer.status });
  const toast = (text: string, kind: 'ok' | 'err' = 'ok') => {
    ui.toast = { text, kind, at: performance.now() };
  };

  /** a command from voice, the ＋ sheet or tests: same path for all */
  const run = (c: Command, tDown: Sec) => {
    const accepted = controller.command(c, tDown);
    // a refused command already played the controller's error blip
    if (accepted) playBlip(ctx, 'ok', undefined, engine.master);
    toast(accepted ? describeCommand(c) : `can’t ${describeCommand(c)} now`, accepted ? 'ok' : 'err');
  };

  // the wizard is created after the controls below exist; the ⋯ Setup row calls it through this late binding
  let openSetupLate = () => {};
  const stage = document.createElement('div');
  stage.className = 'stage';
  root.append(stage);

  const lanes = mountLanes(stage, {
    view,
    onSelect: (id) => controller.select(id),
    onToggle: (id) => controller.toggleTrack(id),
    onDelete: (id) => {
      if (controller.deleteTrack(id)) toast('track deleted · say “undo” to bring it back');
    },
    onDuplicate: (id) => {
      if (controller.duplicateTrack(id)) toast('track duplicated');
    },
  });
  mountStatus(stage, { view });
  mountSheets(stage, {
    create: (kind: InstrumentKind) => run({ type: 'create', kind }, ctx.currentTime),
    getEcho: () => controller.session.fx?.echo ?? 0,
    setEcho: (amount) => controller.setEcho(amount),
    getSmoothing: () => controller.session.fx?.smooth ?? DEFAULT_SMOOTHING,
    setSmoothing: (amount) => controller.setSmoothing(amount),
    getEc: () => controller.device.ec,
    setEc: async (ec) => {
      await controller.setDevice({ ec });
      await mic.setEc(ec);
    },
    calibrate: async (onClick) => {
      if (controller.state === 'playing' || controller.state === 'overdubbing') {
        controller.command({ type: 'stop' }, ctx.currentTime);
      }
      const r = await calibrate(engine, mic, { onClick });
      if (!r.ok) return `not clear (heard ${r.heard}/${r.measured}) — clap or say “ta” on each low click`;
      await controller.setDevice({ inLat: r.inLat, calibrated: true });
      return `latency ${Math.round(r.inLat * 1000)} ms · heard ${r.heard}/${r.measured}`;
    },
    listMics: () => mic.listInputs(),
    getMic: () => controller.device.micId ?? null,
    setMic: async (id) => {
      await controller.setDevice({ micId: id });
      return id === null || mic.inputId() === id;
    },
    openSetup: () => openSetupLate(),
    probe: () => startProbe(engine, mic),
    exportTake: () => controller.lastTakeWav(),
    clearSession: () => controller.clearSession(),
    info: () => [
      `input latency ${Math.round(controller.device.inLat * 1000)} ms${controller.device.calibrated ? '' : ' (default)'}`,
      `output latency ${Math.round(engine.outLat() * 1000)} ms`,
      `voice ${recognizer.status}${recognizer.status === 'loading' ? ` ${Math.round(ui.voiceProgress * 100)}%` : ''}`,
    ],
    credits: CREDITS,
  });

  // GarageBand-like transport (bottom) and tempo (top-left slot of the top bar, created by mountSheets)
  mountTransport(stage, {
    view,
    onAction: (a) => {
      if (!controller.transport(a, ctx.currentTime)) playBlip(ctx, 'err', undefined, engine.master);
    },
  });
  const clickOn = () => controller.session.fx?.click ?? true;
  const tempoSlot = stage.querySelector<HTMLElement>('.topbar-left');
  if (tempoSlot) {
    mountTempo(tempoSlot, {
      view,
      clickOn,
      onToggleClick: () => {
        controller.setClick(!clickOn());
        toast(clickOn() ? 'metronome on' : 'metronome off');
      },
      onSetTempo: (bpm) => {
        if (!controller.setTempo(bpm)) toast('tempo is locked once a vocal track exists', 'err');
      },
    });
  }

  // hold-to-talk: one command per hold, read against the state at touch-down
  let holdDown: Sec = 0;
  let fired = false;
  recognizer.onPartial((text) => (ui.partial = text));
  // the wizard's "try a command" must not run the command: main's handler ignores commands while it is active
  const setup = createSetupApi({ engine, mic, controller, recognizer, voiceProgress: () => ui.voiceProgress });
  recognizer.onCommand((c) => {
    if (setup.tryingCommand()) return;
    if (fired) return;
    fired = true;
    run(c, holdDown);
  });

  mountInput(stage, {
    now: () => ctx.currentTime,
    onSwipe: lanes.swipe,
    onGesture: (g: Gesture) => {
      switch (g.type) {
        case 'tap': {
          controller.gesture(g);
          // a tap moves the playhead (it no longer records — ● does)
          const pos = g.x === undefined ? null : lanes.posAt(g.x);
          if (pos !== null) controller.seek(pos);
          else if (controller.session.loopLength === null) toast('press ● to record');
          break;
        }
        case 'holdStart':
          holdDown = g.tDown;
          fired = false;
          ui.holding = true;
          ui.partial = '';
          controller.gesture(g);
          if (recognizer.status === 'ready') recognizer.begin(g.tDown);
          break;
        case 'holdEnd':
          ui.holding = false;
          controller.gesture(g);
          if (recognizer.status !== 'ready') {
            toast(recognizer.status === 'loading' ? 'voice still loading' : 'voice unavailable', 'err');
            playBlip(ctx, 'err', undefined, engine.master);
            break;
          }
          void recognizer.end().then((c) => {
            if (!c && !fired) {
              toast('didn’t catch that', 'err');
              playBlip(ctx, 'err', undefined, engine.master);
            }
            ui.partial = '';
          });
          break;
      }
    },
  });

  // installed app: ask the browser not to evict the cached 41 MB speech model (no prompt in Safari/Chrome)
  if (matchMedia('(display-mode: standalone)').matches) void navigator.storage?.persist?.().catch(() => {});
  if (VOICE) {
    recognizer.load((f) => (ui.voiceProgress = f)).catch((e: unknown) => console.warn('voice failed to load', e));
  }
  // setup wizard: on first launch (until completed or skipped); never in ?test unless ?setup is given
  const openSetup = () => {
    const close = mountWizard(root, setup, {
      onDone: () => {
        close();
        void controller.setDevice({ setupDone: true });
      },
    });
  };
  openSetupLate = openSetup;
  if ((!TEST && !params.has('nosetup') && !controller.device.setupDone) || params.has('setup')) openSetup();

  if (TEST) {
    const { installTestHooks } = await import('./app/test-hooks.ts');
    installTestHooks({ engine, mic, controller, recognizer, run });
  }
}
