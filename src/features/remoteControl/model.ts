import type { ProtocolEvent } from "../../core/types";
import type { ChassisFrame, RemoteFrame, RemoteTxEvent } from "../../protocols";

export type RemoteCommandStatus = "normal" | "warn" | "error" | "unknown";

export interface CommandArg {
  label: string;
  value: string;
}

export interface EffectStep {
  key: string;
  label: string;
  status: RemoteCommandStatus;
  detail: string;
}

export interface MechanismLiveCard {
  key: string;
  label: string;
  status: RemoteCommandStatus;
  title: string;
  detail: string;
  args: CommandArg[];
}

export interface MechanismLiveView {
  primaryStatus: RemoteCommandStatus;
  title: string;
  subtitle: string;
  cards: MechanismLiveCard[];
  notice: string | null;
}

export interface RemoteCommandView {
  headlineLabel: string;
  title: string;
  subtitle: string;
  primaryStatus: RemoteCommandStatus;
  txResult: string;
  ackResult: string;
  ageMs: number | null;
  txHex: string;
  ackHex: string;
  args: CommandArg[];
  steps: EffectStep[];
  notice: string | null;
}

const STATUS_RANK: Record<RemoteCommandStatus, number> = { unknown: 0, normal: 1, warn: 2, error: 3 };
const ACT_EVENT_WINDOW_BEFORE_MS = 750;
const ACT_EVENT_WINDOW_AFTER_MS = 4500;

