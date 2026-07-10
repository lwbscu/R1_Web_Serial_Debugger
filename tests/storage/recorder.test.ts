import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  MemoryFileStore,
  SessionRecorder,
  deleteSession,
  encodeCsvRow,
  exportSession,
  exportSessionVolumes,
  listRecoverableSessions,
} from "../../src/core/storage";

const decoder = new TextDecoder();

function manifest(kind: "communication" | "locator" = "communication") {
  return {
    schemaVersion: 1 as const,
    sessionId: `${kind}-test`,
    kind,
    startedAt: "2026-07-10T12:00:00.000Z",
  };
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
    const first = unzipSync(volumes[0]!.bytes);
    expect(Object.keys(first).sort()).toEqual([
      "chassis_cdbg.csv",
      "chassis_raw.log",
      "events.csv",
      "remote_raw.log",
      "remote_rdbg.csv",
      "session.json",
    ]);
    expect(decoder.decode(first["remote_raw.log"]!)).toBe("RDBG-A\n");
    expect(JSON.parse(decoder.decode(first["session.json"]!)).export.volumeCount).toBe(2);
  });

  it("neutralizes formulas and quotes CSV fields", () => {
    expect(encodeCsvRow(["=cmd()", "a,b", 'a"b'])).toBe("'=cmd(),\"a,b\",\"a\"\"b\"\r\n");
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
});
