// [shell] Top bar (title, ＋ instrument picker, ⋯ settings) and the two bottom sheets they open.
// Everything here is data-no-gesture: taps never reach the record/stop gesture layer.
// The top bar also holds the echo slider (0..1, live). Settings rows: echo cancellation, microphone picker, note smoothing slider, calibrate latency, setup wizard, audio probe, export last take, clear session, info, credits.
import { INSTRUMENTS } from '../types.ts';
import type { InstrumentKind } from '../types.ts';

export interface SheetActions {
  create(kind: InstrumentKind): void;
  /** global echo amount 0..1 (Controller.setEcho / Session.fx.echo) */
  getEcho(): number;
  setEcho(amount: number): void;
  /** note smoothing 0..1 (Controller.setSmoothing / Session.fx.smooth; 0 = every wobble, 1 = steady notes) */
  getSmoothing(): number;
  setSmoothing(amount: number): void;
  getEc(): boolean;
  setEc(ec: boolean): Promise<void>;
  /** runs the clap-along; onClick fires per click (listen = first clicks to tune in, measure = clap or say "ta") so the sheet can pulse; resolves with a short result text */
  calibrate(onClick: (i: number, n: number, phase: 'listen' | 'measure') => void): Promise<string>;
  /** audio inputs (id + label; label may be empty) */
  listMics(): Promise<{ id: string; label: string }[]>;
  /** the input asked for (null = default) */
  getMic(): string | null;
  /** switch input (null = default); resolves false when it failed and the default is used instead */
  setMic(id: string | null): Promise<boolean>;
  /** start the audio probe (tone while the mic is open); returns live level + stop */
  probe(): { level(): number; stop(): void };
  /** open the setup wizard (listening, mic, latency, drums, voice); the ⋯ sheet closes first */
  openSetup(): void;
  /** raw mic WAV of the last take, or null */
  exportTake(): Blob | null;
  clearSession(): Promise<void>;
  /** one line each: version, latency, voice status */
  info(): string[];
  credits: string;
}

const ECHO_PERCENT = 100;
const GRID_KINDS = INSTRUMENTS.filter((k) => k !== 'vocals');
const KIND_SUBLABEL: Partial<Record<InstrumentKind, string>> = { vocals: 'your voice' };

const LETTERS: Record<InstrumentKind, string> = { drums: 'D', violin: 'V', synth: 'S', bass: 'B', vocals: 'M' };
const EXPORT_EMPTY_MS = 1500;
const CLEAR_ARM_MS = 3000;
const PULSE_MS = 300;
const MIC_FAIL_MS = 2000;
const MIC_SUB = 'iPhone mic keeps Bluetooth headphones in high quality — try it';
const MIC_FAIL_SUB = 'couldn’t switch — using default';
const DOWNLOAD_REVOKE_MS = 10_000;

// ---------- small DOM helpers ----------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function noGesture<T extends HTMLElement>(node: T): T {
  node.dataset.noGesture = '';
  return node;
}

function timestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(blob: Blob, parent: HTMLElement): void {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `sing-take-${timestamp(new Date())}.wav`;
  parent.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_MS);
}

// ---------- sheet shell ----------
interface SheetShell {
  layer: HTMLElement;
  body: HTMLElement;
  open(): void;
  close(): void;
}

interface SheetHooks {
  onOpen?: () => void;
  onClose?: () => void;
}

function createSheet(root: HTMLElement, caption: string, hooks: SheetHooks = {}): SheetShell {
  const layer = noGesture(el('div', 'sheet-layer'));
  const backdrop = el('div', 'sheet-backdrop');
  const sheet = el('div', 'sheet');
  const head = el('div', 'sheet-head');
  const done = el('button', 'sheet-done', 'done');
  const body = el('div');
  head.append(el('div', 'sheet-caption', caption), done);
  sheet.append(head, body);
  layer.append(backdrop, sheet);
  root.append(layer);

  let isOpen = false;
  function open(): void {
    if (isOpen) return;
    isOpen = true;
    hooks.onOpen?.();
    layer.classList.add('open');
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    layer.classList.remove('open');
    hooks.onClose?.();
  }
  backdrop.addEventListener('click', close);
  done.addEventListener('click', close);
  return { layer, body, open, close };
}

