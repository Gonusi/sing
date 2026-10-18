// [dsp] Checks for the setup-wizard analysis (drum templates, voice profile) on the round-3 synthetic fixtures.
// Usage: node dev/check-setup.ts   (run node dev/make-fixtures.ts first)
//   1. per mouth voice: teach kick/snare/hat (3 hits each, detector with captureFeatures) → templates; play the voice's
//      test groove (other examples) with the rules and with the templates → kind accuracy within 40 ms
//   2. drums-phone-boom: soft low booms — how many are detected at all (detection) and how many as kick (classification)
//   3. sing-along-flat: pitchOffset within ±0.05 st of the truth, heldNote = the target
// Exit 1 when templates fall below MIN_TEMPLATE_ACCURACY or the offset misses.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOnsetDetector } from '../src/analysis/drums.ts';
import { createPitchTracker } from '../src/analysis/pitch.ts';
import { heldNote, pitchOffset } from '../src/analysis/voice-profile.ts';
import type { DrumKind, DrumTemplate, OnsetDetectorOptions, PitchFrame, RawHit } from '../src/types.ts';
import { FIXTURE_OUT_DIR, MOUTH_VOICES, SING_ALONG_OFFSET_ST, SING_ALONG_TARGET_MIDI, type FixtureTruth } from './make-fixtures.ts';
import { readWavMono } from './wav.ts';

// ---------- constants ----------
const BLOCK = 512;
const MATCH_SEC = 0.04;
const MIN_TEMPLATE_ACCURACY = 0.9;
const MAX_OFFSET_ERROR_ST = 0.05;
const KINDS: DrumKind[] = ['kick', 'snare', 'hat'];

function load(name: string): { samples: Float32Array; sampleRate: number; truth: FixtureTruth } {
  const wav = join(FIXTURE_OUT_DIR, `${name}.wav`);
  if (!existsSync(wav)) throw new Error(`missing ${wav}: run node dev/make-fixtures.ts`);
  const { samples, sampleRate } = readWavMono(wav);
  return { samples, sampleRate, truth: JSON.parse(readFileSync(wav.replace(/\.wav$/, '.json'), 'utf8')) };
}

export function runDetector(samples: Float32Array, sampleRate: number, opts: OnsetDetectorOptions): RawHit[] {
  const det = createOnsetDetector(opts);
  const hits: RawHit[] = [];
  for (let f = 0; f < samples.length; f += BLOCK) hits.push(...det.push({ frame: f, samples: samples.subarray(f, f + BLOCK) }, sampleRate));
  hits.push(...det.close(samples.length / sampleRate));
  return hits;
}

/** each truth hit's matched detection (nearest within MATCH_SEC) or null */
function match(truth: FixtureTruth['hits'], hits: RawHit[]): (RawHit | null)[] {
  const used = new Set<RawHit>();
  return truth.map((g) => {
    let best: RawHit | null = null;
    for (const h of hits) if (!used.has(h) && Math.abs(h.t - g.t) <= MATCH_SEC && (!best || Math.abs(h.t - g.t) < Math.abs(best.t - g.t))) best = h;
    if (best) used.add(best);
    return best;
  });
}

