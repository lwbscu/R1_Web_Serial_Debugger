import { zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ReplayClock,
  loadReplayZip,
  parseReplayText,
  type ReplayTimerDriver,
} from "../../src/core/replay";
import { contextForSide } from "../../src/core/locator";
import { ChassisProtocolAdapter } from "../../src/protocols";

describe("parseReplayText", () => {
  it("replays the frozen CDBG v3/151 line through the chassis adapter", () => {
    const fixture = readFileSync(new URL("../fixtures/frozen/chassis_cdbg_v3.log", import.meta.url), "utf8");
    const records = parseReplayText(fixture, { format: "raw" });
    const outcome = new ChassisProtocolAdapter().parse(records[0]!.payload, 1234);
    expect(outcome).toMatchObject({
      kind: "frame",
      protocolVersion: "cdbg-v3",
      frame: { fieldCount: 151, resetFlags: 1001, uart1RxByteAgeMs: 1061 },
    });
  });

  it("extracts raw log timestamps and preserves protocol payload", () => {
    const records = parseReplayText("[1.000] RDBG,1\n[1.025] RDBG,2\n", { format: "raw" });
    expect(records.map((record) => [record.offsetMs, record.payload])).toEqual([
      [0, "RDBG,1"],
      [25, "RDBG,2"],
    ]);
  });

  it("uses an explicit CSV time column while retaining the entire parser line", () => {
    const records = parseReplayText("time_s,x,y\n10.0,1,2\n10.05,3,4\n", { format: "csv" });
    expect(records.map((record) => record.offsetMs)).toEqual([0, 50]);
    expect(records[0]?.payload).toBe("10.0,1,2");
    expect(records[1]?.columns).toEqual({ time_s: "10.05", x: "3", y: "4" });
  });

  it("does not mistake a headerless locator CSV field for a timestamp", () => {
    const records = parseReplayText("12.5,3.2,90\n12.6,3.3,91", {
      format: "csv",
      defaultIntervalMs: 10,
    });
    expect(records.map((record) => record.offsetMs)).toEqual([0, 10]);
    expect(records[0]?.payload).toBe("12.5,3.2,90");
  });

  it("can replay timestamp plus quoted protocol CSV rows by payload column", () => {
    const records = parseReplayText('1783761597211,"CDBG,578079,5655,1"\n1783761597221,"CDBG,578080,5656,1"\n', {
      format: "csv",
      timestampColumn: "column_1",
      payloadColumn: "column_2",
    });
    expect(records.map((record) => [record.offsetMs, record.payload])).toEqual([
      [0, "CDBG,578079,5655,1"],
      [10, "CDBG,578080,5656,1"],
    ]);
  });

  it("recognizes DBG_META as a raw protocol line when format is auto", () => {
    const records = parseReplayText("DBG_META,1,19,100,6,179,0x7059,build,ID1=RF,1,2,3,4,5,6,7,8,9,END\n", { format: "auto" });
    expect(records[0]?.payload).toBe("DBG_META,1,19,100,6,179,0x7059,build,ID1=RF,1,2,3,4,5,6,7,8,9,END");
    expect(records[0]?.columns).toBeUndefined();
  });
});

class FakeTimer implements ReplayTimerDriver {
  current = 0;
  pending: { callback: () => void; delay: number } | undefined;

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.pending = { callback, delay: delayMs };
    return this.pending;
  }

  clearTimeout(handle: unknown): void {
    if (this.pending === handle) this.pending = undefined;
  }

  flush(): void {
    const task = this.pending;
    if (!task) throw new Error("No scheduled callback");
    this.pending = undefined;
    this.current += task.delay;
    task.callback();
  }
}

describe("ReplayClock", () => {
  it("plays, pauses, seeks, steps, and scales source time", () => {
    const timer = new FakeTimer();
    const records = parseReplayText("[1.0] A\n[1.1] B\n[1.3] C", { format: "raw" });
    const emitted: string[] = [];
    const clock = new ReplayClock(records, {
      timer,
      speed: 2,
      onRecord: (record) => emitted.push(record.payload),
    });

    clock.play();
    timer.flush();
    expect(emitted).toEqual(["A"]);
    expect(timer.pending?.delay).toBe(50);
    clock.pause();
    expect(timer.pending).toBeUndefined();
    expect(clock.step()?.payload).toBe("B");
    clock.seek(2);
    expect(clock.step()?.payload).toBe("C");
    expect(clock.snapshot.state).toBe("finished");
  });
});

