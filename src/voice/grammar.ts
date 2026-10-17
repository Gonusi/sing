// [voice] The command list, the phrase list fed to vosk, and exact parsing of recogniser text.
// "unmute" is not in the vosk small-en model, so on/off is `<instrument> on|off`.
import type { Command, InstrumentKind } from '../types.ts';

const KIND_WORDS: Record<string, InstrumentKind> = {
  drum: 'drums', drums: 'drums', violin: 'violin', synth: 'synth', bass: 'bass',
};

const SIMPLE: Record<string, Command> = {
  record: { type: 'record' }, stop: { type: 'stop' }, play: { type: 'play' }, undo: { type: 'undo' },
};

/** every phrase vosk may emit (plus "[unk]", added by the recogniser) */
export const COMMAND_PHRASES: readonly string[] = [
  ...Object.keys(KIND_WORDS).map((w) => `create ${w} track`),
  ...Object.keys(SIMPLE),
  ...Object.keys(KIND_WORDS).flatMap((w) => [`${w} on`, `${w} off`]),
];

/** exact match only; anything else (including vosk's bigram leakage) is null */
export function parseCommand(text: string): Command | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t in SIMPLE) return SIMPLE[t];
  const create = /^create (\w+) track$/.exec(t);
  if (create && create[1] in KIND_WORDS) return { type: 'create', kind: KIND_WORDS[create[1]] };
  const toggle = /^(\w+) (on|off)$/.exec(t);
  if (toggle && toggle[1] in KIND_WORDS) return { type: 'toggle', kind: KIND_WORDS[toggle[1]], on: toggle[2] === 'on' };
  return null;
}

/** a complete command that no other command extends may fire on a partial result */
export function canFireEarly(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!parseCommand(t)) return false;
  return !COMMAND_PHRASES.some((p) => p !== t && p.startsWith(t + ' '));
}

/** short human text for the toast */
export function describeCommand(c: Command): string {
  switch (c.type) {
    case 'create': return `${c.kind} track`;
    case 'toggle': return `${c.kind} ${c.on ? 'on' : 'off'}`;
    default: return c.type;
  }
}