function main(): number {
  const failures: string[] = [];
  let rulesOk = 0;
  let templOk = 0;
  let quietOk = 0;
  let total = 0;
  console.log('TEMPLATES (teach 3 per kind, test 9 other examples)');
  for (const v of MOUTH_VOICES) {
    const templates: DrumTemplate[] = [];
    let taught = 0;
    for (const kind of KINDS) {
      const { samples, sampleRate, truth } = load(`drums-${v.name}-teach-${kind}`);
      // the wizard keeps every hit heard while the user teaches one kind
      for (const h of runDetector(samples, sampleRate, { captureFeatures: true })) {
        if (h.features) templates.push({ kind, features: h.features });
      }
      taught += truth.hits.length;
    }
    const { samples, sampleRate, truth } = load(`drums-${v.name}-test`);
    const byRules = match(truth.hits, runDetector(samples, sampleRate, {}));
    const byTempl = match(truth.hits, runDetector(samples, sampleRate, { templates }));
    const quiet = samples.map((x) => x * 10 ** (-12 / 20));
    const byTemplQuiet = match(truth.hits, runDetector(quiet, sampleRate, { templates }));
    const ok = (m: (RawHit | null)[]) => m.filter((h, i) => h && h.kind === truth.hits[i].kind).length;
    const show = (m: (RawHit | null)[]) => m.map((h, i) => `${truth.hits[i].kind[0]}→${h ? h.kind[0] : '-'}`).join(' ');
    rulesOk += ok(byRules);
    templOk += ok(byTempl);
    total += truth.hits.length;
    console.log(`  ${v.name}: templates ${templates.length}/${taught}  rules ${ok(byRules)}/9 [${show(byRules)}]  templates ${ok(byTempl)}/9 [${show(byTempl)}]  templates, test 12 dB quieter ${ok(byTemplQuiet)}/9`);
    quietOk += ok(byTemplQuiet);
  }
  console.log(`  total: rules ${rulesOk}/${total} = ${((100 * rulesOk) / total).toFixed(0)}%, templates ${templOk}/${total} = ${((100 * templOk) / total).toFixed(0)}%, templates on a 12 dB quieter test ${quietOk}/${total}`);
  if (templOk / total < MIN_TEMPLATE_ACCURACY) failures.push(`templates ${templOk}/${total} < ${MIN_TEMPLATE_ACCURACY * 100}%`);

  console.log('\nSOFT BOOMS (drums-phone-boom: 8 kicks from -4 to -20 dB between hats)');
  {
    const { samples, sampleRate, truth } = load('drums-phone-boom');
    const m = match(truth.hits, runDetector(samples, sampleRate, {}));
    const kicks = truth.hits.map((g, i) => ({ g, h: m[i] })).filter((x) => x.g.kind === 'kick');
    console.log(`  detected ${kicks.filter((x) => x.h).length}/8, as kick ${kicks.filter((x) => x.h?.kind === 'kick').length}/8: ${kicks.map((x) => (x.h ? x.h.kind : 'MISS')).join(' ')}`);
    const hats = truth.hits.map((g, i) => ({ g, h: m[i] })).filter((x) => x.g.kind === 'hat');
    console.log(`  hats detected ${hats.filter((x) => x.h).length}/8, as hat ${hats.filter((x) => x.h?.kind === 'hat').length}/8`);
  }

  console.log('\nVOICE (sing-along-flat)');
  {
    const { samples, sampleRate } = load('sing-along-flat');
    const tr = createPitchTracker();
    const frames: PitchFrame[] = [];
    for (let f = 0; f < samples.length; f += BLOCK) frames.push(...tr.push({ frame: f, samples: samples.subarray(f, f + BLOCK) }, sampleRate));
    const r = pitchOffset(frames, SING_ALONG_TARGET_MIDI);
    const held = heldNote(frames);
    const err = Math.abs(r.offset - SING_ALONG_OFFSET_ST);
    console.log(`  pitchOffset ok=${r.ok} offset ${r.offset.toFixed(3)} (truth ${SING_ALONG_OFFSET_ST}, error ${err.toFixed(3)}) spread ${r.spread.toFixed(3)}; heldNote ${held}`);
    // an octave down must give the same offset
    const down = pitchOffset(frames, SING_ALONG_TARGET_MIDI + 12);
    console.log(`  against the target an octave up: offset ${down.offset.toFixed(3)}`);
    if (!r.ok || err > MAX_OFFSET_ERROR_ST) failures.push(`pitchOffset ${r.offset.toFixed(3)} vs ${SING_ALONG_OFFSET_ST}`);
    if (held !== SING_ALONG_TARGET_MIDI) failures.push(`heldNote ${held} vs ${SING_ALONG_TARGET_MIDI}`);
  }

  if (failures.length) {
    console.log('\nFAIL');
    for (const f of failures) console.log(`  - ${f}`);
    return 1;
  }
  console.log('\nPASS');
  return 0;
}

if (import.meta.main) process.exitCode = main();
