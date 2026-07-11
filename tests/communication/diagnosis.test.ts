import { describe, expect, it } from "vitest";
import type { ChassisFrame, RemoteFrame } from "../../src/protocols";
import { diagnoseLink, expectedChassisStateForRemoteMode, freshMetricContext } from "../../src/features/communication/diagnosis";

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
  it("maps RemoteMode_t to ChassisState_t instead of comparing enum numbers", () => {
    expect(expectedChassisStateForRemoteMode(0)).toBe(0);
    expect(expectedChassisStateForRemoteMode(1)).toBe(2);
    expect(expectedChassisStateForRemoteMode(2)).toBe(1);
    expect(expectedChassisStateForRemoteMode(3)).toBeNull();
  });
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

  it("prioritizes current CDBG v3 radio, mode, and mechanism faults", () => {
    const v3 = chassis({
      protocolVersion: 3, fieldCount: 151, linkAlive: 1, adcAgeMs: 10,
      nrfUpdateHeartbeatAgeMs: 10, nrfAckHeartbeatAgeMs: 10,
      chassisUpdateHeartbeatAgeMs: 10, communHeartbeatAgeMs: 10,
      nrfRegMismatchMask: 0, nrfSpiLastErrorAgeMs: null,
      activeRemoteModeLive: 0, chassisState: 0, stateQ: 0,
      mechTxInFlightAgeMs: null, uart1ErrorCode: 0,
      actionEnqueueOkCount: 0, actionDequeueCount: 0,
      mechTxStartCount: 0, uart1RxByteCount: 0, mechFeedbackOkCount: 0,
      stateEnqueueDropCount: 0, badFrameCount: 0, rxWidthErrorCount: 0,
      ackLockFailCount: 0, ackNotifyTimeoutCount: 0, nrfSpiErrorCount: 0,
      actionEnqueueDropCount: 0, mechTxFailCount: 0, mechFeedbackBadCount: 0,
      mechFeedbackQueueDropCount: 0, uart1ErrorCount: 0, uart1RearmFailCount: 0,
    });
    expect(diagnoseLink({ remote: remote(), chassis: { ...v3, nrfUpdateHeartbeatAgeMs: 1500 } }).text).toMatch(/NrfUpdate.*stalled/);
    expect(diagnoseLink({ remote: remote(), chassis: { ...v3, nrfRegMismatchMask: 4 } }).text).toMatch(/register snapshot/);
    expect(diagnoseLink({ remote: remote(), chassis: { ...v3, adcAgeMs: 1500 } }).text).toMatch(/ADC joystick/);
    expect(diagnoseLink({ remote: remote(), chassis: { ...v3, activeRemoteModeLive: 2 } }).text).toMatch(/out of sync/);
    expect(diagnoseLink({ remote: remote(), chassis: { ...v3, mechTxInFlightAgeMs: 1500 } }).text).toMatch(/in flight/);
    expect(diagnoseLink({ remote: remote(), chassis: { ...v3, uart1ErrorCode: 8 } }).text).toMatch(/HAL error/);
  });

  it("treats cumulative v3 history as warning, not a current error", () => {
    const result = diagnoseLink({ remote: remote(), chassis: chassis({
      protocolVersion: 3, fieldCount: 151, linkAlive: 1, adcAgeMs: 10,
      nrfUpdateHeartbeatAgeMs: 10, nrfAckHeartbeatAgeMs: 10,
      chassisUpdateHeartbeatAgeMs: 10, communHeartbeatAgeMs: 10,
      nrfRegMismatchMask: 0, nrfSpiLastErrorAgeMs: null,
      activeRemoteModeLive: 0, chassisState: 0, stateQ: 0,
      mechTxInFlightAgeMs: null, uart1ErrorCode: 0,
      actionEnqueueOkCount: 0, actionDequeueCount: 0, mechTxStartCount: 0,
      uart1RxByteCount: 0, mechFeedbackOkCount: 0,
      stateEnqueueDropCount: 0, badFrameCount: 7, rxWidthErrorCount: 0,
      ackLockFailCount: 0, ackNotifyTimeoutCount: 0, nrfSpiErrorCount: 0,
      actionEnqueueDropCount: 0, mechTxFailCount: 0, mechFeedbackBadCount: 0,
      mechFeedbackQueueDropCount: 0, uart1ErrorCount: 0, uart1RearmFailCount: 0,
    }) });
    expect(result).toMatchObject({ status: "warn" });
    expect(result.text).toMatch(/Historical/);
  });
});