function numberField(frame: ChassisFrame | null, name: string): number | null {
  const value = frame?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fresh<T extends { observedAtMs: number }>(frame: T | null, nowMs: number, staleAfterMs = 1500): T | null {
  return frame && nowMs - frame.observedAtMs <= staleAfterMs ? frame : null;
}

function ageDetail(key: string, age: number | null, label: string, warnMs = 400, errorMs = 1200): EffectStep {
  if (age === null) return { key, label, status: "unknown", detail: "当前 CDBG 没有提供该类包年龄。" };
  if (age <= warnMs) return { key, label, status: "normal", detail: `最近 ${age} ms 内已刷新。` };
  if (age <= errorMs) return { key, label, status: "warn", detail: `最近 ${age} ms 未刷新，需对齐操作时刻。` };
  return { key, label, status: "error", detail: `${age} ms 未刷新，底盘可能没收到该类命令。` };
}

function statusText(status: RemoteCommandStatus): string {
  return { normal: "正常", warn: "注意", error: "异常", unknown: "未知" }[status];
}

export function formatHexBytes(bytes: readonly number[]): string {
  return bytes.length === 0 ? "—" : bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

export function commandArgs(event: RemoteTxEvent | null): CommandArg[] {
  if (!event) return [];
  const [a0, a1, a2, a3] = event.args;
  switch (event.packetType) {
    case "ADC":
      return [
        { label: "ADC0", value: String(a0) },
        { label: "ADC1", value: String(a1) },
        { label: "ADC2", value: String(a2) },
        { label: "ADC3", value: String(a3) },
      ];
    case "ACT":
      return [
        { label: "state", value: String(a0) },
        { label: "stage", value: String(a1) },
        { label: "exec", value: String(a2) },
        { label: "enabled", value: String(a3) },
      ];
    case "KEY":
      return [{ label: "key", value: String(a0) }];
    case "MODE":
    case "VMODE":
      return [
        { label: "mode/code", value: String(a0) },
        { label: "x", value: String(a1) },
        { label: "y", value: String(a2) },
        { label: "z/flag", value: String(a3) },
      ];
    case "SIGTEST":
      return [
        { label: "score", value: String(a0) },
        { label: "channel", value: String(a1) },
      ];
    default:
      return [
        { label: "arg0", value: String(a0) },
        { label: "arg1", value: String(a1) },
        { label: "arg2", value: String(a2) },
        { label: "arg3", value: String(a3) },
      ];
  }
}

export function formatCommandArgs(event: RemoteTxEvent): string {
  return commandArgs(event).map((arg) => `${arg.label}=${arg.value}`).join(" ");
}

function eventNumber(event: ProtocolEvent | null, index: number): number | null {
  const value = event?.fields[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadText(values: readonly (number | null)[]): string {
  const [state, stage, exec, enabled] = values;
  return `state=${state ?? "—"} · stage=${stage ?? "—"} · exec=${exec ?? "—"} · enabled=${enabled ?? "—"}`;
}

function actPayloadText(event: RemoteTxEvent): string {
  return payloadText(event.args.slice(0, 4));
}

function eventPayloadText(event: ProtocolEvent): string {
  return payloadText([eventNumber(event, 1), eventNumber(event, 2), eventNumber(event, 3), eventNumber(event, 4)]);
}

function eventAge(event: ProtocolEvent, nowMs: number): string {
  return `${Math.max(0, nowMs - event.observedAtMs)} ms 前`;
}

function latestKindEvent(events: readonly ProtocolEvent[], kind: string): ProtocolEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventKind === kind) return event;
  }
  return null;
}

function tupleArgs(event: ProtocolEvent | null): CommandArg[] {
  if (!event) return [];
  return [
    { label: "state", value: String(eventNumber(event, 1) ?? "—") },
    { label: "stage", value: String(eventNumber(event, 2) ?? "—") },
    { label: "exec", value: String(eventNumber(event, 3) ?? "—") },
    { label: "enabled", value: String(eventNumber(event, 4) ?? "—") },
  ];
}

function summaryCard(
  key: string,
  label: string,
  status: RemoteCommandStatus,
  title: string,
  detail: string,
  args: CommandArg[] = [],
): MechanismLiveCard {
  return { key, label, status, title, detail, args };
}

function inEventWindow(event: ProtocolEvent, tx: RemoteTxEvent, nowMs: number): boolean {
  return event.observedAtMs >= tx.observedAtMs - ACT_EVENT_WINDOW_BEFORE_MS &&
    nowMs - event.observedAtMs <= ACT_EVENT_WINDOW_AFTER_MS;
}

function eventMatchesActCommand(event: ProtocolEvent, tx: RemoteTxEvent): boolean {
  if (tx.packetType !== "ACT") return false;
  const [state, stage, exec, enabled] = tx.args;
  return eventNumber(event, 1) === state &&
    eventNumber(event, 2) === stage &&
    eventNumber(event, 3) === exec &&
    eventNumber(event, 4) === enabled;
}

function eventMatchesActFeedback(event: ProtocolEvent, tx: RemoteTxEvent): boolean {
  if (tx.packetType !== "ACT") return false;
  const [state, stage] = tx.args;
  return eventNumber(event, 1) === state && eventNumber(event, 2) === stage;
}

function latestEvent(
  events: readonly ProtocolEvent[],
  kind: string,
  tx: RemoteTxEvent,
  nowMs: number,
  predicate: (event: ProtocolEvent) => boolean = () => true,
): ProtocolEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.eventKind === kind && inEventWindow(event, tx, nowMs) && predicate(event)) return event;
  }
  return null;
}

function latestMatchingActEvent(
  events: readonly ProtocolEvent[],
  kind: string,
  tx: RemoteTxEvent,
  nowMs: number,
  predicate: (event: ProtocolEvent) => boolean = () => true,
): ProtocolEvent | null {
  return latestEvent(events, kind, tx, nowMs, (event) => eventMatchesActCommand(event, tx) && predicate(event));
}

function latestMatchingActFeedbackEvent(
  events: readonly ProtocolEvent[],
  tx: RemoteTxEvent,
  nowMs: number,
  predicate: (event: ProtocolEvent) => boolean = () => true,
): ProtocolEvent | null {
  return latestEvent(events, "MECH_FB", tx, nowMs, (event) => eventMatchesActFeedback(event, tx) && predicate(event));
}

interface ActAckFeedback {
  score: number | null;
  state: number;
  stage: number;
  exec: number;
  enabled: number;
  matchesCommand: boolean;
}

function decodeActAckFeedback(event: RemoteTxEvent): ActAckFeedback | null {
  if (event.packetType !== "ACT" || event.ackLen < 6 || event.ackBytes[1] !== 0x5C) return null;
  const state = event.ackBytes[2]!;
  const stage = event.ackBytes[3]!;
  const exec = event.ackBytes[4]!;
  const enabled = event.ackBytes[5]!;
  return {
    score: event.ackBytes[0] ?? null,
    state,
    stage,
    exec,
    enabled,
    matchesCommand: state === event.args[0] && stage === event.args[1],
  };
}

