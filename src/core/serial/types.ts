import type { DataHealth, ParseOutcome, PortLifecycle, SourceRole } from "../types";

export interface SerialReaderLike {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}

export interface SerialReadableLike {
  getReader(): SerialReaderLike;
}

export interface ReadOnlySerialPort {
  readonly readable: SerialReadableLike | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export interface SerialPortProvider {
  requestPort(options?: { filters?: readonly { usbVendorId?: number; usbProductId?: number }[] }): Promise<ReadOnlySerialPort>;
}

export interface PortStats {
  bytesReceived: number;
  linesReceived: number;
  validFrames: number;
  parseErrors: number;
  ignoredLines: number;
  wrongRoleLines: number;
}

export interface PortSnapshot {
  role: SourceRole;
  lifecycle: PortLifecycle;
  health: DataHealth;
  selected: boolean;
  lastByteAtMs: number | null;
  lastValidFrameAtMs: number | null;
  detectedRole: SourceRole | null;
  error: string | null;
  stats: PortStats;
}

export interface ReceivedLine<T> {
  line: string;
  observedAtMs: number;
  framingWarnings: string[];
  outcome: ParseOutcome<T>;
}

export interface PortSessionOptions<T> {
  role: SourceRole;
  provider: SerialPortProvider;
  adapter: { parse(line: string, observedAtMs: number): ParseOutcome<T> };
  baudRate?: number;
  staleAfterMs?: number;
  wrongRoleThreshold?: number;
  now?: () => number;
  onLine?: (received: ReceivedLine<T>) => void;
  onChange?: (snapshot: PortSnapshot) => void;
}
