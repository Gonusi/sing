// The shared contract between areas (dsp, engine, instruments, shell, voice, tester).
// Only the coordinator edits this file. Types and `as const` arrays only — no runtime logic.
//
// Time domains:
//   Sec  — AudioContext.currentTime seconds, unless the field is named `pos`.
//   pos  — seconds from the loop start, 0 <= pos < loopLength.

export type Sec = number;

export const INSTRUMENTS = ['drums', 'violin', 'synth', 'bass'] as const;
export type InstrumentKind = (typeof INSTRUMENTS)[number];

export const DRUM_KINDS = ['kick', 'snare', 'hat'] as const;
export type DrumKind = (typeof DRUM_KINDS)[number];

// ---------- committed musical events (stored in the session) ----------

/** An autotuned note inside a take. */
export interface Note {
  pos: Sec;
  dur: Sec;
  /** integer MIDI note after autotune and register fit */
  midi: number;
  /** 0..1 loudness of the sung note */
  vel: number;
  /** `${takeId}:${n}` — notes sharing a phrase are played legato */
  phrase: string;
  /** true when the next note (circularly, across the loop end) continues this phrase */
  legatoNext: boolean;
}

export interface DrumHit {
  pos: Sec;
  kind: DrumKind;
  vel: number;
}

/** One recorded take. Drum tracks use `hits`, all other instruments use `notes`. */
export interface Take {
  id: string;
  notes: Note[];
  hits: DrumHit[];
}

export interface Track {
  id: string;
  kind: InstrumentKind;
  take: Take | null;
  on: boolean;
}

export interface Session {
  v: 1;
  /** null until the first take sets it */
  loopLength: Sec | null;
  tracks: Track[];
  selectedId: string | null;
}

/** Per device, stored apart from the session (undo never touches it). */
export interface DeviceSettings {
  /** mic input latency: corrected time = mic stamp − inLat */
  inLat: Sec;
  /** getUserMedia echoCancellation */
  ec: boolean;
  calibrated: boolean;
}

// ---------- raw detections (analysis output, context time, not yet snapped) ----------

export interface RawNote {
  /** onset, context time of the mic stamp (latency not yet subtracted) */
  t: Sec;
  dur: Sec;
  /** fractional MIDI (median over the note), not snapped */
  midi: number;
  vel: number;
}

export interface RawHit {
  t: Sec;
  kind: DrumKind;
  vel: number;
}

/** A block of mic samples. `frame` = AudioContext frame index of samples[0]; time = frame / sampleRate. */
export interface MicBlock {
  frame: number;
  samples: Float32Array;
}

export interface PitchFrame {
  /** centre of the analysis window, context time */
  t: Sec;
  /** null when unvoiced / below the clarity or volume gate */
  hz: number | null;
  clarity: number;
  /** RMS of the central 20 ms of the window */
  rms: number;
}

// ---------- analysis interfaces (implemented in src/analysis, pure: no DOM, no Node globals) ----------

export interface PitchTracker {
  /** feed a block; returns every frame completed by it (hop 480 samples at 48 kHz ≈ 10 ms) */
  push(block: MicBlock, sampleRate: number): PitchFrame[];
  reset(): void;
}

export interface NoteSegmenter {
  /** feed one frame; returns notes that became final */
  push(frame: PitchFrame): RawNote[];
  /** the note currently being sung, if any (for live drawing) */
  open(): RawNote | null;
  /** force-finish at context time `at`; returns the notes finalised by it (notes returned earlier are NOT clipped — callers clip to their window; a truncated note < 80 ms is dropped) */
  close(at: Sec): RawNote[];
  reset(): void;
}

export interface OnsetDetector {
  /** feed a block; returns hits that became final (classified ≤ ~82 ms after their onset) */
  push(block: MicBlock, sampleRate: number): RawHit[];
  /** force-classify onsets still waiting for their window, using audio up to `at`; resets pending state */
  close(at: Sec): RawHit[];
  reset(): void;
}

// ---------- audio plumbing ----------

export interface MicFeed {
  readonly sampleRate: number;
  /** every mic block, in order */
  subscribe(cb: (block: MicBlock) => void): () => void;
  /** samples between two context times from the 2 s ring buffer (clipped to what is held) */
  read(from: Sec, to: Sec): { t: Sec; samples: Float32Array };
  /** test only: play `buf` into the mic path from context time `at` */
  inject(buf: AudioBuffer, at: Sec): void;
}

/** One playing instrument for one track. Created by src/instruments, driven by the scheduler. */
export interface Voice {
  readonly kind: InstrumentKind;
  /** native GainNode on the shared AudioContext; the engine connects it to the master bus */
  readonly output: GainNode;
  /**
   * Play one event at context time `when` (already latency-compensated by the scheduler).
   * `offset` > 0 means catch-up: the note should have started `offset` seconds ago — play the remainder.
   */
  play(ev: Note | DrumHit, when: Sec, offset?: Sec): void;
  stopAll(at: Sec): void;
  dispose(): void;
}