function ackSummary(event: RemoteTxEvent): string {
  if (event.ackLen <= 0) return "无 ACK payload";
  const feedback = decodeActAckFeedback(event);
  if (!feedback) return `${event.ackLen} byte`;
  return `${event.ackLen} byte · ${feedback.matchesCommand ? "机构反馈对齐" : "可能是陈旧反馈"} · state=${feedback.state} · stage=${feedback.stage} · exec=${feedback.exec}`;
}

function ackStep(event: RemoteTxEvent): EffectStep {
  if (event.txRet === 0) return { key: "nrf_ack", label: "NRF ACK", status: "error", detail: "没有有效 ACK。" };
  if (event.txRet === 2) return { key: "nrf_ack", label: "NRF ACK", status: "warn", detail: "发送成功但 ACK payload 为空。" };
  if (event.ackLen <= 0) return { key: "nrf_ack", label: "NRF ACK", status: "warn", detail: "发送成功但 ACK payload 为空。" };
  const feedback = decodeActAckFeedback(event);
  if (feedback && feedback.matchesCommand) {
    return {
      key: "nrf_ack",
      label: "NRF ACK / 机构回传",
      status: "normal",
      detail: `遥控器 ACK 已收到机构反馈：score=${feedback.score ?? "—"} · state=${feedback.state} · stage=${feedback.stage} · exec=${feedback.exec} · enabled=${feedback.enabled}。`,
    };
  }
  if (feedback) {
    return {
      key: "nrf_ack",
      label: "NRF ACK / 机构回传",
      status: "warn",
      detail: `ACK 内反馈 state=${feedback.state} · stage=${feedback.stage} · exec=${feedback.exec} · enabled=${feedback.enabled}，与本次 ACT 的 state/stage 不一致，可能是上一条动作反馈。`,
    };
  }
  return { key: "nrf_ack", label: "NRF ACK", status: "normal", detail: `ACK payload ${event.ackLen} byte。` };
}

function receiveStep(event: RemoteTxEvent, chassis: ChassisFrame | null, events: readonly ProtocolEvent[], nowMs: number): EffectStep {
  if (!chassis) return { key: "chassis_receive", label: "底盘接收", status: "unknown", detail: "未连接底盘 CDBG，只能判断遥控器发送与 ACK。" };
  if (event.packetType === "ADC") return ageDetail("chassis_receive", numberField(chassis, "adcAgeMs"), "底盘接收 ADC");
  if (event.packetType === "MODE" || event.packetType === "VMODE") return ageDetail("chassis_receive", numberField(chassis, "modeFrameAgeMs"), "底盘接收 MODE");
  if (event.packetType === "KEY") return ageDetail("chassis_receive", numberField(chassis, "keyAgeMs"), "底盘接收 KEY");
  if (event.packetType === "ACT") {
    const cmdEvent = latestMatchingActEvent(events, "MECH_CMD", event, nowMs, (item) => eventNumber(item, 0) === 1 || eventNumber(item, 0) === 2);
    if (cmdEvent) return {
      key: "chassis_receive",
      label: "底盘接收 ACT",
      status: "normal",
      detail: `看到 MECH_CMD phase=${eventNumber(cmdEvent, 0)} · ${eventPayloadText(cmdEvent)}，${eventAge(cmdEvent, nowMs)}。`,
    };
    return ageDetail("chassis_receive", numberField(chassis, "taskFrameAgeMs"), "底盘接收 ACT");
  }
  if (event.packetType === "SIGTEST") {
    const alive = numberField(chassis, "linkAlive");
    const score = numberField(chassis, "rawScore");
    if (alive === null && score === null) return ageDetail("chassis_receive", numberField(chassis, "lastSigAgeMs"), "底盘接收 SIGTEST");
    return {
      key: "chassis_receive",
      label: "底盘接收 SIGTEST",
      status: alive === 1 ? "normal" : "error",
      detail: `link_alive=${alive ?? "—"} · raw_score=${score ?? "—"}`,
    };
  }
  return { key: "chassis_receive", label: "底盘接收", status: "unknown", detail: `未知包类型 ${event.packetType}。` };
}

