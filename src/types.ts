// The shared contract between areas (dsp, engine, instruments, shell, voice, tester).
// Only the coordinator edits this file. Types and `as const` arrays only — no runtime logic.
//
// Time domains:
//   Sec  — AudioContext.currentTime seconds, unless the field is named `pos`.
//   pos  — seconds from the loop start, 0 <= pos < loopLength.

export type Sec = number;

/** 'vocals' = the singer's raw recorded voice (audio take), the others are played from notes/hits */
export const INSTRUMENTS = ['drums', 'violin', 'synth', 'bass', 'vocals'] as const;
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

/** Raw audio of a vocal take, stored apart (IndexedDB key `key`, Int16 PCM); sample 0 = loop pos 0. */
export interface TakeAudio {
  key: string;
  sampleRate: number;
  /** samples (L plus the seam tail) */
  length: number;
}

/** A detected note in loop position, before smoothing and snapping (fractional midi). */
export interface RawLoopNote {
  pos: Sec;
  dur: Sec;
  midi: number;
  vel: number;
  /** see RawNote.attack */
  attack?: boolean;
}

/** One recorded take. Drum tracks use `hits`, vocal tracks use `audio` + `peaks`, all others use `notes`. */
export interface Take {
  id: string;
  /** what the take plays: derived from `raw` by cleanNotes(smoothing) + snap + register fit + phrases */
  notes: Note[];
  /** the detections the notes were derived from, kept so a smoothing change can re-derive them (melodic takes) */
  raw?: RawLoopNote[];
  hits: DrumHit[];
  audio?: TakeAudio;
  /** ~256 peak levels 0..1 across the loop, for drawing a vocal take */
  peaks?: number[];
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
  /** song-wide settings; missing in older saved sessions (treat as defaults). smooth = note smoothing 0..1 */
  fx?: { echo: number; smooth?: number; click?: boolean };
  /** song tempo; missing in older sessions (treat as DEFAULT_TEMPO). The loop length is a whole number of bars. */
  tempo?: Tempo;
}

/** Per device, stored apart from the session (undo never touches it). */
export interface DeviceSettings {
  /** mic input latency: corrected time = mic stamp − inLat */
  inLat: Sec;
  /** getUserMedia echoCancellation */
  ec: boolean;
  calibrated: boolean;
  /** chosen audio input deviceId (null/missing = browser default, e.g. a Bluetooth headset's mic) */
  micId?: string | null;
  // ---- learned in the setup wizard (all optional: missing = not set up) ----
  /** what the user listens on (sets ec + mic choice) */
  output?: OutputKind;
  /** the singer's habitual pitch offset in semitones (−0.33 = sings a third of a semitone flat); removed before snapping */
  tuningOffset?: number;
  /** comfortable sung range (integer midi), for register fit */
  range?: { lo: number; hi: number };
  /** the user's own drum sounds; drum hits are classified by nearest template when present */
  drums?: DrumTemplate[];
  /** the setup wizard was completed or skipped (it shows on first launch until then) */
  setupDone?: boolean;
}

export type OutputKind = 'wired' | 'bluetooth' | 'speaker';

/** one taught drum sound: its kind and the feature vector of one example hit (dsp's hitFeatures) */
export interface DrumTemplate {
  kind: DrumKind;
  features: number[];
}

// ---------- raw detections (analysis output, context time, not yet snapped) ----------

export interface RawNote {
  /** onset, context time of the mic stamp (latency not yet subtracted) */
  t: Sec;
  dur: Sec;
  /** fractional MIDI (median over the note), not snapped */
  midi: number;
  vel: number;
  /** true when the note starts a new articulation (after silence or an energy dip); smoothing never merges across it */
  attack?: boolean;
}

