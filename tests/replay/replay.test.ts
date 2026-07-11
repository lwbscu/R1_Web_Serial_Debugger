import { zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ReplayClock,
  loadReplayZip,
  parseReplayText,
  type ReplayTimerDriver,
} from "../../src/core/replay";
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
    expect(bundle.metadata).toEqual({ schemaVersion: 1 });
  });
});
