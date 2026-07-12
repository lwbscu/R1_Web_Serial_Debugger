import { describe, expect, it } from "vitest";
import type { ChassisFrame, RemoteFrame, RemoteTxEvent } from "../../src/protocols";
import { buildRemoteCommandView } from "../../src/features/remoteControl/model";

const remote = (overrides: Partial<RemoteFrame> = {}): RemoteFrame => ({
  observedAtMs: 1000, rawLine: "RDBG", ms: 1, seq: 1, packetType: "ACT", rfCh: 76,
  txRet: 1, ackLen: 6, failCount: 0, ackOkCount: 10, signalBars: 4, linkReady: 1,
  linkOnline: 1, noAckMs: 10, lost: 0, retry: 0, rxScore: 90, localPresent: 1,
  xReason: "none", ...overrides,
});

const tx = (overrides: Partial<RemoteTxEvent> = {}): RemoteTxEvent => ({
  observedAtMs: 1200, rawLine: "RDBG_TX", protocolVersion: 1, ms: 2, seq: 3,
  packetType: "ACT", txLen: 5, txHex: "5B02010101", txBytes: [0x5B, 2, 1, 1, 1],
  txRet: 1, ackLen: 6, ackHex: "875C02010101", ackBytes: [0x87, 0x5C, 2, 1, 1, 1],
  lost: 0, retry: 0, args: [2, 1, 1, 1], ...overrides,
});

const chassis = (overrides: Record<string, string | number | null> = {}): ChassisFrame => ({
  observedAtMs: 1100, rawLine: "CDBG", protocolVersion: 3, fieldCount: 151,
  taskFrameAgeMs: 20, taskFrameCount: 3, actionEnqueueOkCount: 3, actionEnqueueDropCount: 0,
  actionDequeueCount: 3, actionDequeueAgeMs: 30, mechTxStartCount: 3, mechTxOkCount: 3,
  mechTxFailCount: 0, mechTxInFlightAgeMs: null, mechTxLastStatus: 0, mechFeedbackOkCount: 2,
  mechFeedbackBadCount: 0, mechFeedbackQueueDropCount: 0, mechFeedbackAgeMs: 40,
  adcAgeMs: 20, adcCount: 100, modeFrameAgeMs: 20, modeFrameCount: 2, keyAgeMs: 20, keyCount: 1,
  ...overrides,
});

describe("remote command view model", () => {
  it("highlights a successful ACT through ACK, chassis, queue, USART1, and feedback", () => {
    const view = buildRemoteCommandView(remote(), chassis(), tx(), 1500);
    expect(view.primaryStatus).toBe("normal");
    expect(view.title).toContain("ACT");
    expect(view.txHex).toContain("5B");
    expect(view.steps.map((step) => step.key)).toEqual(["remote_tx", "nrf_ack", "chassis_receive", "command_apply", "mechanism_feedback"]);
  });

  it("marks TX failure as an error even if old RDBG is present", () => {
    const view = buildRemoteCommandView(remote(), chassis(), tx({ txRet: 0, ackLen: 0, ackHex: "-", ackBytes: [] }), 1500);
    expect(view.primaryStatus).toBe("error");
    expect(view.steps[0]).toMatchObject({ key: "remote_tx", status: "error" });
  });

  it("degrades when the current firmware only provides legacy RDBG", () => {
    const view = buildRemoteCommandView(remote({ packetType: "ADC" }), null, null, 1500);
    expect(view.primaryStatus).toBe("warn");
    expect(view.subtitle).toContain("尚未看到 RDBG_TX");
    expect(view.steps.find((step) => step.key === "chassis_receive")?.status).toBe("unknown");
  });

  it("detects missing mechanism feedback for ACT", () => {
    const view = buildRemoteCommandView(remote(), chassis({ mechFeedbackAgeMs: 5000 }), tx(), 1500);
    expect(view.primaryStatus).toBe("error");
    expect(view.steps.find((step) => step.key === "mechanism_feedback")?.status).toBe("error");
  });
});
