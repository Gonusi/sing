// [instruments] Short confirmation sounds: 'ok' (command understood), 'err' (not understood / not allowed),
// 'click' (calibration / count). Plain Web Audio, no Tone, so it works before instruments preload.
// Every node is created per call and disconnects itself when it ends.
import type { Sec } from '../types.ts';
import type { Ctx } from './shared.ts';

export type BlipKind = 'ok' | 'err' | 'click';

interface TwoNotes {
  /** the two notes, Hz */
  hz: [number, number];
  /** length of each note */
  note: Sec;
  type: OscillatorType;
  peak: number;
}

/** E5 → B5, quick and soft */
const OK: TwoNotes = { hz: [659.26, 987.77], note: 0.06, type: 'sine', peak: 0.16 };
/** E4 → A3, low and falling, a little longer */
const ERR: TwoNotes = { hz: [329.63, 220], note: 0.09, type: 'triangle', peak: 0.2 };
/** attack and decay time constants of each blip note */
const NOTE_ATTACK_TAU: Sec = 0.003;
const NOTE_DECAY_TAU: Sec = 0.025;
/** click: a 5 ms noise burst with a sharp onset (clap calibration measures its arrival) */
const CLICK_LEN: Sec = 0.005;
const CLICK_PEAK = 0.6;
/** with no `when`, start this long after now so the first samples are not cut */
const NOW_MARGIN: Sec = 0.005;

export function playBlip(ctx: Ctx, kind: BlipKind, when?: Sec, destination: AudioNode = ctx.destination): void {
  const t = Math.max(when ?? ctx.currentTime + NOW_MARGIN, ctx.currentTime);
  if (kind === 'click') playClick(ctx, t, destination);
  else playTwoNotes(ctx, kind === 'ok' ? OK : ERR, t, destination);
}

function playTwoNotes(ctx: Ctx, spec: TwoNotes, t: Sec, destination: AudioNode): void {
  spec.hz.forEach((hz, i) => {
    const start = t + i * spec.note;
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.value = hz;
    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, start);
    env.gain.setTargetAtTime(spec.peak, start, NOTE_ATTACK_TAU);
    env.gain.setTargetAtTime(0, start + spec.note * 0.5, NOTE_DECAY_TAU);
    osc.connect(env).connect(destination);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
    osc.start(start);
    osc.stop(start + spec.note + 6 * NOTE_DECAY_TAU);
  });
}

function playClick(ctx: Ctx, t: Sec, destination: AudioNode): void {
  const n = Math.max(1, Math.round(CLICK_LEN * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const x = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) x[i] = (Math.random() * 2 - 1) * CLICK_PEAK * (1 - i / n);
  x[0] = CLICK_PEAK; // a defined first sample: the onset is exactly at t
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(destination);
  src.onended = () => src.disconnect();
  src.start(t);
}
