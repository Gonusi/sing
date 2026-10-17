// [engine] The state machine (idle → recordingFirst → playing ⇄ overdubbing, stopped) and the timing model.
// See PLAN.md "State machine" and "Timing model". Owns voices (one per track), the scheduler and take recording.
import type { Controller, DeviceSettings, Session, View } from '../types.ts';
import type { AudioEngine } from '../audio/context.ts';
import type { Mic } from '../audio/mic.ts';

export interface ControllerDeps {
  engine: AudioEngine;
  mic: Mic;
  device: DeviceSettings;
  /** ?test mode: no persistence side effects beyond normal, logs kept in memory */
  test: boolean;
}

export async function createController(deps: ControllerDeps): Promise<Controller> {
  // STUB (engine replaces): an idle controller with an empty session.
  const session: Session = { v: 1, loopLength: null, tracks: [], selectedId: null };
  const device = { ...deps.device };
  const view = (): View => ({
    state: 'idle', session, recordingTrackId: null, liveNotes: [], liveHits: [],
    openNote: null, loopPos: null, elapsed: null,
  });
  return {
    get state() { return 'idle' as const; },
    session,
    device,
    view,
    gesture: () => {},
    command: () => {},
    select: () => {},
    toggleTrack: () => {},
    setDevice: async (p) => void Object.assign(device, p),
    clearSession: async () => {},
    lastTakeWav: () => null,
    voiceOutput: () => null,
    onChange: () => () => {},
    onLog: () => () => {},
  };
}
