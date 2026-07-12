import { describe, expect, it } from "vitest";

import { LineFramer } from "../../src/core/serial/lineFramer";
import { PortSession } from "../../src/core/serial/portSession";
import type { ReadOnlySerialPort, SerialReaderLike } from "../../src/core/serial/types";
import type { RemoteFrame } from "../../src/protocols/models";
import { RemoteProtocolAdapter } from "../../src/protocols/rdbg";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("LineFramer", () => {
  it("handles split CRLF and adjacent marker frames", () => {
    const framer = new LineFramer();
    expect(framer.push(bytes("noiseRDBG,1,1,T,76,0,1,0,1,4,1,1,0,0,0,1,1,none"))).toEqual([]);
    const lines = framer.push(bytes("CDBG,1,2,3\r\nRDBG_CFG,RF_CH,76\n"));
    expect(lines.map((item) => item.line)).toEqual([
      "RDBG,1,1,T,76,0,1,0,1,4,1,1,0,0,0,1,1,none",
      "CDBG,1,2,3",
      "RDBG_CFG,RF_CH,76",
    ]);
    expect(lines[0]?.warnings).toContain("discarded_prefix");
  });

  it("bounds an unterminated buffer", () => {
    const framer = new LineFramer({ maxBufferBytes: 8 });
    framer.push(bytes("0123456789"));
    const [tail] = framer.flush();
    expect(tail?.line).toBe("23456789");
    expect(tail?.warnings).toContain("buffer_overflow");
  });
});

class ControlledReader implements SerialReaderLike {
  private released = false;
  private pendingResolve: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  private first = true;

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.first) {
      this.first = false;
      return { done: false, value: bytes("RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none\n") };
    }
    return new Promise((resolve) => { this.pendingResolve = resolve; });
  }

  async cancel(): Promise<void> {
    this.pendingResolve?.({ done: true, value: undefined });
  }

  releaseLock(): void {
    this.released = true;
  }

  get wasReleased(): boolean {
    return this.released;
  }
}

class OneChunkReader implements SerialReaderLike {
  private released = false;
  private sent = false;
  private pendingResolve: ((result: ReadableStreamReadResult<Uint8Array>) => void) | null = null;

  constructor(private readonly chunk: string) {}

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!this.sent) {
      this.sent = true;
      return { done: false, value: bytes(this.chunk) };
    }
    return new Promise((resolve) => { this.pendingResolve = resolve; });
  }

  async cancel(): Promise<void> {
    this.pendingResolve?.({ done: true, value: undefined });
  }

  releaseLock(): void {
    this.released = true;
  }

  get wasReleased(): boolean {
    return this.released;
  }
}