export interface RawHit {
  t: Sec;
  kind: DrumKind;
  vel: number;
  /** feature vector of the hit (hitFeatures), filled when the detector is created with captureFeatures */
  features?: number[];
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

export interface OnsetDetectorOptions {
  /** classify by nearest template instead of the fixed rules (falls back to rules for kinds without templates) */
  templates?: DrumTemplate[];
  /** attach RawHit.features (the setup wizard collects templates this way) */
  captureFeatures?: boolean;
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

export interface Tempo {
  bpm: number;
  beatsPerBar: number;
}
export const DEFAULT_TEMPO: Tempo = { bpm: 90, beatsPerBar: 4 };
export const TEMPO_MIN_BPM = 40;
export const TEMPO_MAX_BPM = 200;

/**
 * idle = no loop yet; countIn = one bar of clicks before recording (first take or a record from stopped);
 * stopped = paused at `View.playhead` (play resumes there).
 */
export type AppState = 'idle' | 'countIn' | 'recordingFirst' | 'playing' | 'overdubbing' | 'stopped';

/** The bottom transport bar; voice commands record / stop / play map onto the same actions. */
export type TransportAction = 'play' | 'pause' | 'record' | 'toStart';

export type Command =
  | { type: 'create'; kind: InstrumentKind }
  | { type: 'record' }
  | { type: 'stop' }
  | { type: 'play' }
  | { type: 'undo' }
  | { type: 'toggle'; kind: InstrumentKind; on: boolean };

/** All times are ctx.currentTime at pointerdown. Taps fire on release, holds fire holdStart at 300 ms. */
export type Gesture =
  /** x, y: client coordinates of the tap (the stage maps x to a loop position for seeking) */
  | { type: 'tap'; tDown: Sec; x?: number; y?: number }
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
  /** vocal take in progress: peak levels 0..1 per bin across the loop (same bins as Take.peaks), null otherwise */
  livePeaks: number[] | null;
  /** loop position heard now (null when no loop is playing) */
  loopPos: Sec | null;
  /** seconds into the first take while recordingFirst; seconds left in the overdub window while overdubbing */
  elapsed: Sec | null;
  /** the song tempo (DEFAULT_TEMPO until set) */
  tempo: Tempo;
  /** where the playhead is: the heard position while playing, the resume position while stopped (null = no loop) */
  playhead: Sec | null;
  /** beat clock for pulsing UI: bar (1-based), beat in bar (1-based), phase 0..1 within the beat; null when not running */
  beat: { bar: number; beat: number; phase: number } | null;
  /** count-in: beats left (counts down to 1), null otherwise */
  countIn: number | null;
  /** tempo can be changed (false once a vocal take exists: raw audio can't be stretched yet) */
  tempoEditable: boolean;
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
  /** global echo/space amount 0..1 (saved in Session.fx, not an undo point) */
  setEcho(amount: number): void;
  /** note smoothing 0..1 (Session.fx.smooth, not an undo point); re-derives every melodic take's notes from its raw */
  setSmoothing(amount: number): void;
  /** remove a lane (an undo point); false if the id is unknown */
  deleteTrack(trackId: string): boolean;
  /** the bottom transport bar (see TransportAction); false = refused in this state */
  transport(action: TransportAction, tDown: Sec): boolean;
  /** move the playhead to loop position `pos` (snapped to the nearest beat); refused while recording */
  seek(pos: Sec): boolean;
  /** clamp to TEMPO_MIN..MAX; rescales note/drum takes, refused when !tempoEditable */
  setTempo(bpm: number): boolean;
  /** metronome click on/off (Session.fx.click; the count-in always clicks) */
  setClick(on: boolean): void;
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

// ---------- setup wizard ----------

export type SetupStepId = 'listening' | 'mic' | 'latency' | 'drums' | 'voice' | 'commands';

/**
 * What the wizard's steps can ask of the app (implemented by the engine, wired in main.ts). Every step is independent
 * so a later version can launch any one of them alone. Nothing here changes the song.
 */
export interface SetupApi {
  /** best guess of the output from outputLatency etc. */
  guessOutput(): OutputKind;
  /** set ec (speaker → on, headphones → off) and, for bluetooth, prefer the built-in mic; saves DeviceSettings.output */
  applyOutput(kind: OutputKind): Promise<void>;
  /** play a sine tone now (through the master bus, no echo) */
  playTone(midi: number, sec: Sec): void;
  /** live mic level 0..1 (RMS, smoothed) */
  level(): number;
  /** measure the room's noise floor (RMS) over `sec` seconds of silence */
  noiseFloor(sec: Sec): Promise<number>;
  /** the clap-along calibration (same as settings), saves inLat */
  calibrate(onClick: (i: number, n: number, phase: 'listen' | 'measure') => void): Promise<{ ok: boolean; text: string }>;
  /** record `count` hits of one drum sound; onHit per detected hit; resolves the templates (≤ count) after the last hit or `timeoutSec` */
  teachDrum(kind: DrumKind, count: number, onHit: (i: number) => void, timeoutSec: Sec): Promise<DrumTemplate[]>;
  /** live test pad with the given templates: onHit per classified hit; returns stop */
  testDrums(templates: DrumTemplate[], onHit: (kind: DrumKind) => void): () => void;
  /** the user hums along with a played reference note for `sec`; onPitch gives live fractional midi (null = unvoiced) */
  singAlong(midi: number, sec: Sec, onPitch: (midi: number | null) => void): Promise<{ ok: boolean; offset: number; spread: number }>;
  /** hum the lowest / highest comfortable note for `sec`; resolves the held note (integer midi) or null */
  captureRange(which: 'low' | 'high', sec: Sec, onPitch: (midi: number | null) => void): Promise<number | null>;
  /** try one voice command without running it: listening starts now, `stop()` ends it and resolves what was heard */
  tryCommand(): { stop(): Promise<{ text: string; command: Command | null }> };
  /** current recogniser state (the model may still be downloading) */
  voiceStatus(): { status: VoiceStatus; progress: number };
  /** save learned settings (merged into DeviceSettings) */
  save(patch: Partial<DeviceSettings>): Promise<void>;
  device(): DeviceSettings;
}
