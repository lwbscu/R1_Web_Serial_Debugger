import { describe, expect, it } from "vitest";
import { DiagnosticEventDetector } from "../../src/features/communication/eventDetector";
import type { ChassisFrame, RemoteFrame } from "../../src/protocols";

const remote = (patch: Partial<RemoteFrame> = {}): RemoteFrame => ({
  observedAtMs: 1000, rawLine: "RDBG", ms: 1, seq: 1, packetType: "T", rfCh: 76,
  txRet: 0, ackLen: 32, failCount: 0, ackOkCount: 1, signalBars: 4,
  linkReady: 1, linkOnline: 1, noAckMs: 0, lost: 0, retry: 0,
  rxScore: 100, localPresent: 1, xReason: "none", ...patch,
});

const chassis = (patch: Partial<ChassisFrame> = {}): ChassisFrame => ({
  observedAtMs: 1000, rawLine: "CDBG", protocolVersion: 2, fieldCount: 90,
  nrfScanState: 1, nrfCh: 76, yaw: 0, locFrameAgeMs: 0, ...patch,
});

describe("DiagnosticEventDetector", () => {
  it("matches remote X/channel/ACK transitions", () => {
    const detector = new DiagnosticEventDetector();
    expect(detector.acceptRemote(remote({ signalBars: 0, noAckMs: 350, xReason: "ack" })).map((event) => event.kind)).toEqual(["X_ENTER", "ACK_TIMEOUT"]);
    expect(detector.acceptRemote(remote({ observedAtMs: 1100, rfCh: 77 })).map((event) => event.kind)).toEqual(["X_EXIT", "RF_CH_CHANGE"]);
  });

  it("detects chassis scan, locator loss, yaw spike and channel mismatch", () => {
    const detector = new DiagnosticEventDetector();
    detector.acceptRemote(remote({ rfCh: 76 }));
    expect(detector.acceptChassis(chassis({ nrfScanState: 0, nrfCh: 77, locFrameAgeMs: 600 })).map((event) => event.kind)).toEqual(["CHASSIS_FAST_SCAN", "LOCATER_FRAME_LOST", "CHANNEL_MISMATCH"]);
    expect(detector.acceptChassis(chassis({ observedAtMs: 1100, yaw: 45 })).map((event) => event.kind)).toContain("YAW_SPIKE");
  });
});
