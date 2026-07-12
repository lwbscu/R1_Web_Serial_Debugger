import { describe, expect, it } from "vitest";
import type { ChassisFrame, RemoteFrame } from "../../src/protocols";
import {
  chassisNrfMetricSpecs,
  locationMetricSpecs,
  mechanismMetricSpecs,
  modeSyncMetricSpecs,
  panelStatus,
  pointDebugMetricSpecs,
  remoteMetricSpecs,
  wirelessReceiveMetricSpecs,
  type MetricContext,
} from "../../src/features/communication/metrics";
import { generateHtmlDiagnosticReport, generateMarkdownDiagnosticReport } from "../../src/features/communication/reports";

const remote = (overrides: Partial<RemoteFrame> = {}): RemoteFrame => ({
  observedAtMs: 1000, rawLine: "RDBG", ms: 1, seq: 1, packetType: "T", rfCh: 76,
  txRet: 1, ackLen: 8, failCount: 0, ackOkCount: 10, signalBars: 4, linkReady: 1,
  linkOnline: 1, noAckMs: 10, lost: 0, retry: 0, rxScore: 90, localPresent: 1,
  xReason: "none", ...overrides,
});

const chassis = (overrides: Record<string, string | number | null> = {}): ChassisFrame => ({
  observedAtMs: 1000, rawLine: "CDBG", protocolVersion: 2, fieldCount: 90,
  nrfScanState: 1, nrfCh: 76, lastSigAgeMs: 10, lastRawAgeMs: 10, packetLossRate: 0.1,
  nrfUpdateMaxMs: 20, nrfAckMaxMs: 20, scanWaitMaxMs: 10, joyAgeMs: 10, joyValid: 1,
  motionSource: 1, audioLastReason: 0, audioCount: 0, diagDropCount: 0,
  posX: 1, posY: 2, yaw: 3, locFrameAgeMs: 10, locRxBad: 0, locChecksumErr: 0,
  steerErr1: 0, steerErr2: 0, steerErr3: 0, steerErr4: 0, motorFaultMask: 0, canTxErr: 0,
  ...overrides,
});

const context = (r: RemoteFrame | null = remote(), c: ChassisFrame | null = chassis()): MetricContext => ({ remote: r, chassis: c });
const spec = (items: typeof remoteMetricSpecs, key: string) => items.find((item) => item.key === key)!;

