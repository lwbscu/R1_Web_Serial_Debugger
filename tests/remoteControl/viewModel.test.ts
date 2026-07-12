import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "../../src/core/types";
import type { ChassisFrame, RemoteFrame, RemoteTxEvent } from "../../src/protocols";
import { buildMechanismLiveView, buildRemoteCommandView } from "../../src/features/remoteControl/model";

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

const event = (eventKind: string, fields: readonly unknown[], observedAtMs = 1300): ProtocolEvent => ({
  source: "chassis",
  eventKind,
  observedAtMs,
  sourceTimeMs: observedAtMs - 1000,
  fields,
  rawLine: `CEVT,${eventKind},${observedAtMs},${fields.join(",")}`,
});

const actEvents = (): ProtocolEvent[] => [
  event("MECH_CMD", [1, 2, 1, 1, 1, 1], 1260),
  event("MECH_CMD", [3, 2, 1, 1, 1, 0], 1280),
  event("MECH_TX", [2, 2, 1, 1, 1, 0, 3], 1300),
  event("MECH_FB", [1, 2, 1, 1, 1, 5, 5], 1320),
];

describe("remote command view model", () => {
  it("highlights a successful ACT through ACK, chassis, queue, USART1, and feedback", () => {
    const view = buildRemoteCommandView(remote(), chassis(), tx(), 1500, actEvents());
    expect(view.primaryStatus).toBe("warn");
    expect(view.headlineLabel).toBe("当前动作指令");
    expect(view.title).toContain("ACT");
    expect(view.txHex).toContain("5B");
    expect(view.ackResult).toContain("反馈状态");
    expect(view.ackResult).toContain("state=2");
    expect(view.args).toEqual([
      { label: "state", value: "2" },
      { label: "stage", value: "1" },
      { label: "exec", value: "1" },
      { label: "enabled", value: "1" },
    ]);
    expect(view.steps.map((step) => step.key)).toEqual(["remote_tx", "nrf_ack", "chassis_receive", "command_apply", "usart1_tx", "mechanism_feedback"]);
    expect(view.steps.find((step) => step.key === "usart1_tx")?.detail).toContain("MECH_TX done");
  });

  it("marks TX failure as an error even if old RDBG is present", () => {
    const view = buildRemoteCommandView(remote(), chassis(), tx({ txRet: 0, ackLen: 0, ackHex: "-", ackBytes: [] }), 1500);
    expect(view.primaryStatus).toBe("error");
    expect(view.steps[0]).toMatchObject({ key: "remote_tx", status: "error" });
  });

  it("shows ACT ACK feedback as time-correlated status without declaring sequence match", () => {
    const view = buildRemoteCommandView(remote(), chassis(), tx({ ackBytes: [0x87, 0x5C, 9, 1, 1, 1], ackHex: "875C09010101" }), 1500, actEvents());
    expect(view.primaryStatus).toBe("warn");
    expect(view.ackResult).toContain("反馈状态");
    expect(view.ackResult).toContain("state=9");
    expect(view.ackResult).not.toContain("匹配");
    expect(view.steps.find((step) => step.key === "nrf_ack")).toMatchObject({ status: "normal" });
    expect(view.steps.find((step) => step.key === "nrf_ack")?.detail).toContain("仅按时间邻近展示");
    expect(view.steps.find((step) => step.key === "nrf_ack")?.detail).not.toContain("匹配");
  });

  it("treats mechanism feedback exec as returned status, not an ACK echo mismatch", () => {
    const request = tx({
      txHex: "5B02010001",
      txBytes: [0x5B, 2, 1, 0, 1],
      ackHex: "875C02010301",
      ackBytes: [0x87, 0x5C, 2, 1, 3, 1],
      args: [2, 1, 0, 1],
    });
    const events: ProtocolEvent[] = [
      event("MECH_CMD", [1, 2, 1, 0, 1, 1], 1260),
      event("MECH_CMD", [3, 2, 1, 0, 1, 0], 1280),
      event("MECH_TX", [2, 2, 1, 0, 1, 0, 3], 1300),
      event("MECH_FB", [1, 2, 1, 3, 1, 6, 6], 1320),
    ];
    const view = buildRemoteCommandView(remote(), chassis(), request, 1500, events);
    expect(view.primaryStatus).toBe("warn");
    expect(view.ackResult).toContain("exec=3");
    expect(view.steps.find((step) => step.key === "nrf_ack")?.detail).toContain("exec=3");
    expect(view.steps.find((step) => step.key === "mechanism_feedback")?.detail).toContain("exec=3");
  });

  it("degrades when the current firmware only provides legacy RDBG", () => {
    const view = buildRemoteCommandView(remote({ packetType: "ADC" }), null, null, 1500);
    expect(view.primaryStatus).toBe("warn");
    expect(view.subtitle).toContain("当前固件未输出 RDBG_TX");
    expect(view.steps.find((step) => step.key === "chassis_receive")?.status).toBe("unknown");
  });

  it("detects missing mechanism feedback for ACT", () => {
    const view = buildRemoteCommandView(remote(), chassis({ mechFeedbackAgeMs: 5000 }), tx(), 1500);
    expect(view.primaryStatus).toBe("error");
    expect(view.steps.find((step) => step.key === "mechanism_feedback")?.status).toBe("error");
  });

  it("summarizes live mechanism feedback state and stage even without matching remote TX", () => {
    const view = buildMechanismLiveView(chassis(), actEvents(), 1500);
    const feedback = view.cards.find((card) => card.key === "fb");
    expect(view.primaryStatus).toBe("normal");
    expect(view.title).toContain("机构反馈");
    expect(feedback?.title).toContain("机构有效回传");
    expect(feedback?.args).toEqual([
      { label: "state", value: "2" },
      { label: "stage", value: "1" },
      { label: "exec", value: "1" },
      { label: "enabled", value: "1" },
    ]);
  });

  it("keeps mechanism summary explicit when chassis is not connected", () => {
    const view = buildMechanismLiveView(null, [], 1500);
    expect(view.primaryStatus).toBe("unknown");
    expect(view.notice).toContain("请同时连接底盘 CDBG");
    expect(view.cards.map((card) => card.key)).toEqual(["cmd", "tx", "fb", "uart"]);
  });
});