// ---------- ＋ sheet ----------
function fillNewTrackSheet(body: HTMLElement, actions: SheetActions, close: () => void): void {
  const grid = el('div', 'kind-grid');
  const makeButton = (kind: InstrumentKind, className = ''): HTMLButtonElement => {
    const button = el('button', `kind-btn kind-${kind} ${className}`.trim());
    button.dataset.kind = kind;
    const sub = KIND_SUBLABEL[kind];
    const text = sub ? el('span', 'kind-text') : el('span', '', kind);
    if (sub) text.append(el('span', '', kind), el('span', 'kind-sub', sub));
    button.append(el('span', 'kind-circle', LETTERS[kind]), text);
    button.addEventListener('click', () => {
      actions.create(kind);
      close();
    });
    return button;
  };
  grid.append(...GRID_KINDS.map((kind) => makeButton(kind)));
  body.append(grid, makeButton('vocals', 'kind-btn-wide'));
}

// ---------- ⋯ sheet rows ----------
interface SettingsRow {
  root: HTMLElement;
  /** back to the idle look; called whenever the sheet opens */
  reset(): void;
  /** called when the sheet closes */
  stop?(): void;
}

interface RowParts {
  root: HTMLButtonElement;
  title: HTMLElement;
  sub: HTMLElement | null;
  end: HTMLElement;
}

function makeRow(titleText: string, subText?: string): RowParts {
  const root = el('button', 'row');
  const main = el('div', 'row-main');
  const title = el('div', 'row-title', titleText);
  main.append(title);
  const sub = subText ? el('div', 'row-sub', subText) : null;
  if (sub) main.append(sub);
  const end = el('div', 'row-end');
  root.append(main, end);
  return { root, title, sub, end };
}

function createEcRow(actions: SheetActions): SettingsRow {
  const { root, end } = makeRow('Echo cancellation', 'on: phone speaker · off: headphones (cleanest vocals)');
  root.setAttribute('role', 'switch');
  end.append(el('span', 'switch'));
  let busy = false;
  const render = (on: boolean): void => root.setAttribute('aria-checked', String(on));
  root.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render(root.getAttribute('aria-checked') !== 'true');
    try {
      await actions.setEc(root.getAttribute('aria-checked') === 'true');
    } catch (e) {
      console.error(e);
      render(actions.getEc());
    } finally {
      busy = false;
    }
  });
  return { root, reset: () => render(actions.getEc()) };
}

function createSmoothingRow(actions: SheetActions): SettingsRow {
  const root = noGesture(el('div', 'row row-slider'));
  const main = el('div', 'row-main');
  main.append(el('div', 'row-title', 'Note smoothing'), el('div', 'row-sub', 'left: every wobble · right: steady notes'));
  const slider = noGesture(el('input', 'echo-slider smooth-slider'));
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.05';
  slider.setAttribute('aria-label', 'note smoothing');
  const paint = (): void => slider.style.setProperty('--fill', `${Number(slider.value) * ECHO_PERCENT}%`);
  slider.addEventListener('input', () => {
    paint();
    actions.setSmoothing(Number(slider.value));
  });
  root.append(main, slider);
  return {
    root,
    reset: () => {
      slider.value = String(actions.getSmoothing());
      paint();
    },
  };
}

function createCalibrateRow(actions: SheetActions): SettingsRow {
  const LABEL = 'Calibrate latency';
  const IDLE_SUB = 'clap or say “ta” along with 16 clicks';
  const RUN_SUB = 'wear your headphones; any mic works';
  const { root, title, sub, end } = makeRow(LABEL, IDLE_SUB);
  const subLine = sub!;
  root.dataset.row = 'calibrate';
  const dot = el('span', 'pulse-dot');
  end.append(dot);
  let busy = false;
  function pulse(i: number, n: number, phase: 'listen' | 'measure'): void {
    title.textContent = phase === 'listen' ? `listen… ${i}/${n}` : `clap or say “ta” · ${i}/${n}`;
    dot.classList.toggle('listen', phase === 'listen');
    dot.animate([{ opacity: 1, transform: 'scale(1.6)' }, { opacity: 0, transform: 'scale(1)' }], { duration: PULSE_MS });
  }
  root.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    title.textContent = 'listen…';
    subLine.textContent = RUN_SUB;
    dot.classList.add('listen');
    try {
      title.textContent = await actions.calibrate(pulse);
    } catch (e) {
      console.error(e);
      title.textContent = 'calibration failed';
    } finally {
      busy = false;
      subLine.textContent = IDLE_SUB;
    }
  });
  return {
    root,
    reset: () => {
      if (!busy) title.textContent = LABEL;
    },
  };
}

