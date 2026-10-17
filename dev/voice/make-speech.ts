// [voice] Speech fixtures for dev/voice/check.ts, made with macOS `say` + `ffmpeg` (both must be installed).
// Writes dev/fixtures/out/speech/<name>.wav (48 kHz mono 16-bit) and manifest.json (SpeechManifest below).
// Layout of every file: LEAD_SILENCE_SEC of silence → the utterance → TAIL_SILENCE_SEC of silence.
// Commands: every COMMAND_PHRASES phrase × VOICES × RATES_WPM, clean and with pink-ish noise.
// Negatives (must never fire): plain sentences, the sung fixture sing-cmaj, silence, noise alone.
// Usage: node dev/voice/make-speech.ts   (regenerates everything; ~1 min)
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { Command } from '../../src/types.ts';
import { COMMAND_PHRASES, parseCommand } from '../../src/voice/grammar.ts';
import { readWavMono, writeWav } from '../wav.ts';
import { FIXTURE_OUT_DIR, createRng, makeFixtures } from '../make-fixtures.ts';

const run = promisify(execFile);

export const SPEECH_DIR = join(FIXTURE_OUT_DIR, 'speech');
export const MANIFEST_PATH = join(SPEECH_DIR, 'manifest.json');

const SAMPLE_RATE_HZ = 48000;
const LEAD_SILENCE_SEC = 0.3;
const TAIL_SILENCE_SEC = 0.6;
/** RMS of the active speech after normalising (close-talk phone level) */
const SPEECH_RMS_DBFS = -18;
/** RMS of the added pink-ish noise → about 12 dB SNR */
const NOISE_RMS_DBFS = -30;
/** a sample louder than this (relative to the file peak) counts as speech, for trimming and speechEnd */
const ACTIVE_THRESHOLD_DB = -40;
/** frames for the active-speech RMS */
const RMS_FRAME_SEC = 0.02;
const SILENCE_FIXTURE_SEC = 2;
const TTS_CONCURRENCY = 8;

export const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Fred', 'Rishi'] as const;
export const RATES_WPM = [170, 220] as const;
const NEGATIVE_SENTENCES = [
  'hello there how are you',
  'what a lovely day',
  'track the record player',
  'I like playing the violin',
  'turn the radio on',
];
const NEGATIVE_RATE_WPM = 180;

export interface SpeechFixture {
  /** file name inside SPEECH_DIR */
  file: string;
  /** what was said ('' for silence/noise, 'sing-cmaj' for the sung line) */
  text: string;
  /** the command the recogniser must return, null = must return nothing */
  command: Command | null;
  kind: 'command' | 'negative';
  voice: string;
  rateWpm: number;
  noisy: boolean;
  /** seconds from the file start */
  speechStart: number;
  speechEnd: number;
  durationSec: number;
}

export interface SpeechManifest {
  sampleRate: number;
  leadSilenceSec: number;
  fixtures: SpeechFixture[];
}

// ---------- signal helpers ----------

const dbToGain = (db: number) => Math.pow(10, db / 20);

/** first/last sample above the threshold relative to the peak */
function activeRange(x: Float32Array): [number, number] {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const thr = peak * dbToGain(ACTIVE_THRESHOLD_DB);
  let a = 0;
  let b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  return [a, b + 1];
}

/** RMS over the louder half of 20 ms frames (ignores pauses inside the utterance) */
function activeRms(x: Float32Array, sampleRate: number): number {
  const n = Math.round(RMS_FRAME_SEC * sampleRate);
  const frames: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j] * x[j];
    frames.push(s / n);
  }
  frames.sort((p, q) => q - p);
  const top = frames.slice(0, Math.max(1, Math.ceil(frames.length / 2)));
  return Math.sqrt(top.reduce((s, v) => s + v, 0) / top.length);
}

/** Paul Kellet's economy pink filter on seeded white noise, scaled to `rmsDbfs` */
function pinkNoise(length: number, rmsDbfs: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  let s = 0;
  for (const v of out) s += v * v;
  const gain = dbToGain(rmsDbfs) / Math.sqrt(s / length);
  for (let i = 0; i < length; i++) out[i] *= gain;
  return out;
}

function addInto(dst: Float32Array, src: Float32Array): Float32Array {
  const out = Float32Array.from(dst);
  for (let i = 0; i < out.length; i++) out[i] += src[i] ?? 0;
  return out;
}

/** lead silence + utterance (normalised) + tail silence */
function layout(utterance: Float32Array): { audio: Float32Array; speechEnd: number } {
  const lead = Math.round(LEAD_SILENCE_SEC * SAMPLE_RATE_HZ);
  const tail = Math.round(TAIL_SILENCE_SEC * SAMPLE_RATE_HZ);
  const gain = dbToGain(SPEECH_RMS_DBFS) / Math.max(1e-9, activeRms(utterance, SAMPLE_RATE_HZ));
  const audio = new Float32Array(lead + utterance.length + tail);
  for (let i = 0; i < utterance.length; i++) audio[lead + i] = utterance[i] * gain;
  return { audio, speechEnd: (lead + utterance.length) / SAMPLE_RATE_HZ };
}

// ---------- TTS ----------