function appliedStep(event: RemoteTxEvent, chassis: ChassisFrame | null, events: readonly ProtocolEvent[], nowMs: number): EffectStep {
  if (!chassis) return { key: "command_apply", label: "命令执行入口", status: "unknown", detail: "等待底盘 CDBG。" };
  if (event.packetType === "ACT") {
    const dequeueEvent = latestMatchingActEvent(events, "MECH_CMD", event, nowMs, (item) => eventNumber(item, 0) === 3);
    if (dequeueEvent) return {
      key: "command_apply",
      label: "ACT 队列",
      status: "normal",
      detail: `已从 action 队列出队 · ${eventPayloadText(dequeueEvent)} · q=${eventNumber(dequeueEvent, 5) ?? "—"}，${eventAge(dequeueEvent, nowMs)}。`,
    };
    const enqueueEvent = latestMatchingActEvent(events, "MECH_CMD", event, nowMs, (item) => eventNumber(item, 0) === 1 || eventNumber(item, 0) === 2);
    if (enqueueEvent && eventNumber(enqueueEvent, 0) === 2) return {
      key: "command_apply",
      label: "ACT 队列",
      status: "error",
      detail: `底盘收到但 action 入队失败 · ${eventPayloadText(enqueueEvent)} · q=${eventNumber(enqueueEvent, 5) ?? "—"}，${eventAge(enqueueEvent, nowMs)}。`,
    };
    if (enqueueEvent) return {
      key: "command_apply",
      label: "ACT 队列",
      status: "normal",
      detail: `已进入 action 队列 · ${eventPayloadText(enqueueEvent)} · q=${eventNumber(enqueueEvent, 5) ?? "—"}，等待出队事件。`,
    };
    const drop = numberField(chassis, "actionEnqueueDropCount");
    const outAge = numberField(chassis, "actionDequeueAgeMs");
    const ok = numberField(chassis, "actionEnqueueOkCount");
    if (drop !== null && drop > 0) return { key: "command_apply", label: "ACT 队列", status: "warn", detail: `action drop=${drop}，需看同一时刻 MECH_CMD。` };
    if (outAge !== null && outAge <= 1000) return { key: "command_apply", label: "ACT 队列", status: "normal", detail: `已出队，age=${outAge} ms · enqueue_ok=${ok ?? "—"}` };
    return { key: "command_apply", label: "ACT 队列", status: "unknown", detail: `enqueue_ok=${ok ?? "—"} · dequeue_age=${outAge ?? "—"} ms` };
  }
  if (event.packetType === "MODE" || event.packetType === "VMODE") {
    const queue = numberField(chassis, "stateQ");
    const drop = numberField(chassis, "stateEnqueueDropCount");
    const age = numberField(chassis, "lastStateApplyAgeMs");
    if (queue !== null && queue > 0) return { key: "command_apply", label: "模式应用", status: "error", detail: `状态队列积压 ${queue}。` };
    if (drop !== null && drop > 0) return { key: "command_apply", label: "模式应用", status: "warn", detail: `状态入队 drop=${drop}。` };
    if (age !== null && age <= 1000) return { key: "command_apply", label: "模式应用", status: "normal", detail: `最近应用 age=${age} ms。` };
    return { key: "command_apply", label: "模式应用", status: "unknown", detail: `last_apply_age=${age ?? "—"} ms。` };
  }
  if (event.packetType === "KEY") return ageDetail("command_apply", numberField(chassis, "keyAgeMs"), "按键入口");
  if (event.packetType === "ADC") return ageDetail("command_apply", numberField(chassis, "joyAgeMs") ?? numberField(chassis, "adcAgeMs"), "摇杆/ADC入口", 250, 800);
  return { key: "command_apply", label: "命令执行入口", status: "unknown", detail: "该包只用于链路/同步观测。" };
}