function createMicRow(actions: SheetActions): SettingsRow {
  const root = noGesture(el('div', 'row row-mic'));
  const main = el('div', 'row-main');
  const sub = el('div', 'row-sub', MIC_SUB);
  main.append(el('div', 'row-title', 'Microphone'), sub);
  const select = noGesture(el('select', 'mic-select'));
  select.setAttribute('aria-label', 'microphone');
  root.append(main, select);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0; // a late listMics() from an earlier open must not overwrite a newer list
  function resetSub(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    sub.textContent = MIC_SUB;
  }
  async function refresh(): Promise<void> {
    const mine = ++seq;
    let mics: { id: string; label: string }[] = [];
    try {
      mics = await actions.listMics();
    } catch (e) {
      console.error(e);
    }
    if (mine !== seq) return;
    const options = [new Option('default', ''), ...mics.map((m, i) => new Option(m.label || `microphone ${i + 1}`, m.id))];
    select.replaceChildren(...options);
    select.value = actions.getMic() ?? '';
    if (select.value !== (actions.getMic() ?? '')) select.value = '';
  }
  select.addEventListener('change', async () => {
    resetSub();
    let ok = false;
    try {
      ok = await actions.setMic(select.value || null);
    } catch (e) {
      console.error(e);
    }
    if (ok) return;
    select.value = '';
    sub.textContent = MIC_FAIL_SUB;
    timer = setTimeout(resetSub, MIC_FAIL_MS);
  });
  return {
    root,
    reset: () => {
      resetSub();
      refresh().catch((e: unknown) => console.error(e));
    },
    stop: resetSub,
  };
}

function createProbeRow(actions: SheetActions): SettingsRow {
  const LABEL = 'Audio probe';
  const { root, title, end } = makeRow(LABEL);
  const level = el('span', 'level');
  const fill = el('span', 'level-fill');
  level.append(fill);
  level.hidden = true;
  end.append(level);

  let probe: ReturnType<SheetActions['probe']> | null = null;
  let raf = 0;
  function drawLevel(): void {
    if (!probe) return;
    // mic RMS is small for speech; the square root makes the bar readable
    fill.style.width = `${Math.min(1, Math.sqrt(Math.max(0, probe.level()))) * 100}%`;
    raf = requestAnimationFrame(drawLevel);
  }
  function start(): void {
    try {
      probe = actions.probe();
    } catch (e) {
      console.error(e);
      title.textContent = 'probe failed';
      return;
    }
    title.textContent = 'tone playing · mic';
    level.hidden = false;
    drawLevel();
  }
  function stop(): void {
    cancelAnimationFrame(raf);
    probe?.stop();
    probe = null;
    title.textContent = LABEL;
    level.hidden = true;
    fill.style.width = '0';
  }
  root.addEventListener('click', () => (probe ? stop() : start()));
  return { root, reset: stop, stop };
}

function createSetupRow(actions: SheetActions, close: () => void): SettingsRow {
  const { root } = makeRow('Setup', 'listening, mic, latency, drums, voice');
  root.dataset.row = 'setup';
  root.addEventListener('click', () => {
    close();
    actions.openSetup();
  });
  return { root, reset: () => {} };
}

function createExportRow(actions: SheetActions, parent: HTMLElement): SettingsRow {
  const LABEL = 'Export last take (WAV)';
  const { root, title } = makeRow(LABEL);
  let timer: ReturnType<typeof setTimeout> | null = null;
  function reset(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    title.textContent = LABEL;
  }
  root.addEventListener('click', () => {
    const blob = actions.exportTake();
    if (blob) {
      downloadBlob(blob, parent);
      return;
    }
    reset();
    title.textContent = 'no take yet';
    timer = setTimeout(reset, EXPORT_EMPTY_MS);
  });
  return { root, reset };
}

