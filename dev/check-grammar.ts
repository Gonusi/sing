// [voice] Checks that every word of COMMAND_PHRASES is in the vosk model's vocabulary.
// vosk silently drops grammar words it does not know, so a missing word = a command that can never be heard.
// The vocabulary is the input symbol table of graph/Gr.fst inside the model .tar.gz (the small model has no words.txt).
// Usage: node dev/check-grammar.ts [model.tar.gz] [--words a,b,c]   (--words: also look up these words, for exploring)
// Exit code 1 when a command word is missing.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { COMMAND_PHRASES } from '../src/voice/grammar.ts';

const DEFAULT_MODEL = join(import.meta.dirname, '..', 'public', 'vosk', 'vosk-model-small-en-us-0.15.tar.gz');
const GRAPH_ENTRY_SUFFIX = 'graph/Gr.fst';

// ---------- tar (ustar + GNU long names + pax path) ----------

const TAR_BLOCK = 512;

interface TarEntry {
  name: string;
  data: Uint8Array;
}

function cString(buf: Uint8Array, start: number, len: number): string {
  const end = buf.indexOf(0, start);
  return Buffer.from(buf.subarray(start, end >= 0 && end < start + len ? end : start + len)).toString('utf8');
}

function octal(buf: Uint8Array, start: number, len: number): number {
  const s = cString(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/** walk a tar archive; stops early when `visit` returns true */
function walkTar(tar: Uint8Array, visit: (e: TarEntry) => boolean): void {
  let off = 0;
  let longName: string | null = null;
  while (off + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(off, off + TAR_BLOCK);
    if (header.every((b) => b === 0)) return; // end-of-archive marker
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = cString(header, 345, 155);
    const data = tar.subarray(off + TAR_BLOCK, off + TAR_BLOCK + size);
    off += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (type === 'L') {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.from(data).toString('utf8'));
      if (path) longName = path[1];
      continue;
    }
    const base = cString(header, 0, 100);
    const name = longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = null;
    if (visit({ name, data })) return;
  }
}

// ---------- OpenFST binary header + input symbol table ----------

const FST_MAGIC = 2125659606;
const SYMBOL_TABLE_MAGIC = 2125658996;
const FST_HAS_ISYMBOLS = 1;

function createReader(buf: Uint8Array) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const r = {
    i32(): number {
      const v = view.getInt32(p, true);
      p += 4;
      return v;
    },
    i64(): number {
      const v = Number(view.getBigInt64(p, true));
      p += 8;
      return v;
    },
    str(): string {
      const len = r.i32();
      const s = Buffer.from(buf.subarray(p, p + len)).toString('utf8');
      p += len;
      return s;
    },
  };
  return r;
}

/** the words of an OpenFST binary's input symbol table */
export function fstInputSymbols(fst: Uint8Array): Set<string> {
  const r = createReader(fst);
  if (r.i32() !== FST_MAGIC) throw new Error('not an OpenFST binary (bad magic)');
  r.str(); // fst type
  r.str(); // arc type
  r.i32(); // version
  const flags = r.i32();
  r.i64(); // properties
  r.i64(); // start
  r.i64(); // numstates
  r.i64(); // numarcs
  if (!(flags & FST_HAS_ISYMBOLS)) throw new Error('Gr.fst has no input symbol table');
  if (r.i32() !== SYMBOL_TABLE_MAGIC) throw new Error('bad symbol table magic');
  r.str(); // table name
  r.i64(); // available key
  const size = r.i64();
  const words = new Set<string>();
  for (let i = 0; i < size; i++) {
    words.add(r.str());
    r.i64(); // key
  }
  return words;
}

/** the vocabulary of a vosk model .tar.gz */
export function modelVocabulary(modelTarGz: string): Set<string> {
  const tar = gunzipSync(readFileSync(modelTarGz));
  let words: Set<string> | null = null;
  walkTar(tar, (e) => {
    if (!e.name.endsWith(GRAPH_ENTRY_SUFFIX)) return false;
    words = fstInputSymbols(e.data);
    return true;
  });
  if (!words) throw new Error(`${GRAPH_ENTRY_SUFFIX} not found in ${modelTarGz}`);
  return words;
}

/** every distinct word of the command phrases */
export function commandWords(phrases: readonly string[] = COMMAND_PHRASES): string[] {
  return [...new Set(phrases.flatMap((p) => p.split(' ')))].sort();
}

function parseArgs(argv: string[]): { model: string; extra: string[] } {
  let model = DEFAULT_MODEL;
  let extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--words') extra = (argv[++i] ?? '').split(',').filter(Boolean);
    else model = argv[i];
  }
  return { model, extra };
}

if (import.meta.main) {
  const { model, extra } = parseArgs(process.argv.slice(2));
  if (!existsSync(model)) {
    console.error(`model not found: ${model} (run npm run fetch-model)`);
    process.exit(1);
  }
  const vocab = modelVocabulary(model);
  const words = commandWords();
  const missing = words.filter((w) => !vocab.has(w));
  console.log(`vocabulary: ${vocab.size} words · command words: ${words.join(' ')}`);
  for (const w of extra) console.log(`  ${vocab.has(w) ? 'in vocabulary ' : 'NOT in vocabulary'}  ${w}`);
  if (missing.length) {
    console.error(`MISSING from the model (vosk would drop them): ${missing.join(' ')}`);
    process.exit(1);
  }
  console.log('PASS every command word is in the model');
}
