// [dsp] Group a take's notes into legato phrases (gap < 120 ms), circularly across the loop end. Pure.
import type { Note, Sec } from '../types.ts';

export type PlainNote = Omit<Note, 'phrase' | 'legatoNext'>;

/** notes sorted by pos → notes with `phrase` = `${takeId}:${n}` and `legatoNext` set */
export function assignPhrases(notes: PlainNote[], _loopLength: Sec, takeId: string): Note[] {
  // STUB (dsp replaces): every note its own phrase.
  return notes.map((n, i) => ({ ...n, phrase: `${takeId}:${i}`, legatoNext: false }));
}
