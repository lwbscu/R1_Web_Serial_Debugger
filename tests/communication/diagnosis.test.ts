import { describe, expect, it } from "vitest";
import type { ChassisFrame, RemoteFrame } from "../../src/protocols";
import { diagnoseLink, freshMetricContext } from "../../src/features/communication/diagnosis";

const remote = (overrides: Partial<RemoteFrame> = {}): RemoteFrame => ({
  observedAtMs: 1000, rawLine: "RDBG", ms: 1, seq: 1, packetType: "T", rfCh: 76,
  txRet: 1, ackLen: 8, failCount: 0, ackOkCount: 10, signalBars: 4, linkReady: 1,
  linkOnline: 1, noAckMs: 10, lost: 0, retry: 0, rxScore: 90, localPresent: 1,
  xReason: "none", ...overrides,
});

const chassis = (overrides: Record<string, string | number | null> = {}): ChassisFrame => ({
  observedAtMs: 1000, rawLine: "CDBG", protocolVersion: 2, fieldCount: 90,
  lastSigAgeMs: 10, lastRawAgeMs: 10, joyAgeMs: 10, motionSource: 1,
  audioCount: 0, audioLastReason: 0, locFrameAgeMs: 10, diagDropCount: 0,
  steerErr1: 0, steerErr2: 0, steerErr3: 0, steerErr4: 0,
  drvCmd1: 0, drvCmd2: 0, drvCmd3: 0, drvCmd4: 0,
  drvFb1: 0, drvFb2: 0, drvFb3: 0, drvFb4: 0,
  ...overrides,
});

describe("frozen Python diagnosis summary", () => {
  it("expires business frames independently from the port lifecycle", () => {
    const context = freshMetricContext({ remote: remote({ observedAtMs: 1000 }), chassis: chassis({ observedAtMs: 1000 }) }, 2501);
    expect(context).toEqual({ remote: null, chassis: null });
    expect(diagnoseLink(context).status).toBe("unknown");
  });

  it("distinguishes missing sources", () => {
    expect(diagnoseLink({ remote: null, chassis: null }).status).toBe("unknown");
    expect(diagnoseLink({ remote: remote(), chassis: null }).text).toMatch(/no chassis CDBG/);
    expect(diagnoseLink({ remote: null, chassis: chassis() }).text).toMatch(/remote debug port/);
  });

  it("prioritizes packet, motion, audio, steering, and drive faults", () => {
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ joyAgeMs: 501 }) }).text).toMatch(/joystick packets/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ motionSource: 3 }) }).text).toMatch(/point \(3\)/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ audioCount: 1, audioLastReason: 3 }) }).text).toMatch(/three_zone_sound/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ steerErr1: 31 }) }).text).toMatch(/steering error/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ drvCmd1: 1 }) }).text).toMatch(/command exists/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ drvFb1: 1 }) }).text).toMatch(/command is zero/);
  });

  it("reports locater and telemetry degradation before success", () => {
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ locFrameAgeMs: 501 }) }).text).toMatch(/USART3/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis({ diagDropCount: 1 }) }).text).toMatch(/USART2 was busy/);
    expect(diagnoseLink({ remote: remote(), chassis: chassis() })).toMatchObject({ status: "normal" });
  });
});
