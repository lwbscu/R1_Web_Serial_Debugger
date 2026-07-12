import { describe, expect, it } from "vitest";
import { probePort, probePorts, usbPortLabel, type ProbeCandidate } from "../../src/core/serial/portProbe";
import type { ReadOnlySerialPort, SerialReaderLike } from "../../src/core/serial/types";
import { crc16CcittFalse } from "../../src/protocols/crc16";

const bytes = (text: string) => new TextEncoder().encode(text);
const RDBG = "RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none\n";
const CDBG = `CDBG,${Array.from({ length: 29 }, (_, index) => index).join(",")}\n`;
const LOCATOR = "1,2,3,4,5,6,7,8,9,190,5221,114\n";
const triple = (line: string) => line.repeat(3);

class SequenceReader implements SerialReaderLike {
  released = false;
  cancelled = false;
  constructor(private readonly chunks: Uint8Array[]) {}
  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const value = this.chunks.shift();
    return value ? { done: false, value } : { done: true, value: undefined };
  }
  async cancel(): Promise<void> { this.cancelled = true; }
  releaseLock(): void { this.released = true; }
}

class PendingReader implements SerialReaderLike {
  released = false;
  cancelled = false;
  private resolve: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  async cancel(): Promise<void> { this.cancelled = true; this.resolve?.({ done: true, value: undefined }); }
  releaseLock(): void { this.released = true; }
}

class ChunkThenPendingReader implements SerialReaderLike {
  released = false;
  cancelled = false;
  private first = true;
  private resolve: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
  constructor(private readonly chunk: Uint8Array) {}
  read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (this.first) {
      this.first = false;
      return Promise.resolve({ done: false, value: this.chunk });
    }
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  async cancel(): Promise<void> { this.cancelled = true; this.resolve?.({ done: true, value: undefined }); }
  releaseLock(): void { this.released = true; }
}

function candidate(id: string, reader: SerialReaderLike, info = { usbVendorId: 0x0483, usbProductId: 0x5740 }) {
  let opens = 0; let closes = 0;
  const port: ReadOnlySerialPort = {
    readable: { getReader: () => reader },
    async open() { opens += 1; },
    async close() { closes += 1; },
    getInfo: () => info,
  };
  return {
    value: { id, label: `端口 ${id}`, port } satisfies ProbeCandidate,
    counts: () => ({ opens, closes }),
  };
}

