export type ReplayFormat = "auto" | "raw" | "csv";

export interface ReplayRecord {
  lineNumber: number;
  /** Timestamp from the source when one was present. */
  observedAtMs?: number;
  /** Monotonic playback offset, normalized to the first record. */
  offsetMs: number;
  /** Protocol text to feed to an existing line parser. */
  payload: string;
  raw: string;
  columns?: Readonly<Record<string, string>>;
}

export interface ParseReplayOptions {
  format?: ReplayFormat;
  defaultIntervalMs?: number;
  timestampColumn?: string;
  /** Unit used for numeric timestamp columns. Defaults from the header name. */
  timestampUnit?: "milliseconds" | "seconds";
}

export interface ReplayTrack {
  name: string;
  records: ReplayRecord[];
}

export interface ReplayBundle {
  name: string;
  tracks: ReplayTrack[];
  metadata?: unknown;
}

export type ReplayState = "idle" | "playing" | "paused" | "finished";

export interface ReplayClockSnapshot {
  state: ReplayState;
  index: number;
  length: number;
  speed: number;
}

export interface ReplayTimerDriver {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
