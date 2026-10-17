// [engine] Vocal take audio in IndexedDB: Int16 PCM under `sing.audio.<takeId>` (idb-keyval), plus a decoded
// AudioBuffer cache. Every IndexedDB call is try/catch: the app keeps working (in memory) when storage fails.
// GC invariant: after gc(referenced), the stored audio keys ⊆ referenced (keys in the session + the undo stack).
import { del, get, keys, set } from 'idb-keyval';
import type { Session } from '../types.ts';

export const AUDIO_KEY_PREFIX = 'sing.audio.';

export function audioKey(takeId: string): string {
  return `${AUDIO_KEY_PREFIX}${takeId}`;
}

export function toInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

export function fromInt16(x: Int16Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] / (x[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

/** audio keys referenced by these sessions */
export function referencedAudio(sessions: Session[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) for (const t of s.tracks) if (t.take?.audio) out.add(t.take.audio.key);
  return out;
}

export interface AudioStore {
  /** decoded buffer, if loaded */
  buffer(key: string): AudioBuffer | null;
  /** keep in memory (decoded from the Int16 values, as it will be after a reload) and save to IndexedDB */
  put(key: string, pcm: Float32Array, sampleRate: number): Promise<void>;
  /** load every referenced key that is not in memory yet */
  loadAll(keysWanted: Iterable<string>): Promise<void>;
  /** delete stored + cached audio that is not referenced */
  gc(referenced: Set<string>): Promise<void>;
}

export function createAudioStore(ctx: BaseAudioContext, opts: { persist?: boolean } = {}): AudioStore {
  const persist = opts.persist ?? true;
  const cache = new Map<string, AudioBuffer>();
  const toBuffer = (pcm: Float32Array, sampleRate: number) => {
    const b = ctx.createBuffer(1, Math.max(1, pcm.length), sampleRate);
    b.getChannelData(0).set(pcm);
    return b;
  };
  return {
    buffer: (key) => cache.get(key) ?? null,
    async put(key, pcm, sampleRate) {
      const i16 = toInt16(pcm);
      cache.set(key, toBuffer(fromInt16(i16), sampleRate));
      if (!persist) return;
      try {
        await set(key, { sampleRate, pcm: i16 });
      } catch (e) {
        console.warn('vocal audio not saved', key, e);
      }
    },
    async loadAll(keysWanted) {
      for (const key of keysWanted) {
        if (cache.has(key)) continue;
        try {
          const v = (await get(key)) as { sampleRate: number; pcm: Int16Array } | undefined;
          if (v?.pcm instanceof Int16Array && v.sampleRate > 0) cache.set(key, toBuffer(fromInt16(v.pcm), v.sampleRate));
          else console.warn('vocal audio missing', key);
        } catch (e) {
          console.warn('vocal audio not loaded', key, e);
        }
      }
    },
    async gc(referenced) {
      for (const k of [...cache.keys()]) if (!referenced.has(k)) cache.delete(k);
      if (!persist) return;
      try {
        const stored = (await keys()).filter((k): k is string => typeof k === 'string' && k.startsWith(AUDIO_KEY_PREFIX));
        for (const k of stored) if (!referenced.has(k)) await del(k);
      } catch (e) {
        console.warn('vocal audio gc failed', e);
      }
    },
  };
}
