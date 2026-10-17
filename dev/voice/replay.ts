// [voice] Replays the reply traces of a dev/voice/check.ts run under candidate early-fire rules (EarlyRule grid),
// so the rule is chosen from data without re-running the browser. Same decision code as the recogniser:
// grammar.earlyCommand for partials, canFireEarly+parseCommand for endpoint results, parseCommand for the final.
// Usage: node dev/voice/replay.ts [dev/voice/out/chromium-dev-fast.json] [--release 0.05]
// Reply i of a hold covers the audio up to (i + 1) × CHUNK_SEC after touch-down (the ring read starts at touch-down,
// chunks are contiguous) → "fired before release" = (i + 1) × CHUNK_SEC < speechEnd + release.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from '../../src/types.ts';
import { EARLY_RULE, canFireEarly, earlyCommand, parseCommand, type EarlyRule } from '../../src/voice/grammar.ts';
import { CHUNK_SEC, type TraceEvent } from '../../src/voice/recognizer.ts';
import type { SpeechFixture } from './make-speech.ts';

const NEVER = 99;

interface Row {
  fx: SpeechFixture;
  rep: { trace: TraceEvent[] } | null;
}

interface Outcome {
  command: Command | null;
  /** reply index of an early fire, null = fired at the final (or never) */
  earlyAt: number | null;
}

export function replay(trace: TraceEvent[], rule: EarlyRule): Outcome {
  let lastText = '';
  let repeats = 0;
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    if (e.kind === 'final') return { command: parseCommand(e.text), earlyAt: null };
    repeats = e.text === lastText ? repeats + 1 : 1;
    lastText = e.text;
    const c = e.kind === 'endpoint' ? (canFireEarly(e.text) ? parseCommand(e.text) : null) : earlyCommand(e.text, repeats, rule);
    if (c) return { command: c, earlyAt: i };
  }
  // no final reply (timeout): the recogniser parses the best text so far
  return { command: parseCommand(lastText), earlyAt: null };
}

const same = (a: Command | null, b: Command | null) => JSON.stringify(a) === JSON.stringify(b);

function score(rows: Row[], rule: EarlyRule, release: number) {
  let cleanOk = 0, cleanN = 0, noisyOk = 0, noisyN = 0, wrong = 0, fp = 0, early = 0, earlyBeforeRelease = 0;
  const delays: number[] = [];
  for (const r of rows) {
    if (!r.rep) continue;
    const o = replay(r.rep.trace, rule);
    if (r.fx.kind === 'negative') {
      if (o.command) fp++;
      continue;
    }
    const ok = same(o.command, r.fx.command);
    if (r.fx.noisy) (noisyN++, ok && noisyOk++);
    else (cleanN++, ok && cleanOk++);
    if (o.command && !ok) wrong++;
    if (ok && o.earlyAt !== null) {
      early++;
      const t = (o.earlyAt + 1) * CHUNK_SEC;
      delays.push(t - r.fx.speechEnd);
      if (t < r.fx.speechEnd + release) earlyBeforeRelease++;
    }
  }
  delays.sort((a, b) => a - b);
  const median = delays.length ? delays[Math.floor(delays.length / 2)] : null;
  return { cleanOk, cleanN, noisyOk, noisyN, wrong, fp, early, earlyBeforeRelease, median };
}

function grid(): EarlyRule[] {
  const out: EarlyRule[] = [];
  for (const repeats of [1, 2, 3, 4, NEVER])
    for (const toggleOnRepeats of [2, 3, 4, 5, NEVER])
      for (const toggleOffRepeats of [2, 3, 4, NEVER]) out.push({ repeats, toggleOnRepeats, toggleOffRepeats });
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--release');
  const release = ri >= 0 ? Number(argv.splice(ri, 2)[1]) : 0.3;
  const file = argv[0] ?? join(import.meta.dirname, 'out', 'chromium-dev-fast.json');
  const rows = (JSON.parse(readFileSync(file, 'utf8')) as { rows: Row[] }).rows.filter((r) => r.rep?.trace);
  const cur = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
  console.log(`replay ${file}: ${rows.length} holds with traces · release +${release} s · current EARLY_RULE ${cur(EARLY_RULE.repeats)}/${cur(EARLY_RULE.toggleOnRepeats)}/${cur(EARLY_RULE.toggleOffRepeats)}`);
  const results = grid().map((rule) => ({ rule, s: score(rows, rule, release) }));
  results.sort((a, b) => a.s.fp - b.s.fp || a.s.wrong - b.s.wrong || b.s.cleanOk + b.s.noisyOk - (a.s.cleanOk + a.s.noisyOk) || b.s.earlyBeforeRelease - a.s.earlyBeforeRelease);
  const fmt = (n: number) => (n === NEVER ? '∞' : String(n));
  console.log('  repeats on off │ clean   noisy   wrong FP │ early  before-release  median fire after speech end');
  for (const { rule, s } of results.slice(0, 40)) {
    const cmdOk = s.cleanOk + s.noisyOk;
    console.log(`  ${fmt(rule.repeats).padStart(7)} ${fmt(rule.toggleOnRepeats).padStart(2)} ${fmt(rule.toggleOffRepeats).padStart(3)} │ ${`${s.cleanOk}/${s.cleanN}`.padEnd(7)} ${`${s.noisyOk}/${s.noisyN}`.padEnd(7)} ${String(s.wrong).padStart(5)} ${String(s.fp).padStart(2)} │ ${`${s.early}/${cmdOk}`.padEnd(7)} ${String(s.earlyBeforeRelease).padStart(14)}  ${s.median === null ? '—' : `${Math.round(s.median * 1000)} ms`}`);
  }
}