export interface ScheduledTrack {
  track: Track;
  voice: Voice;
  /** play only occurrences at or after this context time (new overdub lane) */
  activeFrom?: Sec;
  /** play only occurrences before this context time (lane being re-recorded) */
  activeUntil?: Sec;
}

export interface Scheduler {
  readonly running: boolean;
  /** loop position 0 is heard at `origin`; start scheduling from context time `from` */
  start(origin: Sec, loopLength: Sec, from: Sec): void;
  stop(at: Sec): void;
  /** loop position heard at context time `at` (null when stopped) */
  pos(at: Sec): Sec | null;
  setTracks(tracks: ScheduledTrack[]): void;
}

// ---------- app ----------

export type AppState = 'idle' | 'recordingFirst' | 'playing' | 'overdubbing' | 'stopped';

export type Command =
  | { type: 'create'; kind: InstrumentKind }
  | { type: 'record' }
  | { type: 'stop' }
  | { type: 'play' }
  | { type: 'undo' }
  | { type: 'toggle'; kind: InstrumentKind; on: boolean };

/** All times are ctx.currentTime at pointerdown. Taps fire on release, holds fire holdStart at 300 ms. */
export type Gesture =
  | { type: 'tap'; tDown: Sec }
  | { type: 'holdStart'; tDown: Sec }
  | { type: 'holdEnd'; tDown: Sec; tUp: Sec };

export interface LogEvent {
  t: Sec;
  /** e.g. 'state', 'command', 'sched', 'take', 'error' */
  type: string;
  data?: Record<string, unknown>;
}

/** What the controller exposes to the UI each animation frame. */
export interface View {
  state: AppState;
  session: Session;
  /** lane currently being recorded */
  recordingTrackId: string | null;
  /** notes/hits of the take in progress, already in loop positions */
  liveNotes: Note[];
  liveHits: DrumHit[];
  /** note currently being sung (pos + fractional midi) */
  openNote: { pos: Sec; midi: number } | null;
  /** loop position heard now (null when no loop is playing) */
  loopPos: Sec | null;
  /** seconds into the first take while recordingFirst; seconds left in the overdub window while overdubbing */
  elapsed: Sec | null;
}

export type VoiceStatus = 'off' | 'loading' | 'ready' | 'error';

/** View plus the input/voice state main.ts tracks; this is what the UI renders. */
export interface UiView extends View {
  holding: boolean;
  partial: string;
  toast: { text: string; kind: 'ok' | 'err'; at: number } | null;
  voice: VoiceStatus;
  voiceProgress: number;
}

export interface Controller {
  readonly state: AppState;
  readonly session: Session;
  readonly device: DeviceSettings;
  view(): View;
  gesture(g: Gesture): void;
  /** apply a command read against the state at `tDown`; false = refused/ignored in that state */
  command(c: Command, tDown: Sec): boolean;
  select(trackId: string): void;
  toggleTrack(trackId: string): void;
  setDevice(patch: Partial<DeviceSettings>): Promise<void>;
  clearSession(): Promise<void>;
  /** WAV of the raw mic audio of the last take (for exporting real fixtures) */
  lastTakeWav(): Blob | null;
  /** the output node of a track's voice (tests capture it) */
  voiceOutput(trackId: string): AudioNode | null;
  onChange(cb: () => void): () => void;
  onLog(cb: (e: LogEvent) => void): () => void;
  /** the last LOG_MAX events, including those from before anyone subscribed */
  logs(): LogEvent[];
}

export interface Recognizer {
  readonly status: VoiceStatus;
  load(onProgress: (fraction: number) => void): Promise<void>;
  /** start a hold: feed audio from the ring buffer at `fromT` onwards */
  begin(fromT: Sec): void;
  /** end the hold; resolves with the command (early-fired or final), or null */
  end(): Promise<Command | null>;
  /** fires once per hold, as soon as a command is certain (early or at end) */
  onCommand(cb: (c: Command) => void): () => void;
  onPartial(cb: (text: string) => void): () => void;
}

/** window.__sing, installed only with ?test */
export interface SingTestApi {
  state(): AppState;
  session(): Session;
  view(): View;
  log(): LogEvent[];
  now(): Sec;
  device(): DeviceSettings;
  setDevice(patch: Partial<DeviceSettings>): Promise<void>;
  gesture(g: Gesture): void;
  command(c: Command, tDown?: Sec): void;
  mic: {
    /** fetch + decode `url`, inject it into the mic path at context time `at` (default now + 0.1); resolves with `at` */
    play(url: string, at?: Sec): Promise<Sec>;
  };
  capture: {
    /** start recording the master bus (or one track's voice output) */
    start(trackId?: string): void;
    stop(): Promise<{ frame: number; sampleRate: number; pcm: Float32Array }>;
  };
  voice: {
    /** pretend the recognizer heard `text` during a hold that started at `tDown` */
    inject(text: string, tDown?: Sec): void;
  };
}
