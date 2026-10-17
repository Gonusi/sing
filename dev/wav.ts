// [dsp] WAV read/write for dev scripts (Node only, uses node:fs).
// Reads PCM 16/24/32-bit integer and 32-bit float (WAVE_FORMAT_EXTENSIBLE too), any channel count.
// Writes mono or multi-channel 16-bit PCM or 32-bit float.
import { readFileSync, writeFileSync } from 'node:fs';

export interface WavData {
  sampleRate: number;
  /** one Float32Array per channel, samples in -1..1 */
  channels: Float32Array[];
}

export type WavWriteFormat = 'pcm16' | 'float32';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Read a WAV file into per-channel float arrays. */
export function readWav(path: string): WavData {
  return parseWav(readFileSync(path));
}

/** Read a WAV file as one mono channel: channel 0 (default, like the iOS mic) or the mixdown of all channels. */
export function readWavMono(path: string, mode: 'channel0' | 'mixdown' = 'channel0'): { sampleRate: number; samples: Float32Array } {
  const wav = readWav(path);
  if (mode === 'channel0' || wav.channels.length === 1) return { sampleRate: wav.sampleRate, samples: wav.channels[0] };
  const n = wav.channels[0].length;
  const mix = new Float32Array(n);
  for (const ch of wav.channels) for (let i = 0; i < n; i++) mix[i] += ch[i];
  const gain = 1 / wav.channels.length;
  for (let i = 0; i < n; i++) mix[i] *= gain;
  return { sampleRate: wav.sampleRate, samples: mix };
}

/** Parse a WAV byte buffer. Throws on unsupported formats. */
export function parseWav(buf: Uint8Array): WavData {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (off: number) => String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

  let format = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, buf.length - body);
      break;
    }
    off = body + size + (size & 1);
  }
  if (dataOffset < 0 || numChannels === 0) throw new Error('WAV has no fmt or data chunk');

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataBytes / (bytesPerSample * numChannels));
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(new Float32Array(frameCount));

  const readSample = sampleReader(view, format, bitsPerSample);
  for (let i = 0; i < frameCount; i++) {
    const frameOff = dataOffset + i * bytesPerSample * numChannels;
    for (let c = 0; c < numChannels; c++) channels[c][i] = readSample(frameOff + c * bytesPerSample);
  }
  return { sampleRate, channels };
}

function sampleReader(view: DataView, format: number, bits: number): (byteOffset: number) => number {
  if (format === WAVE_FORMAT_IEEE_FLOAT && bits === 32) return (o) => view.getFloat32(o, true);
  if (format === WAVE_FORMAT_IEEE_FLOAT && bits === 64) return (o) => view.getFloat64(o, true);
  if (format === WAVE_FORMAT_PCM && bits === 16) return (o) => view.getInt16(o, true) / 32768;
  if (format === WAVE_FORMAT_PCM && bits === 24) {
    return (o) => {
      const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
      return v / 8388608;
    };
  }
  if (format === WAVE_FORMAT_PCM && bits === 32) return (o) => view.getInt32(o, true) / 2147483648;
  if (format === WAVE_FORMAT_PCM && bits === 8) return (o) => (view.getUint8(o) - 128) / 128;
  throw new Error(`unsupported WAV format ${format} with ${bits} bits`);
}

/** Encode channels (equal lengths) as a WAV byte buffer. */
export function encodeWav(channels: Float32Array[], sampleRate: number, format: WavWriteFormat = 'pcm16'): Uint8Array {
  const numChannels = channels.length;
  const frameCount = channels[0].length;
  const bytesPerSample = format === 'pcm16' ? 2 : 4;
  const dataBytes = frameCount * numChannels * bytesPerSample;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const writeTag = (off: number, s: string) => {
    for (let i = 0; i < 4; i++) buf[off + i] = s.charCodeAt(i);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format === 'pcm16' ? WAVE_FORMAT_PCM : WAVE_FORMAT_IEEE_FLOAT, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeTag(36, 'data');
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = channels[c][i];
      if (format === 'pcm16') {
        const clamped = Math.max(-1, Math.min(1, s));
        view.setInt16(off, Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), true);
        off += 2;
      } else {
        view.setFloat32(off, s, true);
        off += 4;
      }
    }
  }
  return buf;
}

/** Write channels (or one mono channel) to a WAV file. */
export function writeWav(path: string, channels: Float32Array | Float32Array[], sampleRate: number, format: WavWriteFormat = 'pcm16'): void {
  const list = Array.isArray(channels) ? channels : [channels];
  writeFileSync(path, encodeWav(list, sampleRate, format));
}