function usartStep(event: RemoteTxEvent, chassis: ChassisFrame | null, events: readonly ProtocolEvent[], nowMs: number): EffectStep {
  if (event.packetType !== "ACT") return { key: "usart1_tx", label: "USART1 发给机构", status: "unknown", detail: "非 ACT 命令不经过机构 USART1。" };
  if (!chassis) return { key: "usart1_tx", label: "USART1 发给机构", status: "unknown", detail: "未连接底盘 CDBG，无法判断 USART1。" };
  const doneEvent = latestMatchingActEvent(events, "MECH_TX", event, nowMs, (item) => eventNumber(item, 0) === 2);
  if (doneEvent) {
    const status = eventNumber(doneEvent, 5);
    const duration = eventNumber(doneEvent, 6);
    return {
      key: "usart1_tx",
      label: "USART1 发给机构",
      status: status === 0 ? "normal" : "error",
      detail: `MECH_TX done · ${eventPayloadText(doneEvent)} · HAL=${status ?? "—"} · ${duration ?? "—"} ms，${eventAge(doneEvent, nowMs)}。`,
    };
  }
  const startEvent = latestMatchingActEvent(events, "MECH_TX", event, nowMs, (item) => eventNumber(item, 0) === 1);
  if (startEvent) return {
    key: "usart1_tx",
    label: "USART1 发给机构",
    status: "warn",
    detail: `看到 MECH_TX start，但还没有 done 事件，${eventAge(startEvent, nowMs)}。`,
  };
  const inFlight = numberField(chassis, "mechTxInFlightAgeMs");
  const lastStatus = numberField(chassis, "mechTxLastStatus");
  const fail = numberField(chassis, "mechTxFailCount");
  const ok = numberField(chassis, "mechTxOkCount");
  const duration = numberField(chassis, "mechTxLastDurationMs");
  if (inFlight !== null && inFlight > 1000) return { key: "usart1_tx", label: "USART1 发给机构", status: "error", detail: `USART1 发送 in-flight ${inFlight} ms，疑似阻塞。` };
  if (lastStatus !== null && lastStatus !== 0) return { key: "usart1_tx", label: "USART1 发给机构", status: "error", detail: `最近 USART1 HAL status=${lastStatus}。` };
  if (ok !== null && ok > 0) return { key: "usart1_tx", label: "USART1 发给机构", status: "normal", detail: `MECH_TX done HAL=0 · ${duration ?? "—"} ms（CDBG 汇总）。` };
  if (fail !== null && fail > 0) return { key: "usart1_tx", label: "USART1 发给机构", status: "warn", detail: `历史发送失败 ${fail} 次，需看最近 MECH_TX。` };
  return { key: "usart1_tx", label: "USART1 发给机构", status: "unknown", detail: "尚未看到 MECH_TX；等待底盘 v3 事件或 CDBG 汇总。" };
}

function mechanismStep(event: RemoteTxEvent, chassis: ChassisFrame | null, events: readonly ProtocolEvent[], nowMs: number): EffectStep {
  if (event.packetType !== "ACT") return { key: "mechanism_feedback", label: "机构反馈", status: "unknown", detail: "非 ACT 命令不经过机构链路。" };
  if (!chassis) return { key: "mechanism_feedback", label: "机构反馈", status: "unknown", detail: "未连接底盘 CDBG，无法判断机构反馈。" };
  const feedbackEvent = latestMatchingActFeedbackEvent(events, event, nowMs);
  if (feedbackEvent) {
    const phase = eventNumber(feedbackEvent, 0);
    if (phase === 1) return {
      key: "mechanism_feedback",
      label: "机构反馈",
      status: "normal",
      detail: `机构回传 ${eventPayloadText(feedbackEvent)} · checksum=${eventNumber(feedbackEvent, 5) ?? "—"}，${eventAge(feedbackEvent, nowMs)}。`,
    };
    if (phase === 2) return {
      key: "mechanism_feedback",
      label: "机构反馈",
      status: "warn",
      detail: `机构回传 ${eventPayloadText(feedbackEvent)}，但 realaction 队列入队失败，${eventAge(feedbackEvent, nowMs)}。`,
    };
  }
  const badFeedback = latestEvent(events, "MECH_FB", event, nowMs, (item) => eventNumber(item, 0) === 3);
  if (badFeedback) return { key: "mechanism_feedback", label: "机构反馈", status: "error", detail: `MECH_FB 校验失败 calc=${eventNumber(badFeedback, 5) ?? "—"} rx=${eventNumber(badFeedback, 6) ?? "—"}。` };
  const fbAge = numberField(chassis, "mechFeedbackAgeMs");
  const rxAge = numberField(chassis, "uart1RxByteAgeMs");
  if (fbAge !== null && fbAge <= 1500) return { key: "mechanism_feedback", label: "机构反馈", status: "normal", detail: `机构有效反馈 age=${fbAge} ms。` };
  if (fbAge !== null && fbAge > 3000) return { key: "mechanism_feedback", label: "机构反馈", status: "error", detail: `${fbAge} ms 未看到有效机构反馈。` };
  if (fbAge !== null) return { key: "mechanism_feedback", label: "机构反馈", status: "warn", detail: `${fbAge} ms 未看到有效机构反馈。` };
  if (rxAge !== null && rxAge <= 1500) return { key: "mechanism_feedback", label: "机构反馈", status: "warn", detail: `USART1 有字节 age=${rxAge} ms，但未形成有效反馈。` };
  return { key: "mechanism_feedback", label: "机构反馈", status: "unknown", detail: "尚未看到机构反馈；单发安全 ACT 后观察。" };
}

