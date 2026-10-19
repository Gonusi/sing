// [shell] Bottom transport bar (GarageBand-like): position "bar.beat" + state word on the left, ⏮ ▶/⏸ ● in the centre,
// loop length "n bars" on the right. DOM only, one requestAnimationFrame loop that touches an element only when its
// text / class / style changed. Data-no-gesture: presses never reach the hold-to-speak gesture layer.
// Buttons act on pointerdown (a loop pedal should not wait for the release); a keyboard click (detail 0) acts too.
import type { AppState, TransportAction, UiView } from '../types.ts';

export interface TransportOptions {
  view: () => UiView;
  onAction(a: TransportAction): void;
}

/** the record button swells on each beat: scale = 1 + PULSE_SCALE * decay (downbeat: PULSE_DOWNBEAT_GAIN times as much) */
const PULSE_SCALE = 0.07;
const PULSE_DOWNBEAT_GAIN = 1.8;
const PULSE_DECAY_PHASE = 0.6; // the swell is gone after this share of the beat

type ButtonId = 'toStart' | 'playPause' | 'record';

const NS = 'http://www.w3.org/2000/svg';
/** 24x24 icons, filled with currentColor (the record button sets its own colour) */
const ICONS: Record<'toStart' | 'play' | 'pause' | 'dot' | 'stop', string> = {
  toStart: '<rect x="6" y="6" width="2.5" height="12" rx="1"/><path d="M18 6.6v10.8a.8.8 0 0 1-1.25.66L9.6 12.66a.8.8 0 0 1 0-1.32l7.15-4.4A.8.8 0 0 1 18 6.6z"/>',
  play: '<path d="M8.5 6.4v11.2a.8.8 0 0 0 1.22.68l9-5.6a.8.8 0 0 0 0-1.36l-9-5.6a.8.8 0 0 0-1.22.68z"/>',
  pause: '<rect x="7" y="6" width="3.2" height="12" rx="1.1"/><rect x="13.8" y="6" width="3.2" height="12" rx="1.1"/>',
  dot: '<circle cx="12" cy="12" r="5.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------- derived text (pure) ----------
const isRecording = (s: AppState): boolean => s === 'recordingFirst' || s === 'overdubbing';

/** "3.2" (bar.beat): the beat clock while it runs, else the playhead converted with the tempo, else "—" */
function positionText(v: UiView): string {
  if (v.beat) return `${v.beat.bar}.${v.beat.beat}`;
  if (v.playhead === null) return '—';
  const beatSec = 60 / v.tempo.bpm;
  const index = Math.floor(v.playhead / beatSec + 1e-6);
  return `${Math.floor(index / v.tempo.beatsPerBar) + 1}.${(index % v.tempo.beatsPerBar) + 1}`;
}

function stateText(v: UiView): string {
  if (v.countIn !== null) return `count-in ${v.countIn}`;
  switch (v.state) {
    case 'countIn':
      return 'count-in';
    case 'recordingFirst':
    case 'overdubbing':
      return 'recording';
    case 'playing':
      return 'playing';
    case 'stopped':
      return 'paused';
    case 'idle':
      return 'ready';
  }
}

function loopText(v: UiView): string {
  const length = v.session.loopLength;
  if (!length) return '—';
  const bars = Math.max(1, Math.round(length / ((60 / v.tempo.bpm) * v.tempo.beatsPerBar)));
  return `${bars} ${bars === 1 ? 'bar' : 'bars'}`;
}

/** play when idle/stopped, pause otherwise (countIn, recording, playing) */
const showsPlay = (s: AppState): boolean => s === 'idle' || s === 'stopped';

export function mountTransport(root: HTMLElement, opts: TransportOptions): () => void {
  const bar = el('div', 'transport');
  bar.dataset.noGesture = '';

  const left = el('div', 'tp-left');
  const pos = el('div', 'tp-pos', '—');
  const word = el('div', 'tp-state', 'ready');
  left.append(pos, word);

  const centre = el('div', 'tp-centre');
  const buttons = {} as Record<ButtonId, HTMLButtonElement>;
  const make = (id: ButtonId, label: string): HTMLButtonElement => {
    const b = el('button', `tp-btn tp-${id}`);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.dataset.button = id;
    buttons[id] = b;
    centre.append(b);
    return b;
  };
  make('toStart', 'to start');
  make('playPause', 'play');
  make('record', 'record');
  buttons.toStart.append(icon('toStart'));
  buttons.record.append(icon('dot'));
  buttons.playPause.append(icon('play'));

  const right = el('div', 'tp-right', '—');
  bar.append(left, centre, right);
  root.append(bar);

  /** the action a press means right now (read at press time, so a stale render cannot misfire) */
  function actionOf(id: ButtonId): TransportAction {
    if (id === 'toStart') return 'toStart';
    if (id === 'record') return 'record';
    return showsPlay(opts.view().state) ? 'play' : 'pause';
  }
  for (const id of Object.keys(buttons) as ButtonId[]) {
    const b = buttons[id];
    const fire = (): void => {
      if (!b.disabled) opts.onAction(actionOf(id));
    };
    b.addEventListener('pointerdown', (e) => {
      if (e.button === 0) fire();
    });
    b.addEventListener('click', (e) => {
      if (e.detail === 0) fire(); // keyboard / assistive tech; pointer presses already fired on pointerdown
    });
  }

  // last rendered values
  let lastPos = '';
  let lastWord = '';
  let lastRight = '';
  let lastPlayIcon: 'play' | 'pause' | '' = '';
  let lastRecIcon: 'dot' | 'stop' | '' = '';
  let lastRecState = '';
  let lastToStartOff: boolean | null = null;
  let lastPlayOff: boolean | null = null;
  let lastRecTransform = '';

  function setText(target: HTMLElement, next: string, last: string): string {
    if (next !== last) target.textContent = next;
    return next;
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    const v = opts.view();
    lastPos = setText(pos, positionText(v), lastPos);
    lastWord = setText(word, stateText(v), lastWord);
    lastRight = setText(right, loopText(v), lastRight);

    const recording = isRecording(v.state) || v.state === 'countIn';
    const playOrPause = showsPlay(v.state) ? 'play' : 'pause';
    if (playOrPause !== lastPlayIcon) {
      lastPlayIcon = playOrPause;
      buttons.playPause.replaceChildren(icon(playOrPause));
      buttons.playPause.setAttribute('aria-label', playOrPause);
    }
    const recIcon = recording ? 'stop' : 'dot';
    if (recIcon !== lastRecIcon) {
      lastRecIcon = recIcon;
      buttons.record.replaceChildren(icon(recIcon));
      buttons.record.setAttribute('aria-label', recording ? 'stop recording' : 'record');
    }
    const recState = recording ? 'on' : 'off';
    if (recState !== lastRecState) {
      lastRecState = recState;
      buttons.record.classList.toggle('active', recording);
    }

    const toStartOff = recording || (v.state === 'idle' && !v.session.loopLength); // nothing to go to without a loop
    if (toStartOff !== lastToStartOff) {
      lastToStartOff = toStartOff;
      buttons.toStart.disabled = toStartOff;
    }
    const playOff = v.state === 'idle' && !v.session.loopLength;
    if (playOff !== lastPlayOff) {
      lastPlayOff = playOff;
      buttons.playPause.disabled = playOff;
    }

    // the record button swells on each beat while counting in / recording
    let transform = '';
    if (recording && v.beat) {
      const decay = Math.max(0, 1 - v.beat.phase / PULSE_DECAY_PHASE);
      const gain = v.beat.beat === 1 ? PULSE_DOWNBEAT_GAIN : 1;
      transform = `scale(${(1 + PULSE_SCALE * gain * decay).toFixed(3)})`;
    }
    if (transform !== lastRecTransform) {
      lastRecTransform = transform;
      buttons.record.style.transform = transform;
    }
  }
  let raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    bar.remove();
  };
}
