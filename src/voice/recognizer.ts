// [voice] vosk-browser recogniser, loaded lazily. Fresh KaldiRecognizer per hold, fed from the mic ring at tDown.
import type { MicFeed, Recognizer } from '../types.ts';

export interface RecognizerDeps {
  ctx: AudioContext;
  mic: MicFeed;
  /** ABSOLUTE url of the .tar.gz model (vosk's blob worker resolves relative urls against the origin root) */
  modelUrl: string;
}

export function createRecognizer(_deps: RecognizerDeps): Recognizer {
  // STUB (voice replaces)
  return {
    status: 'off',
    load: async () => {},
    begin: () => {},
    end: async () => null,
    onCommand: () => () => {},
    onPartial: () => () => {},
  };
}
