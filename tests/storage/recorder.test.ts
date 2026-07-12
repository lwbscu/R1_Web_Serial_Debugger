import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  MemoryFileStore,
  SessionRecorder,
  crc32,
  deleteSession,
  encodeCsvRow,
  exportSession,
  exportSessionVolumes,
  listRecoverableSessions,
  quickExportPaths,
} from "../../src/core/storage";
import { contextForSide } from "../../src/core/locator";

const decoder = new TextDecoder();

async function volumeBytes(volume: { bytes: Uint8Array | Blob }): Promise<Uint8Array> {
  if (volume.bytes instanceof Blob) return new Uint8Array(await volume.bytes.arrayBuffer());
  return volume.bytes;
}

function manifest(kind: "communication" | "locator" | "global" = "communication") {
  return {
    schemaVersion: 1 as const,
    sessionId: `${kind}-test`,
    kind,
    startedAt: "2026-07-10T12:00:00.000Z",
  };
}

class CountingStore extends MemoryFileStore {
  checkpointWrites = 0;

  override async write(path: string, data: string | Uint8Array): Promise<void> {
    if (/checkpoint(?:\.recovery)?\.json$/.test(path)) this.checkpointWrites += 1;
    await super.write(path, data);
  }
}

class ReadCountingStore extends MemoryFileStore {
  segmentReads = 0;

  override async read(path: string): Promise<Uint8Array> {
    if (path.includes("/segments/")) this.segmentReads += 1;
    return super.read(path);
  }
}

describe("SessionRecorder", () => {
  it("rolls atomically by byte and time policy and can resume an active session", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest(), {
      rollingPolicy: { maxSegmentBytes: 8, maxSegmentDurationMs: 30_000 },
    });
    await recorder.append("remote_raw.log", "1234\n", Date.parse(manifest().startedAt));
    await recorder.append("chassis_raw.log", "5678\n", Date.parse(manifest().startedAt) + 1);

    expect(recorder.snapshot.segments).toHaveLength(2);
    expect(recorder.snapshot.segments[0]?.sizeBytes).toBe(5);
    expect(recorder.snapshot.segments[1]?.sizeBytes).toBe(5);

    const resumed = await SessionRecorder.resume(store, manifest().sessionId);
    await resumed.append("remote_raw.log", "9\n", Date.parse(manifest().startedAt) + 2);
    expect(resumed.snapshot.segments[1]?.sizeBytes).toBe(7);
  });

  it("rejects artifacts from the other workspace and appends are serialized", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest("locator"));
    await expect(recorder.append("remote_raw.log", "bad")).rejects.toThrow(/does not belong/);

    await Promise.all([
      recorder.append("raw_serial.log", "first\n", 1),
      recorder.append("raw_serial.log", "second\n", 2),
    ]);
    const path = recorder.snapshot.segments[0]?.artifacts["raw_serial.log"]?.path;
    expect(path).toBeDefined();
    expect(decoder.decode(await store.read(path!))).toBe("first\nsecond\n");
  });

  it("appends a batch with one checkpoint pair while preserving artifact order", async () => {
    const store = new CountingStore();
    const recorder = await SessionRecorder.create(store, manifest(), {
      rollingPolicy: { maxSegmentBytes: 128, maxSegmentDurationMs: 30_000 },
    });
    store.checkpointWrites = 0;

    await recorder.appendBatch([
      { artifact: "remote_raw.log", data: "R1\n", observedAtMs: 1 },
      { artifact: "remote_raw.log", data: "R2\n", observedAtMs: 2 },
      { artifact: "chassis_raw.log", data: "C1\n", observedAtMs: 3 },
    ]);

    expect(store.checkpointWrites).toBe(2);
    const remotePath = recorder.snapshot.segments[0]?.artifacts["remote_raw.log"]?.path;
    const chassisPath = recorder.snapshot.segments[0]?.artifacts["chassis_raw.log"]?.path;
    expect(decoder.decode(await store.read(remotePath!))).toBe("R1\nR2\n");
    expect(decoder.decode(await store.read(chassisPath!))).toBe("C1\n");
  });

  it("rejects locator coordinate metadata on communication sessions", async () => {
    const store = new MemoryFileStore();
    await expect(SessionRecorder.create(store, {
      ...manifest(),
      locatorCoordinates: contextForSide("red", "official"),
    })).rejects.toThrow(/locator\/global session/);
  });

  it("splits a single oversized append across bounded segments", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest(), {
      rollingPolicy: { maxSegmentBytes: 4, maxSegmentDurationMs: 30_000 },
    });
    await recorder.append("remote_raw.log", "abcdefghij", 1);
    expect(recorder.snapshot.segments.map((segment) => segment.sizeBytes)).toEqual([4, 4, 2]);
  });

  it("lists crashed/stopped sessions and supports explicit cleanup", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest());
    await recorder.append("remote_raw.log", "RDBG\n");
    await recorder.stop();

    const sessions = await listRecoverableSessions(store);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.checkpoint.status).toBe("stopped");
    await deleteSession(store, manifest().sessionId);
    expect(await listRecoverableSessions(store)).toEqual([]);
  });
});