export function buildRemoteCommandView(
  remote: RemoteFrame | null,
  chassis: ChassisFrame | null,
  tx: RemoteTxEvent | null,
  nowMs: number,
  chassisEvents: readonly ProtocolEvent[] = [],
): RemoteCommandView {
  const liveRemote = fresh(remote, nowMs);
  const liveChassis = fresh(chassis, nowMs);
  const liveTx = fresh(tx, nowMs, 4000);
  if (!liveTx) {
    const status: RemoteCommandStatus = liveRemote ? "warn" : "unknown";
    return {
      headlineLabel: liveRemote ? "当前真实 TX" : "当前命令",
      title: liveRemote ? `RDBG ${liveRemote.packetType}` : "等待遥控器命令",
      subtitle: liveRemote ? "当前固件未输出 RDBG_TX；请烧录本次交付的遥控器完整 SHA 后再采集。" : "请先在通信诊断连接遥控器 RDBG。",
      primaryStatus: status,
      txResult: liveRemote ? `tx_ret=${liveRemote.txRet}` : "—",
      ackResult: liveRemote ? `ack_len=${liveRemote.ackLen}` : "—",
      ageMs: liveRemote ? nowMs - liveRemote.observedAtMs : null,
      txHex: "—",
      ackHex: "—",
      args: [],
      steps: [
        { key: "remote_tx", label: "遥控器发送", status, detail: liveRemote ? "RDBG 正常刷新，但缺少 RDBG_TX payload。" : "没有遥控器帧。" },
        { key: "chassis_receive", label: "底盘接收", status: liveChassis ? "unknown" : "unknown", detail: liveChassis ? "等待 RDBG_TX 后进行关联判断。" : "未连接底盘 CDBG。" },
      ],
      notice: liveRemote ? "当前固件未输出 RDBG_TX；请烧录本次交付的遥控器完整 SHA 后再采集。" : null,
    };
  }

  const txStatus: RemoteCommandStatus = liveTx.txRet === 0 ? "error" : "normal";
  const ack = ackStep(liveTx);
  const steps: EffectStep[] = [
    { key: "remote_tx", label: "遥控器发送", status: txStatus, detail: liveTx.txRet === 0 ? "NRF 返回失败/MAX_RT/超时。" : `tx_ret=${liveTx.txRet}，retry=${liveTx.retry}，lost=${liveTx.lost}` },
    ack,
    receiveStep(liveTx, liveChassis, chassisEvents, nowMs),
    appliedStep(liveTx, liveChassis, chassisEvents, nowMs),
    usartStep(liveTx, liveChassis, chassisEvents, nowMs),
    mechanismStep(liveTx, liveChassis, chassisEvents, nowMs),
  ];
  const primaryStatus = steps.reduce<RemoteCommandStatus>((worst, step) => STATUS_RANK[step.status] > STATUS_RANK[worst] ? step.status : worst, "unknown");
  const commandTitle = liveTx.packetType === "ACT"
    ? `ACT ${actPayloadText(liveTx)} (#${liveTx.seq})`
    : `${liveTx.packetType} #${liveTx.seq}`;
  return {
    headlineLabel: liveTx.packetType === "ACT" ? "当前动作指令" : "当前真实 TX",
    title: commandTitle,
    subtitle: `${statusText(primaryStatus)} · ${nowMs - liveTx.observedAtMs} ms 前发送`,
    primaryStatus,
    txResult: liveTx.txRet === 0 ? "发送失败" : liveTx.txRet === 1 ? "发送成功 + ACK" : "发送成功 · 空 ACK",
    ackResult: ackSummary(liveTx),
    ageMs: nowMs - liveTx.observedAtMs,
    txHex: formatHexBytes(liveTx.txBytes),
    ackHex: formatHexBytes(liveTx.ackBytes),
    args: commandArgs(liveTx),
    steps,
    notice: liveChassis ? null : "未连接底盘 CDBG：当前只能判断遥控器发包和 NRF ACK，不能判断底盘/机构效果。",
  };
}

