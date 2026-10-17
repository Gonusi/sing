// [voice] The command list, the phrase list fed to vosk, and exact parsing of recogniser text.
// On/off of an instrument is `mute <instrument>` / `<instrument> back` ("unmute" is not in the vosk small-en model).
// Not `<instrument> on|off`: those differ only in a weak final consonant and swapped in noise (91.7–95.8 % on noisy
// TTS, e2e-shaped holds worst); mute/back scored 100 % in every hold condition and a habitual "violin off" mostly
// does nothing instead of the opposite (dev/voice/compare-grammars.ts, notes/voice.md).
// The vosk grammar is a loose bigram LM: it can emit word sequences that are not phrases (and "[unk]" for
// other speech). Only parseCommand decides, and it is exact: one phrase, nothing else.
import type { Command, InstrumentKind } from '../types.ts';

const KIND_WORDS: Record<string, InstrumentKind> = {
  drum: 'drums', drums: 'drums', violin: 'violin', synth: 'synth', bass: 'bass',
};

const SIMPLE: Record<string, Command> = {
  record: { type: 'record' }, stop: { type: 'stop' }, play: { type: 'play' }, undo: { type: 'undo' },
};

/** every phrase vosk may emit (GRAMMAR_JSON adds "[unk]") */
export const COMMAND_PHRASES: readonly string[] = [
  ...Object.keys(KIND_WORDS).map((w) => `create ${w} track`),
  ...Object.keys(SIMPLE),
  ...Object.keys(KIND_WORDS).flatMap((w) => [`mute ${w}`, `${w} back`]),
];

/** vosk's token for out-of-grammar speech */
export const UNK = '[unk]';

/** the grammar handed to vosk's KaldiRecognizer: the phrases plus "[unk]" (absorbs other speech) */
export const GRAMMAR_JSON = JSON.stringify([...COMMAND_PHRASES, UNK]);

/** lowercase, single spaces */
export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** recogniser text for the screen: without "[unk]" tokens */
export function displayText(text: string): string {
  return normalizeText(text.split(UNK).join(' '));
}

/** exact match only; anything else (including vosk's bigram leakage and any "[unk]") is null */
export function parseCommand(text: string): Command | null {
  const t = normalizeText(text);
  if (Object.hasOwn(SIMPLE, t)) return SIMPLE[t];
  const create = /^create (\w+) track$/.exec(t);
  if (create && Object.hasOwn(KIND_WORDS, create[1])) return { type: 'create', kind: KIND_WORDS[create[1]] };
  const mute = /^mute (\w+)$/.exec(t);
  if (mute && Object.hasOwn(KIND_WORDS, mute[1])) return { type: 'toggle', kind: KIND_WORDS[mute[1]], on: false };
  const back = /^(\w+) back$/.exec(t);
  if (back && Object.hasOwn(KIND_WORDS, back[1])) return { type: 'toggle', kind: KIND_WORDS[back[1]], on: true };
  return null;
}

/** a complete command that no other command extends may fire on a partial result */
export function canFireEarly(text: string): boolean {
  const t = normalizeText(text);
  if (!parseCommand(t)) return false;
  return !COMMAND_PHRASES.some((p) => p !== t && p.startsWith(t + ' '));
}

/** identical consecutive partial replies (one per chunk) a command needs before it fires during the hold */
export interface EarlyRule {
  repeats: number;
  toggleOnRepeats: number;
  toggleOffRepeats: number;
}

/**
 * Off (Infinity): commands fire on vosk's final result (endpoint during the hold, or at release).
 * Replayed traces (dev/voice/replay.ts, notes/voice.md): with ≤ 3 repeats, first-word hallucinations ("record" in
 * noisy "what a lovely day") gave 5/64 false positives and on/off flipped 9×; ≥ 5 repeats equals final-only
 * accuracy but almost never fires before a quick release. Re-run the replay on real-voice traces before enabling.
 */
export const EARLY_RULE: EarlyRule = { repeats: Infinity, toggleOnRepeats: Infinity, toggleOffRepeats: Infinity };

/** the command to fire before release, or null: a complete command no other command extends, stable for `repeats` replies */
export function earlyCommand(text: string, repeats: number, rule: EarlyRule = EARLY_RULE): Command | null {
  const c = parseCommand(text);
  if (!c || !canFireEarly(text)) return null;
  const need = c.type !== 'toggle' ? rule.repeats : c.on ? rule.toggleOnRepeats : rule.toggleOffRepeats;
  return repeats >= need ? c : null;
}

/** short human text for the toast */
export function describeCommand(c: Command): string {
  switch (c.type) {
    case 'create': return `${c.kind} track`;
    case 'toggle': return c.on ? `${c.kind} back` : `mute ${c.kind}`;
    default: return c.type;
  }
}