describe("PortSession", () => {
  it("can release a failed or idle selection before another role retries it", () => {
    const port: ReadOnlySerialPort = { readable: null, async open() {}, async close() {} };
    const session = new PortSession<RemoteFrame>({
      role: "remote", provider: { requestPort: async () => port }, adapter: new RemoteProtocolAdapter(),
    });
    session.selectPort(port);
    expect(session.snapshot().selected).toBe(true);
    session.clearPort();
    expect(session.snapshot()).toMatchObject({ lifecycle: "idle", selected: false, health: "no-data", transportStatus: "not-selected", protocolStatus: "unknown", error: null });
  });

  it("reads without exposing a writable interface and closes idempotently", async () => {
    const reader = new ControlledReader();
    let opened = false;
    let closed = false;
    const port: ReadOnlySerialPort = {
      readable: { getReader: () => reader },
      async open() { opened = true; },
      async close() { closed = true; },
    };
    const lines: string[] = [];
    const session = new PortSession<RemoteFrame>({
      role: "remote",
      provider: { requestPort: async () => port },
      adapter: new RemoteProtocolAdapter(),
      now: () => 1000,
      onLine: (received) => lines.push(received.line),
    });
    await session.requestPort();
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(true);
    expect(lines).toHaveLength(1);
    expect(session.snapshot()).toMatchObject({ health: "valid", transportStatus: "receiving", protocolStatus: "valid" });
    await Promise.all([session.close(), session.close()]);
    expect(closed).toBe(true);
    expect(reader.wasReleased).toBe(true);
    expect(session.snapshot()).toMatchObject({ lifecycle: "idle", health: "no-data", error: null });
    expect(session.snapshot().stats.validFrames).toBe(0);
  });

  it("keeps transport receiving when bytes arrive but protocol parsing mismatches", async () => {
    const reader = new OneChunkReader("RDBG,100,broken\n");
    const port: ReadOnlySerialPort = {
      readable: { getReader: () => reader },
      async open() {},
      async close() {},
    };
    const session = new PortSession<RemoteFrame>({
      role: "remote",
      provider: { requestPort: async () => port },
      adapter: new RemoteProtocolAdapter(),
      now: () => 1000,
    });
    await session.requestPort();
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot()).toMatchObject({
      lifecycle: "reading",
      health: "format-mismatch",
      transportStatus: "receiving",
      protocolStatus: "mismatch",
      stats: { bytesReceived: "RDBG,100,broken\n".length, validFrames: 0, parseErrors: 1 },
    });
    await session.close();
    expect(reader.wasReleased).toBe(true);
  });

  it("reports a new malformed line after a valid frame without dropping the serial transport", async () => {
    const chunk = [
      "RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none",
      "RDBG,101,broken",
      "",
    ].join("\n");
    const reader = new OneChunkReader(chunk);
    const port: ReadOnlySerialPort = {
      readable: { getReader: () => reader },
      async open() {},
      async close() {},
    };
    const session = new PortSession<RemoteFrame>({
      role: "remote",
      provider: { requestPort: async () => port },
      adapter: new RemoteProtocolAdapter(),
      now: () => 1000,
    });
    session.selectPort(port);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot()).toMatchObject({
      lifecycle: "reading",
      health: "format-mismatch",
      transportStatus: "receiving",
      protocolStatus: "mismatch",
      lastProtocolLineAtMs: 1000,
      lastProtocolErrorAtMs: 1000,
      stats: { validFrames: 1, parseErrors: 1 },
    });
    expect(session.snapshot().lastProtocolError).toContain("RDBG");
    await session.close();
  });

  it("delivers the raw line before a throwing parser and still records a mismatch", async () => {
    const order: string[] = [];
    const reader = new OneChunkReader("FUTURE,9,unknown\n");
    const port: ReadOnlySerialPort = { readable: { getReader: () => reader }, async open() {}, async close() {} };
    const session = new PortSession<RemoteFrame>({
      role: "remote",
      provider: { requestPort: async () => port },
      adapter: { parse: () => { order.push("parse"); throw new Error("future schema"); } },
      onRawLine: ({ line }) => { order.push(`raw:${line}`); },
      now: () => 1000,
    });
    session.selectPort(port);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["raw:FUTURE,9,unknown", "parse"]);
    expect(session.snapshot()).toMatchObject({ transportStatus: "receiving", protocolStatus: "mismatch", health: "format-mismatch" });
    expect(session.snapshot().lastProtocolError).toContain("parser_exception");
    await session.close();
  });

  it("clears an open error and prior session state after a successful retry", async () => {
    const reader = new ControlledReader();
    let attempts = 0;
    let closes = 0;
    const port: ReadOnlySerialPort = {
      readable: { getReader: () => reader },
      async open() { attempts += 1; if (attempts === 1) throw new Error("busy"); },
      async close() { closes += 1; },
    };
    const session = new PortSession<RemoteFrame>({
      role: "remote", provider: { requestPort: async () => port }, adapter: new RemoteProtocolAdapter(), now: () => 1000,
    });
    await session.requestPort();
    await expect(session.connect()).rejects.toThrow("busy");
    expect(session.snapshot()).toMatchObject({ lifecycle: "error", health: "no-data", error: "busy" });
    expect(closes).toBe(0);
    await session.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.snapshot()).toMatchObject({ lifecycle: "reading", health: "valid", error: null });
    await session.close();
    expect(closes).toBe(1);
  });

  it("times out a hanging open and closes it if success arrives late", async () => {
    let resolveOpen!: () => void;
    let closes = 0;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    const port: ReadOnlySerialPort = {
      readable: null,
      open: () => opening,
      async close() { closes += 1; },
    };
    const session = new PortSession<RemoteFrame>({
      role: "remote", provider: { requestPort: async () => port }, adapter: new RemoteProtocolAdapter(), openTimeoutMs: 5,
    });
    session.selectPort(port);
    await expect(session.connect()).rejects.toThrow("open timeout");
    expect(session.snapshot()).toMatchObject({ lifecycle: "error", health: "no-data" });
    expect(closes).toBe(0);
    resolveOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toBe(1);
  });
});
