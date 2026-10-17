// [voice] Compares toggle phrasings (on/off of an instrument) by measured accuracy: `node dev/voice/compare-grammars.ts`.
// Each candidate = the non-toggle phrases (create…/record/stop/play/undo) + its own toggle phrases + "[unk]", run in
// the real recogniser (fast mode, ?grammar=) under several hold conditions, because on/off decisions near the boundary
// flip with tiny input changes (e2e: a −45 dBFS noise bed or speech 0.4 s later in the hold flipped Daniel's toggles).
// Fixtures: candidate toggles from dev/fixtures/out/speech-alt/ (generated here when missing; same voices, rates,
// levels and noise as make-speech), every non-toggle command fixture and all 64 negatives from the main manifest.
// Decision = the recogniser's: an endpoint result fires if it is a phrase no other phrase extends, else the final
// heard text must be exactly a phrase. Usage: [--only a,b] [--conditions plain,e2e,lead] [--pages n]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { normalizeText } from '../../src/voice/grammar.ts';
import type { TraceEvent } from '../../src/voice/recognizer.ts';
import { startDev } from '../lib/serve.ts';
import { ALT_SPEECH_DIR, bootPage, loadModel, openContext, runFixtures, type Row } from './check.ts';
import { MANIFEST_PATH, makePhraseFixtures, type SpeechFixture, type SpeechManifest } from './make-speech.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT_DIR = join(import.meta.dirname, 'out');
const KIND_WORDS = ['drum', 'drums', 'violin', 'synth', 'bass'];
const BASE_PHRASES = [...KIND_WORDS.map((w) => `create ${w} track`), 'record', 'stop', 'play', 'undo'];

/** phrasings for one instrument word w: every `on` phrase means {toggle, on: true}, every `off` one on: false */
interface Candidate {
  name: string;
  on: ((w: string) => string)[];
  off: ((w: string) => string)[];
}

const xOn = (w: string) => `${w} on`;
const xOff = (w: string) => `${w} off`;
const xBack = (w: string) => `${w} back`;
const muteX = (w: string) => `mute ${w}`;
const playX = (w: string) => `play ${w}`;
const CANDIDATES: Candidate[] = [
  { name: 'X on / X off', on: [xOn], off: [xOff] },
  { name: 'X back / mute X', on: [xBack], off: [muteX] },
  { name: 'play X / mute X', on: [playX], off: [muteX] },
  { name: 'X back / X off', on: [xBack], off: [xOff] },
  { name: 'X on / mute X', on: [xOn], off: [muteX] },
  { name: 'X back / X off|mute X', on: [xBack], off: [xOff, muteX] },
];
const ALL_FORMS = [xOn, xOff, xBack, muteX, playX];

interface Condition {
  name: string;
  release: number;
  lead: number;
  bed: number | null;
}

const CONDITIONS: Condition[] = [
  { name: 'plain', release: 0.3, lead: 0, bed: null },
  { name: 'e2e', release: 0.95, lead: 0.4, bed: -45 },
  { name: 'lead', release: 0.3, lead: 0.2, bed: null },
];

const togglePhrases = (c: Candidate) => KIND_WORDS.flatMap((w) => [...c.on, ...c.off].map((f) => f(w)));
const phraseSet = (c: Candidate) => [...BASE_PHRASES, ...togglePhrases(c)];
const KIND_OF: Record<string, string> = { drum: 'drums', drums: 'drums', violin: 'violin', synth: 'synth', bass: 'bass' };

/** the command a phrase means: base phrases by type (create → kind), toggles by kind + direction; null if not a phrase */
function commandKey(phrase: string, forms: { on: ((w: string) => string)[]; off: ((w: string) => string)[] }): string | null {
  const create = /^create (\w+) track$/.exec(phrase);
  if (create && KIND_OF[create[1]]) return `create ${KIND_OF[create[1]]}`;
  if (['record', 'stop', 'play', 'undo'].includes(phrase)) return phrase;
  for (const w of KIND_WORDS) {
    if (forms.on.some((f) => f(w) === phrase)) return `toggle ${KIND_OF[w]} on`;
    if (forms.off.some((f) => f(w) === phrase)) return `toggle ${KIND_OF[w]} off`;
  }
  return null;
}
/** what the speaker meant by any candidate's phrase (for habit phrases outside the grammar) */
const meant = (phrase: string) => commandKey(phrase, { on: [xOn, xBack, playX], off: [xOff, muteX] });

/** the recogniser's decision for a phrase set, from one hold's trace */
export function decide(trace: TraceEvent[], phrases: readonly string[]): string | null {
  const set = new Set(phrases);
  const extended = (t: string) => phrases.some((p) => p !== t && p.startsWith(t + ' '));
  for (const e of trace) {
    const t = normalizeText(e.text);
    if (e.kind === 'endpoint' && set.has(t) && !extended(t)) return t;
    if (e.kind === 'final') return set.has(t) ? t : null;
  }
  const last = trace.at(-1);
  return last && set.has(normalizeText(last.text)) ? normalizeText(last.text) : null;
}