describe("只读多端口协议探测", () => {
  it.each([
    ["remote", RDBG],
    ["chassis", CDBG],
    ["locator", LOCATOR],
  ] as const)("通过 adapter 将有效帧识别为 %s", async (role, line) => {
    const reader = new SequenceReader([bytes(`启动噪声\0\n${triple(line)}`)]);
    const port = candidate(role, reader);
    const result = await probePort(port.value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "confident", role, reason: "classified", usbLabel: "VID 0483 · PID 5740" });
    expect(result.evidence.some((item) => item.role === role && item.outcome === "frame")).toBe(true);
    expect(result.validFrameCounts[role]).toBe(3);
    expect(Object.values(result.protocolEvidence[role])).toContain(3);
    expect(port.counts()).toEqual({ opens: 1, closes: 1 });
    expect(reader.released).toBe(true);
  });

  it("噪声和坏帧保持 unknown，并保留拒绝证据", async () => {
    const reader = new SequenceReader([bytes("boot noise\nRDBG,1,broken\nrandom text\n")]);
    const result = await probePort(candidate("noise", reader).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", role: "remote", reason: "insufficient_evidence" });
    expect(result.evidence).toMatchObject([{ role: "remote", outcome: "error", score: 1, protocolVersion: "prefix-only" }]);
    expect(result.inspectedLines).toBe(3);
  });

  it.each([
    ["remote", "RDBG,1,broken\n", 1, "prefix-only"],
    ["chassis", "CDBG,1,broken\n", 1, "prefix-only"],
    ["locator", "$R1M,1,broken\n", 1, "prefix-only"],
  ] as const)("保留带 %s 协议前缀的坏帧错误", async (role, line, score, protocolVersion) => {
    const result = await probePort(candidate(`bad-${role}`, new SequenceReader([bytes(line)])).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", role: score > 0 || role === "locator" ? role : null, reason: "insufficient_evidence" });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ role, outcome: "error", score, protocolVersion });
    expect(result.evidence[0]?.detail).toBeTruthy();
  });

  it.each([
    ["remote", "RDBG,1,broken\n"],
    ["chassis", "CDBG,1,broken\n"],
  ] as const)("连续 %s prefix-only 坏帧也可自动绑定，但不计入有效帧", async (role, line) => {
    const result = await probePort(candidate(`prefix-${role}`, new SequenceReader([bytes(triple(line))])).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "confident", role, reason: "classified" });
    expect(result.validFrameCounts[role]).toBe(0);
    expect(result.protocolEvidence[role]).toEqual({ "prefix-only": 3 });
  });

  it("同一端口出现多个有效角色时返回 ambiguous", async () => {
    const reader = new SequenceReader([bytes(triple(RDBG) + triple(CDBG))]);
    const result = await probePort(candidate("mixed", reader).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "ambiguous", reason: "mixed_roles" });
    expect(result.scores.remote).toBeGreaterThanOrEqual(3);
    expect(result.scores.chassis).toBeGreaterThanOrEqual(3);
  });

  it("单个大 chunk 也严格限制检查行数", async () => {
    const reader = new SequenceReader([bytes(["noise-1", "noise-2", RDBG.trim(), RDBG.trim(), RDBG.trim(), CDBG.trim()].join("\n") + "\n")]);
    const result = await probePort(candidate("bounded", reader).value, { timeoutMs: 100, maxLines: 5 });
    expect(result.inspectedLines).toBe(5);
    expect(result).toMatchObject({ confidence: "confident", role: "remote" });
    expect(result.scores.chassis).toBe(0);
  });

  it("达到强证据后只等待短暂收口窗口，而不是耗尽完整探测时限", async () => {
    const reader = new ChunkThenPendingReader(bytes(triple(RDBG)));
    const port = candidate("settle", reader);
    const startedAt = performance.now();
    const result = await probePort(port.value, { timeoutMs: 1000, settleMs: 5 });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(result).toMatchObject({ confidence: "confident", role: "remote", reason: "classified" });
    expect(reader).toMatchObject({ cancelled: true, released: true });
    expect(port.counts().closes).toBe(1);
  });

  it("批量探测并发打开端口，并将重复角色降级为 ambiguous", async () => {
    let releaseReads!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReads = resolve; });
    let opened = 0;
    const make = (id: string): ProbeCandidate => {
      const reader = new SequenceReader([bytes(triple(RDBG))]);
      return { id, port: { readable: { getReader: () => ({ ...reader, read: async () => { await gate; return reader.read(); }, cancel: () => reader.cancel(), releaseLock: () => reader.releaseLock() }) }, async open() { opened += 1; }, async close() {} } };
    };
    const pending = probePorts([make("a"), make("b")], { timeoutMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(2);
    releaseReads();
    const results = await pending;
    expect(results.map((item) => [item.confidence, item.role, item.reason])).toEqual([
      ["ambiguous", "remote", "duplicate_role"],
      ["ambiguous", "remote", "duplicate_role"],
    ]);
  });

  it("超时和取消都取消 reader、释放锁并关闭端口", async () => {
    const timeoutReader = new PendingReader();
    const timed = candidate("timeout", timeoutReader);
    const timeoutResult = await probePort(timed.value, { timeoutMs: 5 });
    expect(timeoutResult).toMatchObject({ confidence: "unknown", reason: "timeout" });
    expect(timeoutReader).toMatchObject({ cancelled: true, released: true });
    expect(timed.counts().closes).toBe(1);

    const abortReader = new PendingReader();
    const aborted = candidate("abort", abortReader);
    const controller = new AbortController();
    const pending = probePort(aborted.value, { timeoutMs: 1000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort();
    const abortResult = await pending;
    expect(abortResult).toMatchObject({ confidence: "unknown", role: null, reason: "cancelled" });
    expect(abortReader).toMatchObject({ cancelled: true, released: true });
    expect(aborted.counts().closes).toBe(1);
  });

  it("打开失败时不关闭并非本次探测拥有的端口", async () => {
    let closed = 0;
    const port: ReadOnlySerialPort = {
      readable: null,
      async open() { throw new Error("busy"); },
      async close() { closed += 1; },
    };
    const result = await probePort({ id: "busy", port }, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", reason: "open_error", error: "busy" });
    expect(closed).toBe(0);
  });

  it("reader 同步抛错也会释放锁、关闭端口并返回 read_error", async () => {
    let cancelled = false;
    let released = false;
    const reader: SerialReaderLike = {
      read() { throw new Error("read exploded"); },
      async cancel() { cancelled = true; },
      releaseLock() { released = true; },
    };
    const port = candidate("read-error", reader);
    const result = await probePort(port.value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", reason: "read_error", error: "read exploded" });
    expect({ cancelled, released, closes: port.counts().closes }).toEqual({ cancelled: true, released: true, closes: 1 });
  });

  it("缺失 USB 信息时生成明确占位标签", () => {
    expect(usbPortLabel({})).toBe("VID ???? · PID ????");
  });

  it("单个有效帧不足以 confident", async () => {
    const result = await probePort(candidate("single", new SequenceReader([bytes(RDBG)])).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", role: "remote", reason: "insufficient_evidence" });
    expect(result.validFrameCounts.remote).toBe(1);
    expect(result.protocolEvidence.remote).toEqual({ "rdbg-v1": 1 });
  });

  it("同角色但协议布局不一致时不能用总帧数凑够门槛", async () => {
    const legacy5 = "1,2,3,4,5\n";
    const legacy6 = "1,2,3,4,5,6\n";
    const result = await probePort(
      candidate("mixed-layout", new SequenceReader([bytes(legacy5.repeat(2) + legacy6)])).value,
      { timeoutMs: 100 },
    );
    expect(result).toMatchObject({ confidence: "unknown", role: "locator", reason: "insufficient_evidence" });
    expect(result.validFrameCounts.locator).toBe(0);
    expect(result.protocolEvidence.locator).toEqual({});
  });

  it("事件只能形成弱证据，不能单独 confident", async () => {
    const events = "RDBG_CFG,RF_CH,76\nRDBG_CMD,noop\nRDBG_CFG,READY,1\n";
    const result = await probePort(candidate("events", new SequenceReader([bytes(events)])).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", role: "remote", reason: "insufficient_evidence" });
    expect(result.scores.remote).toBe(3);
    expect(result.validFrameCounts.remote).toBe(0);
  });

  it.each([
    ["legacy trailing", "1,2,3,4,5,6,7,8,9,10\n", "legacy-csv-9"],
    ["v2 trailing", `${Array.from({ length: 42 }, (_, index) => index).join(",")}\n`, "r1-csv-v2-diag"],
  ])("宽松兼容解析的 locator %s 不足以自动确认设备身份", async (_name, line, protocol) => {
    const result = await probePort(candidate("locator-tail", new SequenceReader([bytes(triple(line))])).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "unknown", role: "locator" });
    expect(result.validFrameCounts.locator).toBe(0);
    expect(result.protocolEvidence.locator).toEqual({});
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ protocolVersion: protocol, score: 1, detail: expect.stringContaining("手动连接") })]));
  });

  it.each([25, 41])("精确 %i 字段的定位 CSV 可作为强身份依据", async (fieldCount) => {
    const line = `${Array.from({ length: fieldCount }, (_, index) => index).join(",")}\n`;
    const result = await probePort(candidate(`locator-${fieldCount}`, new SequenceReader([bytes(triple(line))])).value, { timeoutMs: 100 });
    expect(result).toMatchObject({ confidence: "confident", role: "locator" });
    expect(result.validFrameCounts.locator).toBe(3);
  });

  it("R1M 必须带正确 CRC 才能成为强身份依据", async () => {
    const fields = ["R1M", "1", "100", "7", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "190", "5222", "114"];
    const body = `${fields.join(",")},`;
    const crc = crc16CcittFalse(body).toString(16).toUpperCase().padStart(4, "0");
    const valid = `$${body}*${crc}\n`;
    const strong = await probePort(candidate("r1m-crc", new SequenceReader([bytes(triple(valid))])).value, { timeoutMs: 100 });
    expect(strong).toMatchObject({ confidence: "confident", role: "locator" });

    const weak = await probePort(candidate("r1m-no-crc", new SequenceReader([bytes(triple(`$${body}\n`))])).value, { timeoutMs: 100 });
    expect(weak).toMatchObject({ confidence: "unknown", role: "locator" });
    expect(weak.validFrameCounts.locator).toBe(0);
  });

  it("慢速 open 超时后不阻塞 UI，并在晚到成功时关闭端口", async () => {
    let resolveOpen!: () => void;
    let closes = 0;
    const opening = new Promise<void>((resolve) => { resolveOpen = resolve; });
    const port: ReadOnlySerialPort = {
      readable: null,
      open: () => opening,
      async close() { closes += 1; },
    };
    const result = await probePort({ id: "slow-open", port }, { timeoutMs: 5 });
    expect(result).toMatchObject({ confidence: "unknown", reason: "timeout" });
    expect(closes).toBe(0);
    resolveOpen();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closes).toBe(1);
  });
});
