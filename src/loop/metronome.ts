// [engine] Metronome: a short click on every beat of a beat grid, scheduled ahead on the AudioContext clock
// (like the loop scheduler, in the HEARD domain: a click heard at h is started at h − outLat). Clicks go into the
// master bus directly, never the echo bus. The downbeat (beat index ≡ 0 mod beatsPerBar) is accented.
// The controller decides which grid applies (count-in, first take, the loop) and whether a click is audible;
// onClick(heard) lets it exclude the click from a drum take.
import type { Sec } from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';

/** a beat grid: beat k is heard at anchor + k·beatSec */
export interface BeatGrid {
  anchor: Sec;
  beatSec: Sec;
  beatsPerBar: number;
}

/** scheduling horizon (as the loop scheduler's) */
const CLICK_LOOKAHEAD_SEC = 0.12;
const CLICK_HZ = 1800;
const ACCENT_HZ = 2600;
const CLICK_LEVEL = 0.32;
const ACCENT_LEVEL = 0.45;
const CLICK_DECAY_SEC = 0.025;

export interface Metronome {
  /** switch grids; pending clicks of the old grid are cancelled (same grid = no-op) */
  setGrid(grid: BeatGrid | null): void;
  /** schedule the clicks due within the horizon; audible(heard) filters, onClick(heard, accent) reports each one */
  tick(audible: (heard: Sec) => boolean, onClick?: (heard: Sec, accent: boolean) => void): void;
  /** cancel every click not yet sounded */
  cancel(): void;
  readonly grid: BeatGrid | null;
}

export function createMetronome(engine: AudioEngine): Metronome {
  const { ctx } = engine;
  let grid: BeatGrid | null = null;
  let until = 0; // heard-domain end of what was scheduled
  const pending = new Set<{ osc: OscillatorNode; at: Sec }>();

  const click = (when: Sec, accent: boolean) => {
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(accent ? ACCENT_HZ : CLICK_HZ, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? ACCENT_LEVEL : CLICK_LEVEL, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, when + CLICK_DECAY_SEC);
    osc.connect(g).connect(engine.master);
    osc.start(when);
    osc.stop(when + CLICK_DECAY_SEC + 0.01);
    const entry = { osc, at: when };
    pending.add(entry);
    osc.onended = () => {
      pending.delete(entry);
      g.disconnect();
    };
  };

  const cancel = () => {
    const now = ctx.currentTime;
    for (const p of pending) {
      if (p.at > now) {
        try {
          p.osc.stop(now);
        } catch {
          /* already stopped */
        }
      }
    }
  };

  return {
    get grid() {
      return grid;
    },
    setGrid(g) {
      const same = grid && g && Math.abs(grid.anchor - g.anchor) < 1e-9 && Math.abs(grid.beatSec - g.beatSec) < 1e-9 &&
        grid.beatsPerBar === g.beatsPerBar;
      if (same || (!grid && !g)) return;
      cancel();
      grid = g;
      until = ctx.currentTime + engine.outLat(); // nothing heard before now
    },
    tick(audible, onClick) {
      if (!grid) return;
      const ol = engine.outLat();
      const hi = ctx.currentTime + CLICK_LOOKAHEAD_SEC + ol;
      if (hi <= until) return;
      const { anchor, beatSec, beatsPerBar } = grid;
      for (let k = Math.ceil((until - anchor) / beatSec - 1e-9); ; k++) {
        const heard = anchor + k * beatSec;
        if (heard >= hi) break;
        if (heard < until) continue;
        if (!audible(heard)) continue;
        const accent = ((k % beatsPerBar) + beatsPerBar) % beatsPerBar === 0;
        click(Math.max(ctx.currentTime, heard - ol), accent);
        onClick?.(heard, accent);
      }
      until = hi;
    },
    cancel,
  };
}
