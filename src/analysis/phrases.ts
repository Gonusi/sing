// [dsp] Group a take's notes into legato phrases (gap < 120 ms), circularly across the loop end. Pure.
//   gap(prev → next) = next.pos − (prev.pos + prev.dur); a gap < LEGATO_GAP_SEC continues the phrase.
//   Across the loop end: gap(last → first) = (first.pos + loopLength) − (last.pos + last.dur).
//   When that wraps, the last note's phrase is the first note's phrase and last.legatoNext = true.
//   Phrase ids are `${takeId}:${n}`, n counted from 0 in loop order (after the wrap merge, ids may skip a number).
import type { Note, Sec } from '../types.ts';

export type PlainNote = Omit<Note, 'phrase' | 'legatoNext'>;

// ---------- constants ----------
export const LEGATO_GAP_SEC = 0.12;

/** true when `next` starts less than LEGATO_GAP_SEC after `prev` ends (`wrap` = loop length added to next.pos) */
export function isLegato(prev: PlainNote, next: PlainNote, wrap: Sec = 0): boolean {
  return next.pos + wrap - (prev.pos + prev.dur) < LEGATO_GAP_SEC;
}

/** notes sorted by pos → notes with `phrase` = `${takeId}:${n}` and `legatoNext` set */
export function assignPhrases(notes: PlainNote[], loopLength: Sec, takeId: string): Note[] {
  const n = notes.length;
  if (n === 0) return [];
  const phraseIndex = new Array<number>(n);
  const legatoNext = new Array<boolean>(n).fill(false);
  let phrase = 0;
  phraseIndex[0] = 0;
  for (let i = 1; i < n; i++) {
    if (isLegato(notes[i - 1], notes[i])) {
      legatoNext[i - 1] = true;
    } else {
      phrase++;
    }
    phraseIndex[i] = phrase;
  }
  // circular: the last note runs into the first note of the next cycle
  if (n > 1 && isLegato(notes[n - 1], notes[0], loopLength)) {
    legatoNext[n - 1] = true;
    const lastPhrase = phraseIndex[n - 1];
    if (lastPhrase !== 0) for (let i = 0; i < n; i++) if (phraseIndex[i] === lastPhrase) phraseIndex[i] = 0;
  } else if (n === 1 && isLegato(notes[0], notes[0], loopLength)) {
    legatoNext[0] = true; // a single note that fills the loop sustains into itself
  }
  return notes.map((note, i) => ({ ...note, phrase: `${takeId}:${phraseIndex[i]}`, legatoNext: legatoNext[i] }));
}
