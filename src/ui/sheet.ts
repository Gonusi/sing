// [shell] Corner buttons ＋ (instrument picker) and ⋯ (settings) and their bottom sheets.
import type { InstrumentKind } from '../types.ts';

export interface SheetActions {
  create(kind: InstrumentKind): void;
  getEc(): boolean;
  setEc(ec: boolean): Promise<void>;
  /** runs the clap-along; onClick fires per click so the sheet can pulse; resolves with a short result text */
  calibrate(onClick: (i: number, n: number) => void): Promise<string>;
  /** start the audio probe (tone while the mic is open); returns live level + stop */
  probe(): { level(): number; stop(): void };
  /** raw mic WAV of the last take, or null */
  exportTake(): Blob | null;
  clearSession(): Promise<void>;
  /** one line each: version, latency, voice status */
  info(): string[];
  credits: string;
}

export function mountSheets(_root: HTMLElement, _actions: SheetActions): () => void {
  // STUB (shell replaces)
  return () => {};
}