describe("loadReplayZip", () => {
  it("loads canonical session artifacts and ignores event-only files", () => {
    const archive = zipSync({
      "remote_raw.log": new TextEncoder().encode("[1] RDBG,1\n"),
      "events.csv": new TextEncoder().encode("event\n"),
      "session.json": new TextEncoder().encode('{"schemaVersion":1}'),
    });
    const bundle = loadReplayZip(archive, { name: "session.zip" });
    expect(bundle.name).toBe("session.zip");
    expect(bundle.tracks.map((track) => track.name)).toEqual(["remote_raw.log"]);
    expect(bundle.tracks[0]?.records[0]?.payload).toBe("RDBG,1");
    expect(bundle.tracks[0]?.coordinateSpace).toBe("unknown");
    expect(bundle.metadata).toEqual({ schemaVersion: 1 });
  });

  it("loads new remote/chassis raw artifacts from a replay ZIP", () => {
    const archive = zipSync({
      "remote_raw.log": new TextEncoder().encode("RDBG_TX,2,19,100,8,ACT,5,5B02010101,0,MAX_RT,0,-,15,0x10,0x01,0x2f,0,3,4\n"),
      "chassis_raw.log": new TextEncoder().encode("DBG_META,1,19,100,6,179,0x7059,build,ID1=RF,1,2,3,4,5,6,7,8,9,END\nCEVT,2,NRF_LINK,10,101,online,NA,0x10,4,5\n"),
      "connection_status.csv": new TextEncoder().encode("pc_time_ms,role,status\n1,remote,connected\n"),
    });
    const bundle = loadReplayZip(archive);
    expect(bundle.tracks.map((track) => track.name)).toEqual(["remote_raw.log", "chassis_raw.log"]);
    expect(bundle.tracks[0]?.records[0]?.payload).toContain("RDBG_TX,2,19");
    expect(bundle.tracks[1]?.records.map((record) => record.payload)).toEqual([
      "DBG_META,1,19,100,6,179,0x7059,build,ID1=RF,1,2,3,4,5,6,7,8,9,END",
      "CEVT,2,NRF_LINK,10,101,online,NA,0x10,4,5",
    ]);
  });

  it("loads timestamp plus raw-line protocol CSV artifacts from a replay ZIP", () => {
    const archive = zipSync({
      "remote_rdbg.csv": new TextEncoder().encode('10,"RDBG,100,7,ACT,76,1,6,1,20,4,1,1,10,0,2,88,1,none"\n'),
      "chassis_cdbg.csv": new TextEncoder().encode('20,"CDBG,1,2,3"\n'),
      "chassis_cevt.csv": new TextEncoder().encode('30,"CEVT,2,NRF_LINK,10,101,online,NA,0x10,4,5"\n'),
    });
    const bundle = loadReplayZip(archive);
    expect(bundle.tracks.map((track) => [track.name, track.records[0]?.payload, track.records[0]?.offsetMs])).toEqual([
      ["remote_rdbg.csv", "RDBG,100,7,ACT,76,1,6,1,20,4,1,1,10,0,2,88,1,none", 0],
      ["chassis_cdbg.csv", "CDBG,1,2,3", 0],
      ["chassis_cevt.csv", "CEVT,2,NRF_LINK,10,101,online,NA,0x10,4,5", 0],
    ]);
  });

  it("marks raw locator data as start-relative regardless of metadata", () => {
    const archive = zipSync({
      "raw_serial.log": new TextEncoder().encode("0,0,0\n"),
      "raw_frames.csv": new TextEncoder().encode("x,y,yaw\n0,0,0\n"),
      "locator_raw.log": new TextEncoder().encode("1,1,0\n"),
      "locator_frames.csv": new TextEncoder().encode("x,y,yaw\n1,1,0\n"),
      "metadata.json": new TextEncoder().encode('{"coordinateSpace":"field"}'),
    });
    const bundle = loadReplayZip(archive);
    expect(bundle.tracks.map((track) => [track.name, track.coordinateSpace])).toEqual([
      ["raw_serial.log", "start-relative"],
      ["raw_frames.csv", "start-relative"],
      ["locator_raw.log", "start-relative"],
      ["locator_frames.csv", "start-relative"],
    ]);
  });

  it("uses new web metadata for relative display frames", () => {
    const archive = zipSync({
      "display_frames.csv": new TextEncoder().encode("x,y,yaw\n0,0,0\n"),
      "locator_display_frames.csv": new TextEncoder().encode("x,y,yaw\n0,0,0\n"),
      "metadata.json": new TextEncoder().encode(JSON.stringify({
        locatorCoordinates: contextForSide("blue", "preliminary"),
      })),
    });
    expect(loadReplayZip(archive).tracks.map((track) => track.coordinateSpace)).toEqual(["start-relative", "start-relative"]);
  });

  it("keeps legacy official metadata readable for relative display frames", () => {
    const archive = zipSync({
      "display_frames.csv": new TextEncoder().encode("x,y,yaw\n0,0,0\n"),
      "metadata.json": new TextEncoder().encode(JSON.stringify({
        locatorCoordinates: {
          side: "blue",
          coordinateSpace: "start-relative",
          transformVersion: "r1-start-relative-v1",
          fieldAnchorCm: { x: 548.5, y: 548, yawDeg: 0 },
        },
      })),
    });
    expect(loadReplayZip(archive).tracks[0]?.coordinateSpace).toBe("start-relative");
  });

  it("treats legacy display frames without metadata as baked field coordinates", () => {
    const archive = zipSync({
      "display_frames.csv": new TextEncoder().encode("x,y,yaw\n-555.7,549,0\n"),
    });
    expect(loadReplayZip(archive).tracks[0]?.coordinateSpace).toBe("field");
  });

  it("recognizes legacy field coordinate metadata when a side is recorded", () => {
    const zip = zipSync({
      "display_frames.csv": new TextEncoder().encode("x,y,yaw\n-555.7,549,0\n"),
      "metadata.json": new TextEncoder().encode(JSON.stringify({ locatorCoordinates: { coordinateSpace: "field", side: "red" } })),
    });
    expect(loadReplayZip(zip).tracks[0]?.coordinateSpace).toBe("field");
  });

  it("keeps explicitly unsupported coordinate metadata unknown", () => {
    const archive = zipSync({
      "display_frames.csv": new TextEncoder().encode("x,y,yaw\n0,0,0\n"),
      "metadata.json": new TextEncoder().encode('{"coordinateSpace":"mystery"}'),
    });
    expect(loadReplayZip(archive).tracks[0]?.coordinateSpace).toBe("unknown");
  });

  it("does not guess the coordinate space when metadata JSON is corrupt", () => {
    const archive = zipSync({
      "display_frames.csv": new TextEncoder().encode("x,y,yaw\n0,0,0\n"),
      "metadata.json": new TextEncoder().encode("{broken"),
    });
    expect(loadReplayZip(archive).tracks[0]?.coordinateSpace).toBe("unknown");
  });
});
