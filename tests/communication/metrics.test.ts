import { describe, expect, it } from "vitest";
import type { ChassisFrame, RemoteFrame } from "../../src/protocols";
import {
  chassisNrfMetricSpecs,
  locationMetricSpecs,
  panelStatus,
  remoteMetricSpecs,
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
    expect(locationMetricSpecs).toHaveLength(17);
    for (const item of [...remoteMetricSpecs, ...chassisNrfMetricSpecs, ...locationMetricSpecs]) {
      expect(item.key).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.variable).toBeTruthy();
      expect(Object.values(item.tooltip).every((value) => value.trim().length > 0)).toBe(true);
    }
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