/** `say` → AIFF → ffmpeg → 48 kHz mono float, trimmed to the active part */
async function speak(text: string, voice: string, rateWpm: number, scratch: string): Promise<Float32Array> {
  const base = join(scratch, `${voice}-${rateWpm}-${text.replace(/\W+/g, '_')}`);
  await run('say', ['-v', voice, '-r', String(rateWpm), '-o', `${base}.aiff`, text]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', `${base}.aiff`, '-ar', String(SAMPLE_RATE_HZ), '-ac', '1', '-c:a', 'pcm_f32le', `${base}.wav`]);
  const { samples } = readWavMono(`${base}.wav`);
  const [a, b] = activeRange(samples);
  return samples.slice(a, b);
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- fixtures ----------

interface Job {
  text: string;
  voice: string;
  rateWpm: number;
  kind: 'command' | 'negative';
}

const slug = (s: string) => s.toLowerCase().replace(/\W+/g, '-');

function jobs(): Job[] {
  const out: Job[] = [];
  for (const text of COMMAND_PHRASES) for (const voice of VOICES) for (const rateWpm of RATES_WPM) out.push({ text, voice, rateWpm, kind: 'command' });
  for (const text of NEGATIVE_SENTENCES) for (const voice of VOICES) out.push({ text, voice, rateWpm: NEGATIVE_RATE_WPM, kind: 'negative' });
  return out;
}

/** write the clean and the noisy copy of one recording; returns both manifest rows */
function writePair(base: Omit<SpeechFixture, 'file' | 'noisy' | 'durationSec'>, name: string, audio: Float32Array, seed: number): SpeechFixture[] {
  const noisy = addInto(audio, pinkNoise(audio.length, NOISE_RMS_DBFS, seed));
  const rows: SpeechFixture[] = [];
  for (const [isNoisy, data] of [[false, audio], [true, noisy]] as const) {
    const file = `${name}${isNoisy ? '__noisy' : ''}.wav`;
    writeWav(join(SPEECH_DIR, file), data, SAMPLE_RATE_HZ, 'pcm16');
    rows.push({ ...base, file, noisy: isNoisy, durationSec: data.length / SAMPLE_RATE_HZ });
  }
  return rows;
}

function singFixture(): Float32Array {
  const path = join(FIXTURE_OUT_DIR, 'sing-cmaj.wav');
  if (!existsSync(path)) makeFixtures(FIXTURE_OUT_DIR, ['sing-cmaj']);
  const { sampleRate, samples } = readWavMono(path);
  if (sampleRate !== SAMPLE_RATE_HZ) throw new Error(`sing-cmaj is ${sampleRate} Hz, expected ${SAMPLE_RATE_HZ}`);
  return samples;
}

/** negatives that are not TTS: the sung line, silence, noise alone */
function nonSpeechRows(): SpeechFixture[] {
  const rows: SpeechFixture[] = [];
  const sung = singFixture();
  const [a, b] = activeRange(sung);
  const common = { command: null, kind: 'negative' as const, voice: '-', rateWpm: 0 };
  rows.push(...writePair({ ...common, text: 'sing-cmaj', speechStart: a / SAMPLE_RATE_HZ, speechEnd: b / SAMPLE_RATE_HZ }, 'neg-sing-cmaj', sung, 0x5eed));
  const silence = new Float32Array(Math.round(SILENCE_FIXTURE_SEC * SAMPLE_RATE_HZ));
  // the noisy copy of silence = noise alone
  rows.push(...writePair({ ...common, text: '', speechStart: LEAD_SILENCE_SEC, speechEnd: SILENCE_FIXTURE_SEC - TAIL_SILENCE_SEC }, 'neg-silence', silence, 0x0153));
  return rows;
}

export async function makeSpeech(): Promise<SpeechManifest> {
  rmSync(SPEECH_DIR, { recursive: true, force: true });
  mkdirSync(SPEECH_DIR, { recursive: true });
  const scratch = join(tmpdir(), `sing-speech-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const rows: SpeechFixture[] = [];
  const all = jobs();
  try {
    await pool(all.map((j, i) => ({ j, i })), TTS_CONCURRENCY, async ({ j, i }) => {
      const utterance = await speak(j.text, j.voice, j.rateWpm, scratch);
      const { audio, speechEnd } = layout(utterance);
      const prefix = j.kind === 'command' ? 'cmd' : 'neg';
      const name = `${prefix}-${slug(j.text)}__${j.voice}__${j.rateWpm}`;
      const base = { text: j.text, command: j.kind === 'command' ? parseCommand(j.text) : null, kind: j.kind, voice: j.voice, rateWpm: j.rateWpm, speechStart: LEAD_SILENCE_SEC, speechEnd };
      rows.push(...writePair(base, name, audio, 0x1000 + i));
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  rows.push(...nonSpeechRows());
  rows.sort((p, q) => p.file.localeCompare(q.file));
  const manifest: SpeechManifest = { sampleRate: SAMPLE_RATE_HZ, leadSilenceSec: LEAD_SILENCE_SEC, fixtures: rows };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + '\n');
  return manifest;
}

if (import.meta.main) {
  const t0 = performance.now();
  const m = await makeSpeech();
  const cmd = m.fixtures.filter((f) => f.kind === 'command').length;
  console.log(`wrote ${m.fixtures.length} fixtures (${cmd} command, ${m.fixtures.length - cmd} negative) to ${SPEECH_DIR} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}
