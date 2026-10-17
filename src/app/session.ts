// [engine] Session store: snapshots for undo, IndexedDB persistence (idb-keyval), device settings.
import type { DeviceSettings } from '../types.ts';

export const DEFAULT_DEVICE: DeviceSettings = { inLat: 0.01, ec: false, calibrated: false };

export async function loadDevice(): Promise<DeviceSettings> {
  // STUB (engine replaces)
  return { ...DEFAULT_DEVICE };
}