export function buildMechanismLiveView(
  chassis: ChassisFrame | null,
  events: readonly ProtocolEvent[],
  nowMs: number,
): MechanismLiveView {
  const liveChassis = fresh(chassis, nowMs);
  if (!liveChassis) {
    return {
      primaryStatus: "unknown",
      title: "等待底盘机构反馈",
      subtitle: "未连接实时 CDBG/CEVT，无法判断底盘是否收到 ACT 或机构是否回传。",
      notice: "请同时连接底盘 CDBG 串口；机构 state/stage/exec/enabled 由底盘 USART1 反馈事件转发到网页。",
      cards: [
        summaryCard("cmd", "底盘 ACT", "unknown", "未连接", "等待底盘 CDBG。"),
        summaryCard("tx", "USART1 TX", "unknown", "未连接", "等待底盘 CDBG。"),
        summaryCard("fb", "机构回传", "unknown", "未连接", "等待底盘 CDBG。"),
        summaryCard("uart", "UART1 状态", "unknown", "未连接", "等待底盘 CDBG。"),
      ],
    };
  }

  const cmdEvent = latestKindEvent(events, "MECH_CMD");
  const txEvent = latestKindEvent(events, "MECH_TX");
  const fbEvent = latestKindEvent(events, "MECH_FB");
  const uartEvent = latestKindEvent(events, "UART1_ERR");
  const cards: MechanismLiveCard[] = [];

  if (cmdEvent) {
    const phase = eventNumber(cmdEvent, 0);
    const q = eventNumber(cmdEvent, 5);
    const status: RemoteCommandStatus = phase === 2 ? "error" : "normal";
    const title = phase === 1 ? "底盘收到 ACT 并入队" : phase === 2 ? "底盘收到 ACT 但入队失败" : phase === 3 ? "Commun 已取出 ACT" : "底盘 ACT 事件";
    cards.push(summaryCard(
      "cmd",
      "底盘 ACT",
      status,
      title,
      `q=${q ?? "—"} · ${eventAge(cmdEvent, nowMs)}`,
      tupleArgs(cmdEvent),
    ));
  } else {
    const age = numberField(liveChassis, "taskFrameAgeMs");
    const ok = numberField(liveChassis, "actionEnqueueOkCount");
    cards.push(summaryCard(
      "cmd",
      "底盘 ACT",
      age !== null && age <= 1500 ? "normal" : "unknown",
      ok !== null && ok > 0 ? "有 ACT 汇总计数" : "尚未看到 ACT 事件",
      `task_age=${age ?? "—"} ms · enqueue_ok=${ok ?? "—"}`,
    ));
  }

  if (txEvent) {
    const phase = eventNumber(txEvent, 0);
    const statusCode = eventNumber(txEvent, 5);
    const duration = eventNumber(txEvent, 6);
    const status: RemoteCommandStatus = phase === 1 ? "warn" : statusCode === 0 ? "normal" : "error";
    const title = phase === 1 ? "正在发给机构" : statusCode === 0 ? "已发给机构" : `发送异常 HAL=${statusCode ?? "—"}`;
    cards.push(summaryCard(
      "tx",
      "USART1 TX",
      status,
      title,
      `duration=${duration ?? "—"} ms · ${eventAge(txEvent, nowMs)}`,
      tupleArgs(txEvent),
    ));
  } else {
    const ok = numberField(liveChassis, "mechTxOkCount");
    const fail = numberField(liveChassis, "mechTxFailCount");
    const inFlight = numberField(liveChassis, "mechTxInFlightAgeMs");
    cards.push(summaryCard(
      "tx",
      "USART1 TX",
      inFlight !== null && inFlight > 1000 ? "error" : fail !== null && fail > 0 ? "warn" : ok !== null && ok > 0 ? "normal" : "unknown",
      inFlight !== null && inFlight > 1000 ? "USART1 发送疑似阻塞" : ok !== null && ok > 0 ? "有发送汇总" : "尚未看到发送事件",
      `ok=${ok ?? "—"} · fail=${fail ?? "—"} · in_flight=${inFlight ?? "—"} ms`,
    ));
  }

  if (fbEvent) {
    const phase = eventNumber(fbEvent, 0);
    const calc = eventNumber(fbEvent, 5);
    const rx = eventNumber(fbEvent, 6);
    const status: RemoteCommandStatus = phase === 1 ? "normal" : phase === 2 ? "warn" : "error";
    const title = phase === 1 ? "机构有效回传" : phase === 2 ? "机构回传有效但底盘反馈队列 drop" : "机构回传校验失败";
    cards.push(summaryCard(
      "fb",
      "机构回传",
      status,
      title,
      `checksum calc=${calc ?? "—"} rx=${rx ?? "—"} · ${eventAge(fbEvent, nowMs)}`,
      tupleArgs(fbEvent),
    ));
  } else {
    const age = numberField(liveChassis, "mechFeedbackAgeMs");
    const ok = numberField(liveChassis, "mechFeedbackOkCount");
    const bad = numberField(liveChassis, "mechFeedbackBadCount");
    cards.push(summaryCard(
      "fb",
      "机构回传",
      age !== null && age <= 1500 ? "normal" : age !== null && age > 3000 ? "error" : ok !== null && ok > 0 ? "warn" : "unknown",
      ok !== null && ok > 0 ? "有机构反馈汇总" : "尚未看到机构反馈",
      `feedback_age=${age ?? "—"} ms · ok=${ok ?? "—"} · bad=${bad ?? "—"}`,
    ));
  }

  const uartError = numberField(liveChassis, "uart1ErrorCode");
  const uartErrorCount = numberField(liveChassis, "uart1ErrorCount");
  const uartRxAge = numberField(liveChassis, "uart1RxByteAgeMs");
  cards.push(summaryCard(
    "uart",
    "UART1 状态",
    uartEvent || (uartError !== null && uartError !== 0) ? "error" : "normal",
    uartEvent ? "最近出现 UART1 错误" : "UART1 错误码正常",
    uartEvent
      ? `err=0x${String(eventNumber(uartEvent, 0) ?? "—")} · ${eventAge(uartEvent, nowMs)}`
      : `err=0x${Number(uartError ?? 0).toString(16)} · error_count=${uartErrorCount ?? "—"} · rx_age=${uartRxAge ?? "—"} ms`,
    [
      { label: "gState", value: String(numberField(liveChassis, "uart1GState") ?? "—") },
      { label: "rxState", value: String(numberField(liveChassis, "uart1RxState") ?? "—") },
      { label: "rxBytes", value: String(numberField(liveChassis, "uart1RxByteCount") ?? "—") },
      { label: "rearmFail", value: String(numberField(liveChassis, "uart1RearmFailCount") ?? "—") },
    ],
  ));

  const primaryStatus = cards.reduce<RemoteCommandStatus>((worst, card) => STATUS_RANK[card.status] > STATUS_RANK[worst] ? card.status : worst, "unknown");
  return {
    primaryStatus,
    title: fbEvent ? "机构反馈已回传到网页" : "等待机构反馈事件",
    subtitle: fbEvent ? `最近反馈 ${eventAge(fbEvent, nowMs)}；重点看 state/stage/exec/enabled 是否符合当前动作。` : "可通过底盘 CDBG 汇总先判断 USART1 与反馈是否活跃。",
    notice: null,
    cards,
  };
}