describe("session export", () => {
  it("creates consecutive volumes with canonical Python filenames", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest(), {
      rollingPolicy: { maxSegmentBytes: 5, maxSegmentDurationMs: 30_000 },
    });
    await recorder.append("remote_raw.log", "RDBG-A\n", 1);
    await recorder.append("chassis_raw.log", "CDBG-B\n", 2);
    await recorder.stop(3);

    const volumes = await exportSession(store, manifest().sessionId, {
      maxVolumeBytes: 8,
      compressionLevel: 0,
    });
    expect(volumes).toHaveLength(2);
    expect(volumes.map((volume) => volume.filename)).toEqual([
      "communication-test_part001_of_002.zip",
      "communication-test_part002_of_002.zip",
    ]);
    const first = unzipSync(await volumeBytes(volumes[0]!));
    expect(Object.keys(first).sort()).toEqual([
      "README_Codex.md",
      "chassis_cdbg.csv",
      "chassis_cevt.csv",
      "chassis_raw.log",
      "events.csv",
      "remote_raw.log",
      "remote_rdbg.csv",
      "remote_rdbg_tx.csv",
      "session.json",
    ]);
    expect(decoder.decode(first["remote_raw.log"]!)).toBe("RDBG-A\n");
    expect(JSON.parse(decoder.decode(first["session.json"]!)).export.volumeCount).toBe(2);
    expect(decoder.decode(first["README_Codex.md"]!)).toContain("remote_raw.log");
  });

  it("neutralizes formulas and quotes CSV fields", () => {
    expect(encodeCsvRow(["=cmd()", "a,b", 'a"b'])).toBe("'=cmd(),\"a,b\",\"a\"\"b\"\r\n");
  });

  it("computes CRC32 for prepared ZIP entries", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("yields export volumes one at a time", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest(), {
      rollingPolicy: { maxSegmentBytes: 4, maxSegmentDurationMs: 30_000 },
    });
    await recorder.append("remote_raw.log", "abcdefgh", 1);
    await recorder.stop(2);
    const names: string[] = [];
    for await (const volume of exportSessionVolumes(store, manifest().sessionId, {
      maxVolumeBytes: 4,
      compressionLevel: 0,
    })) names.push(volume.filename);
    expect(names).toEqual([
      "communication-test_part001_of_002.zip",
      "communication-test_part002_of_002.zip",
    ]);
  });

  it("reports byte and volume progress while exporting volumes", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest(), {
      rollingPolicy: { maxSegmentBytes: 4, maxSegmentDurationMs: 30_000 },
    });
    await recorder.append("remote_raw.log", "abcdefgh", 1);
    await recorder.stop(2);

    const progress: string[] = [];
    for await (const volume of exportSessionVolumes(store, manifest().sessionId, {
      maxVolumeBytes: 4,
      compressionLevel: 0,
      onProgress: (item) => {
        progress.push(`${item.phase}:${item.volumeIndex}/${item.volumeTotal}:${Math.round(item.percent)}:${item.bytesRead}/${item.totalBytes}:${item.filename ?? ""}`);
      },
    })) {
      expect(volume.total).toBe(2);
    }

    expect(progress[0]).toBe("reading:1/2:0:0/8:");
    expect(progress).toContain("reading:1/2:50:4/8:");
    expect(progress).toContain("compressing:1/2:50:4/8:");
    expect(progress).toContain("ready:1/2:50:4/8:communication-test_part001_of_002.zip");
    expect(progress).toContain("reading:2/2:100:8/8:");
    expect(progress).toContain("ready:2/2:100:8/8:communication-test_part002_of_002.zip");
    expect(progress.at(-1)).toBe("done:2/2:100:8/8:");
  });

  it("reports progress through exportSession and handles empty sessions", async () => {
    const store = new MemoryFileStore();
    const recorder = await SessionRecorder.create(store, manifest());
    await recorder.stop(2);

    const progress: string[] = [];
    const volumes = await exportSession(store, manifest().sessionId, {
      compressionLevel: 0,
      onProgress: (item) => {
        progress.push(`${item.phase}:${Math.round(item.percent)}:${item.bytesRead}/${item.totalBytes}`);
      },
    });

    expect(volumes).toHaveLength(1);
    expect(progress).toEqual([
      "reading:0:0/0",
      "compressing:100:0/0",
      "ready:100:0/0",
      "done:100:0/0",
    ]);
    const entries = unzipSync(await volumeBytes(volumes[0]!));
    expect(JSON.parse(decoder.decode(entries["session.json"]!)).sessionId).toBe("communication-test");
  });

  it("preserves locator coordinate context in exported metadata", async () => {
    const store = new MemoryFileStore();
    const locatorManifest = {
      ...manifest("locator"),
      locatorCoordinates: contextForSide("red", "preliminary"),
    };
    const recorder = await SessionRecorder.create(store, locatorManifest);
    await recorder.append("display_frames.csv", "x,y,yaw\n0,0,0\n", 1);
    await recorder.stop(2);
    const [volume] = await exportSession(store, locatorManifest.sessionId);
    const entries = unzipSync(await volumeBytes(volume!));
    const metadata = JSON.parse(decoder.decode(entries["metadata.json"]!));
    expect(metadata.locatorCoordinates).toEqual(locatorManifest.locatorCoordinates);
  });

  it("exports a global three-port session with locator metadata and connection status", async () => {
    const store = new MemoryFileStore();
    const globalManifest = {
      ...manifest("global"),
      locatorCoordinates: contextForSide("blue", "preliminary"),
    };
    const recorder = await SessionRecorder.create(store, globalManifest);
    await recorder.append("remote_raw.log", "100,RDBG,...\n", 1);
    await recorder.append("remote_rdbg_tx.csv", "100,RDBG_TX,...\n", 1);
    await recorder.append("chassis_cdbg.csv", "105,CDBG,3,151,...\n", 2);
    await recorder.append("chassis_cevt.csv", "106,CEVT,MECH_FB,100,1,2,1,1,1,5,5\n", 2);
    await recorder.append("locator_raw.log", "[0.1] $R1M,...\n", 3);
    await recorder.append("locator_frames.csv", "110,$R1M,...\n", 3);
    await recorder.append("locator_display_frames.csv", "110,0,1,0,0,0\n", 3);
    await recorder.append("connection_status.csv", encodeCsvRow([1, "remote", "connected"]));
    await recorder.append("connection_status.csv", encodeCsvRow([1, "chassis", "not_connected"]));
    await recorder.stop(4);

    const [volume] = await exportSession(store, globalManifest.sessionId, { compressionLevel: 0 });
    const entries = unzipSync(await volumeBytes(volume!));
    expect(Object.keys(entries).sort()).toEqual([
      "README_Codex.md",
      "chassis_cdbg.csv",
      "chassis_cevt.csv",
      "chassis_raw.log",
      "connection_status.csv",
      "events.csv",
      "locator_display_frames.csv",
      "locator_frames.csv",
      "locator_raw.log",
      "raw_serial.log",
      "remote_raw.log",
      "remote_rdbg.csv",
      "remote_rdbg_tx.csv",
      "session.json",
    ]);
    const metadata = JSON.parse(decoder.decode(entries["session.json"]!));
    expect(metadata.kind).toBe("global");
    expect(metadata.locatorCoordinates).toEqual(globalManifest.locatorCoordinates);
    expect(decoder.decode(entries["connection_status.csv"]!)).toContain("not_connected");
  });

  it("exports quick serial packages without derived CSV artifacts", async () => {
    const store = new ReadCountingStore();
    const quickManifest = {
      ...manifest("global"),
      recordingProfile: "quickSerial" as const,
    };
    const recorder = await SessionRecorder.create(store, quickManifest);
    await recorder.append("remote_raw.log", "100,RDBG,...\n", 1);
    await recorder.append("remote_rdbg_tx.csv", "100,RDBG_TX,...\n", 1);
    await recorder.append("chassis_raw.log", "101,CDBG,...\n", 2);
    await recorder.append("chassis_cevt.csv", "101,CEVT,...\n", 2);
    await recorder.append("locator_raw.log", "[0.1] $R1M,...\n", 3);
    await recorder.append("locator_frames.csv", "110,$R1M,...\n", 3);
    await recorder.append("connection_status.csv", encodeCsvRow([1, "remote", "connected"]));
    await recorder.stop(4);

    store.segmentReads = 0;
    const [volume] = await exportSession(store, quickManifest.sessionId, { compressionLevel: 0 });
    expect(store.segmentReads).toBe(0);
    expect(volume?.bytes).toBeInstanceOf(Blob);
    const entries = unzipSync(await volumeBytes(volume!));
    expect(Object.keys(entries).sort()).toEqual([
      "README_Codex.md",
      "chassis_raw.log",
      "connection_status.csv",
      "locator_raw.log",
      "raw_serial.log",
      "remote_raw.log",
      "session.json",
    ]);
    expect(decoder.decode(entries["README_Codex.md"]!)).toContain("快速串口包只保存原始串口数据");
    expect(JSON.parse(decoder.decode(entries["session.json"]!)).export.quickExport).toBe("quick-zip-v1");
  });

  it("coalesces adjacent quick ZIP manifest chunks for long-running recordings", async () => {
    const store = new ReadCountingStore();
    const quickManifest = {
      ...manifest("global"),
      recordingProfile: "quickSerial" as const,
    };
    const recorder = await SessionRecorder.create(store, quickManifest);
    await recorder.append("remote_raw.log", "RDBG-1\n", 1);
    await recorder.append("remote_raw.log", "RDBG-2\n", 2);
    await recorder.append("remote_raw.log", "RDBG-3\n", 3);

    const parsed = JSON.parse(decoder.decode(await store.read(quickExportPaths.quickExportPath(quickManifest.sessionId)))) as {
      entries: Array<{ name: string; sizeBytes: number; chunks: Array<{ path: string; offset: number; length: number }> }>;
    };
    const remote = parsed.entries.find((entry) => entry.name === "remote_raw.log");
    expect(remote?.sizeBytes).toBe("RDBG-1\nRDBG-2\nRDBG-3\n".length);
    expect(remote?.chunks).toEqual([{
      path: "sessions/global-test/segments/000000/remote_raw.log",
      offset: 0,
      length: "RDBG-1\nRDBG-2\nRDBG-3\n".length,
    }]);

    await recorder.stop(4);
    store.segmentReads = 0;
    const [volume] = await exportSession(store, quickManifest.sessionId, { compressionLevel: 0 });
    expect(store.segmentReads).toBe(0);
    const entries = unzipSync(await volumeBytes(volume!));
    expect(decoder.decode(entries["remote_raw.log"]!)).toBe("RDBG-1\nRDBG-2\nRDBG-3\n");
  });

  it("falls back to legacy export when a quick ZIP manifest is missing", async () => {
    const store = new ReadCountingStore();
    const quickManifest = {
      ...manifest("global"),
      recordingProfile: "quickSerial" as const,
    };
    const recorder = await SessionRecorder.create(store, quickManifest);
    await recorder.append("remote_raw.log", "100,RDBG,...\n", 1);
    await recorder.append("chassis_raw.log", "101,CDBG,...\n", 2);
    await recorder.append("locator_raw.log", "[0.1] $R1M,...\n", 3);
    await recorder.stop(4);
    await store.remove(quickExportPaths.quickExportPath(quickManifest.sessionId));

    store.segmentReads = 0;
    const [volume] = await exportSession(store, quickManifest.sessionId, { compressionLevel: 0 });
    expect(store.segmentReads).toBeGreaterThan(0);
    const entries = unzipSync(await volumeBytes(volume!));
    expect(decoder.decode(entries["remote_raw.log"]!)).toContain("RDBG");
  });
});
