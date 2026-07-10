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

describe("PortSession", () => {
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
    expect(session.snapshot().health).toBe("valid");
    await Promise.all([session.close(), session.close()]);
    expect(closed).toBe(true);
    expect(reader.wasReleased).toBe(true);
  });
});
