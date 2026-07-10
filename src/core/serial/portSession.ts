import type { DataHealth, ParseOutcome, PortLifecycle, SourceRole } from "../types";
import { detectProtocolRole } from "../../protocols/detect";
import { LineFramer } from "./lineFramer";
import type {
  PortSessionOptions,
  PortSnapshot,
  PortStats,
  ReadOnlySerialPort,
  SerialReaderLike,
} from "./types";

const EMPTY_STATS = (): PortStats => ({
  bytesReceived: 0,
  linesReceived: 0,
  validFrames: 0,
  parseErrors: 0,
  ignoredLines: 0,
  wrongRoleLines: 0,
});

export class PortSession<T> {
  private readonly role: SourceRole;
  private readonly options: Required<Pick<PortSessionOptions<T>, "baudRate" | "staleAfterMs" | "wrongRoleThreshold">> & PortSessionOptions<T>;
  private port: ReadOnlySerialPort | null = null;
  private reader: SerialReaderLike | null = null;
  private readTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private lifecycle: PortLifecycle = "idle";
  private lastByteAtMs: number | null = null;
  private lastValidFrameAtMs: number | null = null;
  private detectedRole: SourceRole | null = null;
  private error: string | null = null;
  private stats = EMPTY_STATS();
  private consecutiveWrongRole = 0;
  private stopping = false;

  constructor(options: PortSessionOptions<T>) {
    this.role = options.role;
    this.options = {
      ...options,
      baudRate: options.baudRate ?? 115200,
      staleAfterMs: options.staleAfterMs ?? 1500,
      wrongRoleThreshold: options.wrongRoleThreshold ?? 3,
    };
  }

  async requestPort(): Promise<ReadOnlySerialPort> {
    if (this.lifecycle !== "idle" && this.lifecycle !== "error") throw new Error("port session is busy");
    this.setLifecycle("requesting");
    try {
      this.port = await this.options.provider.requestPort();
      this.error = null;
      this.clearDataState();
      this.setLifecycle("idle");
      return this.port;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  selectPort(port: ReadOnlySerialPort): void {
    if (this.lifecycle !== "idle" && this.lifecycle !== "error") throw new Error("cannot replace an active port");
    this.port = port;
    this.error = null;
    this.clearDataState();
    this.setLifecycle("idle");
  }

  async connect(): Promise<void> {
    if (!this.port) throw new Error("no serial port selected");
    if (this.lifecycle === "reading" || this.lifecycle === "opening") return;
    this.stopping = false;
    this.error = null;
    this.clearDataState();
    this.setLifecycle("opening");
    try {
      await this.port.open({ baudRate: this.options.baudRate });
      if (!this.port.readable) throw new Error("serial port opened without a readable stream");
      this.reader = this.port.readable.getReader();
      this.setLifecycle("reading");
      this.readTask = this.readLoop(this.reader);
    } catch (error) {
      try { await this.port.close(); } catch { /* best-effort cleanup after a partial open */ }
      this.fail(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closeTask = this.closeInternal().finally(() => { this.closeTask = null; });
    return this.closeTask;
  }

  snapshot(now = this.now()): PortSnapshot {
    return {
      role: this.role,
      lifecycle: this.lifecycle,
      health: this.health(now),
      selected: this.port !== null,
      portInfo: this.port?.getInfo?.() ?? null,
      lastByteAtMs: this.lastByteAtMs,
      lastValidFrameAtMs: this.lastValidFrameAtMs,
      detectedRole: this.detectedRole,
      error: this.error,
      stats: { ...this.stats },
    };
  }

  resetStats(): void {
    this.clearDataState();
    this.emit();
  }

  private async readLoop(reader: SerialReaderLike): Promise<void> {
    const framer = new LineFramer();
    try {
      while (!this.stopping) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const observedAtMs = this.now();
        this.stats.bytesReceived += value.byteLength;
        this.lastByteAtMs = observedAtMs;
        for (const framed of framer.push(value)) this.handleLine(framed.line, framed.warnings, observedAtMs);
        this.emit();
      }
      const observedAtMs = this.now();
      for (const framed of framer.flush()) this.handleLine(framed.line, framed.warnings, observedAtMs);
      if (!this.stopping) this.fail(new Error("serial device disconnected"));
    } catch (error) {
      if (!this.stopping) this.fail(error);
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
      if (this.reader === reader) this.reader = null;
      if (!this.stopping && this.lifecycle === "error" && this.port) {
        try { await this.port.close(); } catch { /* device may already be gone */ }
      }
    }
  }

  private handleLine(line: string, framingWarnings: string[], observedAtMs: number): void {
    if (line.length === 0) return;
    this.stats.linesReceived += 1;
    const detectedRole = detectProtocolRole(line);
    if (detectedRole && detectedRole !== this.role) {
      this.detectedRole = detectedRole;
      this.consecutiveWrongRole += 1;
      this.stats.wrongRoleLines += 1;
    } else if (detectedRole === this.role) {
      this.detectedRole = detectedRole;
      this.consecutiveWrongRole = 0;
    }
    const outcome: ParseOutcome<T> = this.options.adapter.parse(line, observedAtMs);
    if (outcome.kind === "frame") {
      this.stats.validFrames += 1;
      this.lastValidFrameAtMs = observedAtMs;
    } else if (outcome.kind === "error") {
      this.stats.parseErrors += 1;
    } else if (outcome.kind === "ignored") {
      this.stats.ignoredLines += 1;
    }
    this.options.onLine?.({ line, observedAtMs, framingWarnings, outcome });
  }

  private health(now: number): DataHealth {
    if (this.lifecycle !== "reading") return "no-data";
    if (this.consecutiveWrongRole >= this.options.wrongRoleThreshold) return "wrong-role";
    if (this.lastValidFrameAtMs !== null) {
      return now - this.lastValidFrameAtMs > this.options.staleAfterMs ? "stale" : "valid";
    }
    return this.lastByteAtMs === null ? "no-data" : "bytes-only";
  }

  private async closeInternal(): Promise<void> {
    if (!this.port && this.lifecycle === "idle") return;
    this.stopping = true;
    this.setLifecycle("closing");
    const reader = this.reader;
    if (reader) {
      try { await reader.cancel("session closed"); } catch { /* disconnected */ }
    }
    if (this.readTask) await this.readTask.catch(() => undefined);
    this.readTask = null;
    if (this.port) {
      try { await this.port.close(); this.error = null; } catch (error) { this.error = this.describe(error); }
    }
    this.reader = null;
    this.clearDataState();
    this.setLifecycle(this.error ? "error" : "idle");
  }

  private setLifecycle(lifecycle: PortLifecycle): void {
    this.lifecycle = lifecycle;
    this.emit();
  }

  private fail(error: unknown): void {
    this.error = this.describe(error);
    this.lifecycle = "error";
    this.emit();
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }

  private clearDataState(): void {
    this.stats = EMPTY_STATS();
    this.lastByteAtMs = null;
    this.lastValidFrameAtMs = null;
    this.detectedRole = null;
    this.consecutiveWrongRole = 0;
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }
}