describe("Python-equivalent metric configuration", () => {
  it("defines every required metric with five tooltip sections", () => {
    expect(remoteMetricSpecs).toHaveLength(11);
    expect(chassisNrfMetricSpecs).toHaveLength(15);
    expect(locationMetricSpecs).toHaveLength(19);
    expect(wirelessReceiveMetricSpecs).toHaveLength(8);
    expect(modeSyncMetricSpecs).toHaveLength(4);
    expect(mechanismMetricSpecs).toHaveLength(5);
    expect(pointDebugMetricSpecs).toHaveLength(5);
    for (const item of [...remoteMetricSpecs, ...chassisNrfMetricSpecs, ...wirelessReceiveMetricSpecs, ...modeSyncMetricSpecs, ...mechanismMetricSpecs, ...pointDebugMetricSpecs, ...locationMetricSpecs]) {
      expect(item.key).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.variable).toBeTruthy();
      expect(Object.values(item.tooltip).every((value) => value.trim().length > 0)).toBe(true);
    }
  });

  it("keeps historical v3 counters yellow while current faults are red", () => {
    const base = chassis({
      protocolVersion: 3, fieldCount: 151, linkAlive: 1, rawScore: 90,
      lastFrameType: 1, validFrameCount: 10, badFrameCount: 0, rxWidthErrorCount: 0,
      adcAgeMs: 10, modeFrameAgeMs: 10, keyAgeMs: 10, taskFrameAgeMs: 10,
      nrfUpdateHeartbeatAgeMs: 10, nrfAckHeartbeatAgeMs: 10, chassisUpdateHeartbeatAgeMs: 10,
      communHeartbeatAgeMs: 10, ackWriteAgeMs: 10, ackLockFailCount: 0, ackNotifyTimeoutCount: 0,
      linkRawLostCount: 0, linkScanTimeoutCount: 0, linkWeakScanCount: 0, linkRecoverCount: 0,
      nrfSpiErrorCount: 0, nrfSpiLastErrorAgeMs: null, nrfRegAgeMs: 10,
      nrfRegMismatchMask: 0, nrfRegPack0: 1, nrfRegPack1: 2, nrfRegPack2: 3,
      remoteMode: 0, activeRemoteModeLive: 0, chassisState: 0, stateQ: 0,
      stateEnqueueDropCount: 0, lastStateApplyAgeMs: 10, modeFrameCount: 1,
      actionEnqueueOkCount: 0, actionEnqueueDropCount: 0, actionDequeueCount: 0,
      actionDequeueAgeMs: null, mechTxStartCount: 0, mechTxOkCount: 0, mechTxFailCount: 0,
      mechTxInFlightAgeMs: null, mechTxLastDurationMs: null, mechTxLastStatus: null,
      uart1GState: 0, uart1RxState: 0, uart1ErrorCode: 0, mechFeedbackOkCount: 0,
      mechFeedbackBadCount: 0, mechFeedbackQueueDropCount: 0, mechFeedbackAgeMs: null,
      uart1ErrorCount: 0, uart1RearmOkCount: 1, uart1RearmFailCount: 0,
      uart1RxByteCount: 0, uart1RxByteAgeMs: null,
    });
    const spi = spec(wirelessReceiveMetricSpecs, "v3_spi_errors");
    expect(spi.evaluator?.(spi.getter(context(remote(), { ...base, nrfSpiErrorCount: 2 })), context(remote(), base))).toBe("warn");
    expect(spi.evaluator?.(spi.getter(context(remote(), { ...base, nrfSpiErrorCount: 2, nrfSpiLastErrorAgeMs: 100 })), context(remote(), base))).toBe("error");
    expect(panelStatus.mode(context(remote(), { ...base, activeRemoteModeLive: 2, chassisState: 0 }))).toBe("error");
    expect(panelStatus.mechanism(context(remote(), { ...base, actionEnqueueDropCount: 1 }))).toBe("warn");
    expect(panelStatus.mechanism(context(remote(), { ...base, mechTxInFlightAgeMs: 1500 }))).toBe("error");
    expect(panelStatus.pointDebug(context(remote(), { ...base, dgmRecoverCount1: 0, dgmRecoverCount2: 0, dgmRecoverCount3: 0, dgmRecoverCount4: 0 }))).toBe("normal");
    expect(panelStatus.pointDebug(context(remote(), { ...base, dgmRecoverCount1: 0, dgmRecoverCount2: 2, dgmRecoverCount3: 0, dgmRecoverCount4: 0 }))).toBe("warn");
  });

  it("applies remote and chassis thresholds", () => {
    const noAck = spec(remoteMetricSpecs, "no_ack_ms");
    expect(noAck.evaluator?.(99, context())).toBe("normal");
    expect(noAck.evaluator?.(100, context())).toBe("warn");
    expect(noAck.evaluator?.(300, context())).toBe("error");

    const loss = spec(chassisNrfMetricSpecs, "packet_loss_rate");
    expect(loss.evaluator?.(.2, context())).toBe("normal");
    expect(loss.evaluator?.(.21, context())).toBe("warn");
    expect(loss.evaluator?.(.8, context())).toBe("error");
    expect(panelStatus.chassis(context(remote(), chassis({ lastSigAgeMs: 501 })))).toBe("error");
  });

  it("applies location age, steering, motor, and CAN status", () => {
    const age = spec(locationMetricSpecs, "loc_frame_age_ms");
    expect(age.evaluator?.(200, context())).toBe("normal");
    expect(age.evaluator?.(201, context())).toBe("warn");
    expect(age.evaluator?.(501, context())).toBe("error");
    expect(panelStatus.location(context(remote(), chassis({ motorFaultMask: 1 })))).toBe("error");
    expect(panelStatus.location(context(remote(), chassis({ steerErr1: 31 })))).toBe("warn");
  });
});

describe("offline diagnostic reports", () => {
  const input = {
    title: "R1 <unsafe>", generatedAtMs: 0, sessionId: "A|B",
    diagnosis: { text: "bad <script>alert(1)</script>", status: "error" as const },
    metrics: [{ panel: "Remote", title: "Signal|bars", variable: "signal_bars", value: "0", status: "error" as const }],
    events: [{ observedAtMs: 0, severity: "error" as const, kind: "X_ENTER", detail: "<img src=x onerror=1>" }],
  };

  it("escapes Markdown table delimiters", () => {
    const report = generateMarkdownDiagnosticReport(input);
    expect(report).toContain("Signal\\|bars");
    expect(report).toContain("Session: A\\|B");
    expect(report).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report).toContain("&lt;img src=x onerror=1&gt;");
    expect(report).not.toContain("<script>");
    expect(report).not.toContain("<img src=x");
  });

  it("creates self-contained escaped HTML", () => {
    const report = generateHtmlDiagnosticReport(input);
    expect(report).toContain("R1 &lt;unsafe&gt;");
    expect(report).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(report).not.toContain("<script>");
    expect(report).not.toContain("<img src=x");
    expect(report).not.toMatch(/https?:\/\//);
  });
});