function createClearRow(actions: SheetActions, close: () => void): SettingsRow {
  const LABEL = 'Clear session';
  const { root, title } = makeRow(LABEL);
  root.classList.add('danger');
  let timer: ReturnType<typeof setTimeout> | null = null;
  function reset(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    title.textContent = LABEL;
  }
  root.addEventListener('click', () => {
    if (timer === null) {
      title.textContent = 'tap again to clear';
      timer = setTimeout(reset, CLEAR_ARM_MS);
      return;
    }
    reset();
    actions.clearSession().catch((e: unknown) => console.error(e));
    close();
  });
  return { root, reset };
}

function createInfo(actions: SheetActions): { root: HTMLElement; refresh(): void } {
  const root = el('div', 'info');
  return {
    root,
    refresh: () => root.replaceChildren(...actions.info().map((line) => el('div', '', line))),
  };
}

function fillSettingsSheet(body: HTMLElement, rows: SettingsRow[], info: HTMLElement, credits: string): void {
  body.append(...rows.map((r) => r.root), info, el('div', 'credits', credits));
}

// ---------- top bar ----------
interface TopBar {
  root: HTMLElement;
  /** put the slider at the current echo amount */
  syncEcho(): void;
}

function createEchoControl(actions: SheetActions): { root: HTMLElement; sync(): void } {
  const root = el('label', 'echo');
  const slider = noGesture(el('input', 'echo-slider'));
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.setAttribute('aria-label', 'echo');
  const paint = (): void => slider.style.setProperty('--fill', `${Number(slider.value) * ECHO_PERCENT}%`);
  slider.addEventListener('input', () => {
    paint();
    actions.setEcho(Number(slider.value));
  });
  root.append(el('span', 'echo-label', 'echo'), slider);
  return {
    root,
    sync: () => {
      slider.value = String(actions.getEcho());
      paint();
    },
  };
}

function createTopBar(actions: SheetActions, onPlus: () => void, onSettings: () => void): TopBar {
  const bar = noGesture(el('div', 'topbar'));
  const echo = createEchoControl(actions);
  const buttons = el('div', 'topbar-buttons');
  const plus = el('button', 'icon-btn', '＋');
  plus.dataset.action = 'new-track';
  plus.setAttribute('aria-label', 'New track');
  plus.addEventListener('click', onPlus);
  const more = el('button', 'icon-btn', '⋯');
  more.dataset.action = 'settings';
  more.setAttribute('aria-label', 'Settings');
  more.addEventListener('click', onSettings);
  buttons.append(plus, more);
  const right = el('div', 'topbar-right');
  right.append(echo.root, buttons);
  bar.append(el('div', 'topbar-title', 'Sing'), right);
  return { root: bar, syncEcho: echo.sync };
}

export function mountSheets(root: HTMLElement, actions: SheetActions): () => void {
  let syncEcho = (): void => {}; // set once the top bar exists; sheet hooks only run after mount
  const newTrack = createSheet(root, 'NEW TRACK', { onClose: () => syncEcho() });
  fillNewTrackSheet(newTrack.body, actions, newTrack.close);

  const rows: SettingsRow[] = []; // filled below; the hooks only run after mount
  const info = createInfo(actions);
  const probe = createProbeRow(actions);
  const settings = createSheet(root, 'SETTINGS', {
    onOpen: () => {
      rows.forEach((r) => r.reset());
      info.refresh();
    },
    onClose: () => {
      probe.stop?.();
      syncEcho();
    },
  });
  rows.push(
    createEcRow(actions),
    createMicRow(actions),
    createSmoothingRow(actions),
    createCalibrateRow(actions),
    createSetupRow(actions, settings.close),
    probe,
    createExportRow(actions, root),
    createClearRow(actions, settings.close),
  );
  fillSettingsSheet(settings.body, rows, info.root, actions.credits);

  const bar = createTopBar(actions, newTrack.open, settings.open);
  syncEcho = bar.syncEcho;
  syncEcho();
  root.append(bar.root);

  return () => {
    probe.stop?.();
    bar.root.remove();
    newTrack.layer.remove();
    settings.layer.remove();
  };
}
