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

function eventAge(event: ProtocolEvent, nowMs: number): string {
  return `${Math.max(0, nowMs - event.observedAtMs)} ms 前`;
}

function inEventWindow(event: ProtocolEvent, tx: RemoteTxEvent, nowMs: number): boolean {
  return event.observedAtMs >= tx.observedAtMs - ACT_EVENT_WINDOW_BEFORE_MS &&
    nowMs - event.observedAtMs <= ACT_EVENT_WINDOW_AFTER_MS;
}

function eventMatchesAct(event: ProtocolEvent, tx: RemoteTxEvent): boolean {
  if (tx.packetType !== "ACT") return false;
  const [state, stage, exec, enabled] = tx.args;
  return eventNumber(event, 1) === state &&
    eventNumber(event, 2) === stage &&
    eventNumber(event, 3) === exec &&
    eventNumber(event, 4) === enabled;
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
  return latestEvent(events, kind, tx, nowMs, (event) => eventMatchesAct(event, tx) && predicate(event));
}

function actAckEchoMatches(event: RemoteTxEvent): boolean | null {
  if (event.packetType !== "ACT" || event.ackLen === 0) return null;
  return event.ackLen >= 6 &&
    event.ackBytes[1] === 0x5C &&
    event.args.every((value, index) => event.ackBytes[index + 2] === value);
}

function ackStep(event: RemoteTxEvent): EffectStep {
  const echo = actAckEchoMatches(event);
  if (event.txRet === 0) return { key: "nrf_ack", label: "NRF ACK", status: "error", detail: "没有有效 ACK。" };
  if (event.txRet === 2) return { key: "nrf_ack", label: "NRF ACK", status: "warn", detail: "发送成功但 ACK payload 为空。" };
  if (event.ackLen <= 0) return { key: "nrf_ack", label: "NRF ACK", status: "warn", detail: "发送成功但 ACK payload 为空。" };
  if (echo === false) return { key: "nrf_ack", label: "NRF ACK", status: "warn", detail: "ACT ACK payload 未回显相同 state/stage/exec/enabled。" };
  if (echo === true) return { key: "nrf_ack", label: "NRF ACK", status: "normal", detail: `ACK echo 匹配 ${formatCommandArgs(event)}。` };
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
      detail: `看到 MECH_CMD phase=${eventNumber(cmdEvent, 0)}，${eventAge(cmdEvent, nowMs)}。`,
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
      detail: `已从 action 队列出队，q=${eventNumber(dequeueEvent, 5) ?? "—"}，${eventAge(dequeueEvent, nowMs)}。`,
    };
    const enqueueEvent = latestMatchingActEvent(events, "MECH_CMD", event, nowMs, (item) => eventNumber(item, 0) === 1 || eventNumber(item, 0) === 2);
    if (enqueueEvent && eventNumber(enqueueEvent, 0) === 2) return {
      key: "command_apply",
      label: "ACT 队列",
      status: "error",
      detail: `底盘收到但 action 入队失败，q=${eventNumber(enqueueEvent, 5) ?? "—"}，${eventAge(enqueueEvent, nowMs)}。`,
    };
    if (enqueueEvent) return {
      key: "command_apply",
      label: "ACT 队列",
      status: "normal",
      detail: `已进入 action 队列，q=${eventNumber(enqueueEvent, 5) ?? "—"}，等待出队事件。`,
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
      detail: `MECH_TX done HAL=${status ?? "—"} · ${duration ?? "—"} ms，${eventAge(doneEvent, nowMs)}。`,
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
  const feedbackEvent = latestMatchingActEvent(events, "MECH_FB", event, nowMs);
  if (feedbackEvent) {
    const phase = eventNumber(feedbackEvent, 0);
    if (phase === 1) return { key: "mechanism_feedback", label: "机构反馈", status: "normal", detail: `MECH_FB 有效反馈，checksum=${eventNumber(feedbackEvent, 5) ?? "—"}，${eventAge(feedbackEvent, nowMs)}。` };
    if (phase === 2) return { key: "mechanism_feedback", label: "机构反馈", status: "warn", detail: `机构反馈有效但 realaction 队列入队失败，${eventAge(feedbackEvent, nowMs)}。` };
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
  const echo = actAckEchoMatches(liveTx);
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
  return {
    headlineLabel: liveTx.packetType === "ACT" ? "当前动作指令" : "当前真实 TX",
    title: `${liveTx.packetType} #${liveTx.seq}`,
    subtitle: `${statusText(primaryStatus)} · ${nowMs - liveTx.observedAtMs} ms 前发送`,
    primaryStatus,
    txResult: liveTx.txRet === 0 ? "发送失败" : liveTx.txRet === 1 ? "发送成功 + ACK" : "发送成功 · 空 ACK",
    ackResult: liveTx.ackLen > 0 ? `${liveTx.ackLen} byte${echo === true ? " · echo 匹配" : echo === false ? " · echo 不匹配" : ""}` : "无 ACK payload",
    ageMs: nowMs - liveTx.observedAtMs,
    txHex: formatHexBytes(liveTx.txBytes),
    ackHex: formatHexBytes(liveTx.ackBytes),
    args: commandArgs(liveTx),
    steps,
    notice: liveChassis ? null : "未连接底盘 CDBG：当前只能判断遥控器发包和 NRF ACK，不能判断底盘/机构效果。",
  };
}