interface Score {
  toggleClean: [number, number];
  toggleNoisy: [number, number];
  other: [number, number];
  fp: number;
  negatives: number;
  /** phrases of other candidates (habit): [did nothing, same command anyway, OPPOSITE/other command] */
  habit: [number, number, number];
  wrong: string[];
}

function score(rows: Row[], c: Candidate): Score {
  const phrases = phraseSet(c);
  const toggles = new Set(togglePhrases(c));
  const key = (t: string | null) => (t === null ? null : commandKey(t, c));
  const s: Score = { toggleClean: [0, 0], toggleNoisy: [0, 0], other: [0, 0], fp: 0, negatives: 0, habit: [0, 0, 0], wrong: [] };
  for (const r of rows) {
    if (!r.rep) continue;
    const got = decide(r.rep.trace, phrases);
    if (r.fx.kind === 'negative') {
      s.negatives++;
      if (got) (s.fp++, s.wrong.push(`FP ${r.fx.file} → "${got}"`));
      continue;
    }
    const want = normalizeText(r.fx.text);
    if (!phrases.includes(want)) {
      // a habit phrase: not in this grammar
      const k = key(got);
      const idx = k === null ? 0 : k === meant(want) ? 1 : 2;
      s.habit[idx]++;
      if (idx === 2) s.wrong.push(`HABIT ${r.fx.file}: "${want}" → "${got}"`);
      continue;
    }
    const bucket = toggles.has(want) ? (r.fx.noisy ? s.toggleNoisy : s.toggleClean) : s.other;
    bucket[1]++;
    if (key(got) === key(want)) bucket[0]++;
    else s.wrong.push(`${r.fx.file}: "${want}" → ${got === null ? 'nothing' : `"${got}"`}`);
  }
  return s;
}

function parseArgs(argv: string[]) {
  const a = { only: [] as string[], conditions: CONDITIONS.map((c) => c.name), pages: 4 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') a.only = argv[++i].split(',');
    else if (argv[i] === '--conditions') a.conditions = argv[++i].split(',');
    else if (argv[i] === '--pages') a.pages = Number(argv[++i]);
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candidates = CANDIDATES.filter((c, i) => !args.only.length || args.only.includes(String(i)) || args.only.includes(c.name));
  const conditions = CONDITIONS.filter((c) => args.conditions.includes(c.name));
  const altManifest = join(ALT_SPEECH_DIR, 'manifest.json');
  const allToggles = [...new Set(KIND_WORDS.flatMap((w) => ALL_FORMS.map((f) => f(w))))];
  let alt = existsSync(altManifest) ? (JSON.parse(readFileSync(altManifest, 'utf8')) as SpeechManifest) : null;
  if (!alt || allToggles.some((p) => !alt!.fixtures.some((f) => f.text === p))) {
    console.log(`generating ${allToggles.length} candidate phrases → ${ALT_SPEECH_DIR} …`);
    alt = await makePhraseFixtures(allToggles, ALT_SPEECH_DIR);
  }
  const main = (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as SpeechManifest).fixtures;
  const others = main.filter((f) => f.kind === 'command' && BASE_PHRASES.includes(f.text));
  const negatives = main.filter((f) => f.kind === 'negative');

  const served = await startDev(ROOT);
  const ctx = await openContext('chromium', join(OUT_DIR, 'profile-compare'));
  const results: Record<string, unknown>[] = [];
  try {
    for (const c of candidates) {
      const grammar = JSON.stringify([...phraseSet(c), '[unk]']);
      const url = `${served.url}dev/voice/index.html?fast&speedup=8&grammar=${encodeURIComponent(grammar)}`;
      const errors: string[] = [];
      const pages: Page[] = [];
      for (let i = 0; i < args.pages; i++) {
        const p = await bootPage(ctx, url, errors);
        const l = await loadModel(p);
        if (l.status !== 'ready') throw new Error(`model: ${l.error}`);
        pages.push(p);
      }
      // all candidate phrasings: this grammar's are scored as commands, the others as habit phrases
      const toggleFx: SpeechFixture[] = alt.fixtures;
      for (const cond of conditions) {
        const rows = await runFixtures(pages, [...toggleFx, ...others, ...negatives], served.url, cond.release, cond.lead, cond.bed);
        const s = score(rows, c);
        results.push({ candidate: c.name, condition: cond.name, ...s });
        const pc = ([ok, n]: [number, number]) => `${ok}/${n} ${((100 * ok) / Math.max(1, n)).toFixed(1)}%`;
        console.log(`${c.name.padEnd(18)} ${cond.name.padEnd(6)} toggles clean ${pc(s.toggleClean).padEnd(15)} noisy ${pc(s.toggleNoisy).padEnd(15)} other cmds ${pc(s.other).padEnd(15)} FP ${s.fp}/${s.negatives} · habit nothing/same/OPPOSITE ${s.habit.join('/')}`);
        for (const w of s.wrong) console.log(`      ${w}`);
      }
      await Promise.all(pages.map((p) => p.close()));
    }
  } finally {
    await ctx.close();
    await served.close();
  }
  writeFileSync(join(OUT_DIR, 'compare-grammars.json'), JSON.stringify(results, null, 1));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
