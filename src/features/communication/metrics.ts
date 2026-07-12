import type { ChassisFrame, RemoteFrame } from "../../protocols";
import { chassisNrfStatus, diagnoseLink, locationStatus, modeStateMismatch, remoteLinkStatus } from "./diagnosis";

export type DiagnosticStatus = "normal" | "warn" | "error" | "unknown";

export const STATUS_COLORS: Readonly<Record<DiagnosticStatus, string>> = {
  normal: "#32d583", warn: "#ffc240", error: "#ff5260", unknown: "#91a4b7",
};

export const STATUS_LABELS: Readonly<Record<DiagnosticStatus, string>> = {
  normal: "正常", warn: "警告", error: "异常", unknown: "未连接",
};

export interface MetricTooltip {
  meaning: string;
  normal: string;
  abnormal: string;
  check: string;
  source: string;
}

export interface MetricContext {
  remote: RemoteFrame | null;
  chassis: ChassisFrame | null;
}

export interface MetricSpec<T = unknown> {
  key: string;
  title: string;
  variable: string;
  unit: string;
  tooltip: MetricTooltip;
  getter(context: MetricContext): T;
  formatter(value: T): string;
  evaluator?(value: T, context: MetricContext): DiagnosticStatus;
}

const tip = (meaning: string, normal: string, abnormal: string, check: string, source: string): MetricTooltip =>
  ({ meaning, normal, abnormal, check, source });
const missing = (value: unknown): boolean => value === null || value === undefined || value === "";
const tupleMissing = (value: unknown): boolean => Array.isArray(value) && value.some(missing);
const int = (value: unknown): string => missing(value) ? "—" : String(Math.trunc(Number(value)));
const bool = (value: unknown): string => missing(value) ? "—" : Number(value) ? "是" : "否";
const text = (value: unknown): string => missing(value) ? "—" : String(value);
const fixed = (value: unknown): string => missing(value) ? "—" : Number(value).toFixed(2);
const tuple = (value: unknown, digits = 2): string => !Array.isArray(value) || tupleMissing(value)
  ? "—" : value.map((item) => Number(item).toFixed(digits)).join(" / ");
const pose = (value: unknown): string => !Array.isArray(value) || tupleMissing(value)
  ? "—" : `x=${Number(value[0]).toFixed(2)}, y=${Number(value[1]).toFixed(2)}, yaw=${Number(value[2]).toFixed(2)}`;
const field = (chassis: ChassisFrame | null, name: string): string | number | null => chassis?.[name] ?? null;
const fields = (chassis: ChassisFrame | null, ...names: string[]): Array<string | number | null> => names.map((name) => field(chassis, name));
const ageStatus = (value: unknown, warn: number, error: number): DiagnosticStatus => missing(value)
  ? "unknown" : Number(value) > error ? "error" : Number(value) > warn ? "warn" : "normal";
const countStatus = (value: unknown): DiagnosticStatus => missing(value) ? "unknown" : Number(value) > 0 ? "error" : "normal";
const simple = (key: string, title: string, variable: string, unit: string, tooltip: MetricTooltip,
  getter: MetricSpec["getter"], formatter: MetricSpec["formatter"] = int,
  evaluator?: MetricSpec["evaluator"]): MetricSpec => ({ key, title, variable, unit, tooltip, getter, formatter, evaluator });

export const remoteMetricSpecs: readonly MetricSpec[] = [
  simple("signal_bars", "信号格", "signal_bars", "格", tip("遥控器 UI 的 NRF 信号强度，0 时显示 X。", "3–4 格", "0 为断链，1–2 为弱链路。", "检查距离、天线、信道及底盘 FAST SCAN。", "RemoteFrame.signal_bars / g_ui_signal_bars"),
    ({ remote }) => remote?.signalBars ?? null, int, (v) => missing(v) ? "unknown" : Number(v) === 0 ? "error" : Number(v) <= 2 ? "warn" : "normal"),
  simple("x_reason", "X 原因", "x_reason", "", tip("遥控器判定 X 的直接原因。", "none", "fail_count、no_ack_timeout 或 never_ack。", "检查连续失败、ACK 超时、地址和信道。", "RemoteFrame.x_reason"),
    ({ remote }) => remote?.xReason ?? null, text, (v) => missing(v) ? "unknown" : v === "none" ? "normal" : "error"),
  simple("rf_ch", "遥控器信道", "rf_ch", "", tip("遥控器当前 NRF 射频信道。", "与底盘 nrf_ch 一致。", "持续不一致。", "检查跳频同步、调试地址和固件版本。", "RemoteFrame.rf_ch"), ({ remote }) => remote?.rfCh ?? null),
  simple("fail_count", "连续失败", "fail_count", "次", tip("连续 NRF 发送或 ACK 失败次数。", "0", "持续增长或达到 LOST。", "检查底盘供电、NRF 地址、信道和 SPI。", "RemoteFrame.fail_count"), ({ remote }) => remote?.failCount ?? null, int, (v) => missing(v) ? "unknown" : Number(v) === 0 ? "normal" : "warn"),
  simple("no_ack_ms", "无 ACK 时间", "no_ack_ms", "ms", tip("距离上一次有效 ACK 的时间。", "<100 ms", "100–299 ms 警告，≥300 ms 超时。", "检查 ACK payload、FAST SCAN 和信道错位。", "RemoteFrame.no_ack_ms"), ({ remote }) => remote?.noAckMs ?? null, int, (v) => missing(v) ? "unknown" : Number(v) >= 300 ? "error" : Number(v) >= 100 ? "warn" : "normal"),
  simple("ack_len", "ACK 长度", "ack_len", "byte", tip("收到的 ACK payload 长度。", ">0", "长期为 0 且链路异常。", "检查动态 payload 和底盘 ACK 写入。", "RemoteFrame.ack_len"), ({ remote }) => remote?.ackLen ?? null, int, (v) => missing(v) ? "unknown" : Number(v) > 0 ? "normal" : "warn"),
  simple("tx_ret", "发送返回", "tx_ret", "", tip("NRF 发送函数返回值。", "1 或约定成功值。", "连续异常且 fail_count 增长。", "检查 MAX_RT、CE/CSN 和 SPI。", "RemoteFrame.tx_ret"), ({ remote }) => remote?.txRet ?? null),
  simple("rx_score", "接收评分", "rx_score", "", tip("遥控器端 ACK 链路质量评分。", "高且稳定。", "持续下降或剧烈波动。", "检查距离、遮挡、干扰和底盘 ACK。", "RemoteFrame.rx_score"), ({ remote }) => remote?.rxScore ?? null),
  simple("link_ready", "链路就绪", "link_ready", "", tip("链路是否达到 ready 条件。", "是", "长时间否。", "检查底盘响应、ready 阈值、地址和信道。", "RemoteFrame.link_ready"), ({ remote }) => remote?.linkReady ?? null, bool),
  simple("link_online", "链路在线", "link_online", "", tip("遥控器认为当前 NRF 链路在线。", "是", "否或频繁跳变。", "检查 ACK 超时、连续失败和信道错位。", "RemoteFrame.link_online"), ({ remote }) => remote?.linkOnline ?? null, bool),
  simple("packet_type", "包类型", "packet_type", "", tip("遥控器当前发送的 NRF 包类型。", "随当前操作变化。", "长期异常或缺失。", "检查任务调度、按键和摇杆输入。", "RemoteFrame.packet_type"), ({ remote }) => remote?.packetType ?? null, text),
];

const motion = (value: unknown): string => {
  if (missing(value)) return "—";
  const number = Number(value); const name = ({ 0: "none", 1: "remote", 2: "lock", 3: "point", 4: "merlin", 5: "three_zone", 6: "test_spin" } as Record<number, string>)[number] ?? "unknown";
  return `${name} (${number})`;
};
const audio = (value: unknown): string => {
  if (missing(value)) return "—";
  const number = Number(value); const name = ({ 0: "none", 1: "key8", 2: "remote_v_key", 3: "three_zone_sound", 4: "three_zone_display" } as Record<number, string>)[number] ?? "unknown";
  return `${name} (${number})`;
};
const sourceTip = (meaning: string, normal: string, abnormal: string, check: string, source: string) => tip(meaning, normal, abnormal, check, source);

export const chassisNrfMetricSpecs: readonly MetricSpec[] = [
  simple("diagnosis_summary", "Diagnosis", "derived", "", sourceTip("跨 Remote/Chassis 的综合诊断。", "链路和包年龄均正常。", "显示当前最高优先级异常。", "按诊断文字检查对应链路。", "RemoteFrame + ChassisFrame"), diagnoseLink, (v) => (v as ReturnType<typeof diagnoseLink>).text, (v) => (v as ReturnType<typeof diagnoseLink>).status),
  simple("cdbg_version", "CDBG version", "protocol_version / field_count", "", sourceTip("当前 CDBG 协议版本和字段数。", "v2，90 fields。", "旧布局可能缺少高级诊断字段。", "确认底盘 debug 固件版本。", "ChassisFrame.protocolVersion/fieldCount"), ({ chassis }) => chassis ? [field(chassis, "protocolVersion"), field(chassis, "fieldCount")] : null, (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `v${v[0]}, ${v[1]} fields`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[0]) >= 2 && Number(v[1]) >= 90 ? "normal" : "warn"),
  simple("nrf_scan_state", "NRF scan state", "nrf_scan_state", "", sourceTip("底盘 NRF 扫频状态。", "非 0 的锁定/工作状态。", "0 表示快速扫频。", "检查信道、遥控器发包和 NRF 接收。", "ChassisFrame.nrfScanState"), ({ chassis }) => field(chassis, "nrfScanState"), int, (v) => missing(v) ? "unknown" : Number(v) === 0 ? "warn" : "normal"),
  simple("nrf_ch", "NRF channel", "nrf_ch", "", sourceTip("底盘最近收到 T 包的信道。", "与遥控器 rf_ch 一致。", "≥250 未知或与遥控器不一致。", "检查跳频同步和字段来源。", "ChassisFrame.nrfCh"), ({ chassis }) => field(chassis, "nrfCh"), int, (v, c) => missing(v) || Number(v) >= 250 ? "unknown" : c.remote && c.remote.rfCh !== Number(v) ? "warn" : "normal"),
  simple("last_sig_age_ms", "Last signal age", "last_sig_age_ms", "ms", sourceTip("最近信号包年龄。", "≤300 ms", "301–500 ms 警告，>500 ms 异常。", "检查底盘 NRF 收包与扫频。", "ChassisFrame.lastSigAgeMs"), ({ chassis }) => field(chassis, "lastSigAgeMs"), int, (v) => ageStatus(v, 300, 500)),
  simple("packet_loss_rate", "Packet loss", "packet_loss_rate", "%", sourceTip("滑动窗口丢包率。", "≤20%", ">20% 警告，≥80% 异常。", "检查距离、遮挡、供电和干扰。", "ChassisFrame.packetLossRate"), ({ chassis }) => field(chassis, "packetLossRate"), (v) => missing(v) ? "—" : `${(Number(v) * 100).toFixed(1)}%`, (v) => missing(v) ? "unknown" : Number(v) >= .8 ? "error" : Number(v) > .2 ? "warn" : "normal"),
  simple("nrf_update_max_ms", "NRF update max", "nrf_update_max_ms", "ms", sourceTip("NRF 更新循环最大耗时。", "<100 ms", "≥100 ms。", "检查任务阻塞和中断负载。", "ChassisFrame.nrfUpdateMaxMs"), ({ chassis }) => field(chassis, "nrfUpdateMaxMs"), int, (v) => missing(v) ? "unknown" : Number(v) >= 100 ? "warn" : "normal"),
  simple("nrf_ack_max_ms", "NRF ACK max", "nrf_ack_max_ms", "ms", sourceTip("ACK payload 更新最大耗时。", "<100 ms", "≥100 ms。", "检查 ACK 写入与任务调度。", "ChassisFrame.nrfAckMaxMs"), ({ chassis }) => field(chassis, "nrfAckMaxMs"), int, (v) => missing(v) ? "unknown" : Number(v) >= 100 ? "warn" : "normal"),
  simple("joy_age_ms", "Joystick age", "joy_age_ms", "ms", sourceTip("最近连续摇杆包年龄。", "≤300 ms", "301–500 ms 警告，>500 ms 异常。", "先检查 NRF 包流，再检查运动逻辑。", "ChassisFrame.joyAgeMs"), ({ chassis }) => field(chassis, "joyAgeMs"), int, (v) => ageStatus(v, 300, 500)),
  simple("joy_valid", "Joystick valid", "joy_valid", "", sourceTip("当前摇杆数据是否有效。", "是", "否。", "检查包类型、年龄和校验。", "ChassisFrame.joyValid"), ({ chassis }) => field(chassis, "joyValid"), bool, (v) => missing(v) ? "unknown" : Number(v) ? "normal" : "warn"),
  simple("cmd_vel", "Command velocity", "cmd_vx / cmd_vy / cmd_wz", "", sourceTip("底盘当前速度命令。", "与遥控输入及模式一致。", "无输入时持续非零或有输入时全零。", "检查 motion source 和模式状态。", "ChassisFrame.cmdVx/cmdVy/cmdWz"), ({ chassis }) => fields(chassis, "cmdVx", "cmdVy", "cmdWz"), (v) => tuple(v, 3)),
  simple("motion_source", "Motion source", "motion_source", "", sourceTip("当前轮组运动命令来源。", "none 或 remote。", "其他来源可能覆盖遥控。", "检查模式包、走点和三区逻辑。", "ChassisFrame.motionSource"), ({ chassis }) => field(chassis, "motionSource"), motion, (v) => missing(v) ? "unknown" : [0, 1].includes(Number(v)) ? "normal" : "warn"),
  simple("audio_last_reason", "Audio reason", "audio_last_reason", "", sourceTip("最近一次音频触发原因。", "none、key8 或 remote_v_key。", "three_zone 触发需确认是否预期。", "检查模式包和三区逻辑。", "ChassisFrame.audioLastReason"), ({ chassis }) => field(chassis, "audioLastReason"), audio, (v) => missing(v) ? "unknown" : [3, 4].includes(Number(v)) ? "warn" : "normal"),
  simple("audio_count", "Audio count", "audio_count", "次", sourceTip("音频触发累计次数。", "按操作有序增长。", "无操作时增长。", "结合 Audio reason 排查。", "ChassisFrame.audioCount"), ({ chassis }) => field(chassis, "audioCount")),
  simple("diag_drop_count", "CDBG drops", "diag_drop_count", "帧", sourceTip("USART2 忙导致的 CDBG 丢帧数。", "0", ">0 表示遥测带宽受限。", "检查串口忙、输出频率和调试负载。", "ChassisFrame.diagDropCount"), ({ chassis }) => field(chassis, "diagDropCount"), int, (v) => missing(v) ? "unknown" : Number(v) > 0 ? "warn" : "normal"),
];

const liveAgeStatus = (value: unknown): DiagnosticStatus => ageStatus(value, 300, 1000);

/** CDBG v3: reception/task/hardware observability. Cumulative history is yellow, never red. */
export const wirelessReceiveMetricSpecs: readonly MetricSpec[] = [
  simple("v3_link_alive", "链路当前在线", "link_alive / raw_score", "", sourceTip("底盘按原始收包评分判定的当前链路。", "link_alive=1 且评分稳定。", "当前离线或评分降为 0。", "对齐遥控器 RDBG，并检查任务 heartbeat、SPI 与寄存器。", "ChassisFrame.linkAlive/rawScore"), ({ chassis }) => fields(chassis, "linkAlive", "rawScore"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `${Number(v[0]) ? "在线" : "离线"} / score=${v[1]}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[0]) === 0 ? "error" : Number(v[1]) < 30 ? "warn" : "normal"),
  simple("v3_frame_flow", "NRF 帧流", "last_frame_type / valid / bad / width_err", "帧", sourceTip("最近帧类型以及有效、坏帧、动态长度错误累计值。", "有效帧持续增长，错误不增长。", "错误历史会标黄；新增长由事件标红。", "结合同一时刻 CEVT、heartbeat 与寄存器快照。", "ChassisFrame.lastFrameType/validFrameCount/badFrameCount/rxWidthErrorCount"), ({ chassis }) => fields(chassis, "lastFrameType", "validFrameCount", "badFrameCount", "rxWidthErrorCount"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `type=${v[0]} · ok=${v[1]} · bad=${v[2]} · width=${v[3]}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[2]) > 0 || Number(v[3]) > 0 ? "warn" : "normal"),
  simple("v3_packet_classes", "分类帧年龄", "adc/mode/key/task age", "ms", sourceTip("ADC、模式、按键和任务包最近到达年龄。", "需要的包类在操作时及时刷新。", "ADC 超时会直接导致遥控无响应；其他类需结合操作判断。", "先确认总帧流，再看单类是否缺失。", "ChassisFrame.adcAgeMs/modeFrameAgeMs/keyAgeMs/taskFrameAgeMs"), ({ chassis }) => fields(chassis, "adcAgeMs", "modeFrameAgeMs", "keyAgeMs", "taskFrameAgeMs"), (v) => tuple(v, 0), (v, c) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[0]) > 1000 && Number(field(c.chassis, "linkAlive")) === 1 ? "error" : Number(v[0]) > 300 ? "warn" : "normal"),
  simple("v3_task_heartbeats", "任务 Heartbeat", "nrf_update / nrf_ack / chassis / commun age", "ms", sourceTip("四条关键任务最后运行年龄。", "每条都持续低于 300 ms。", "超过 1 s 表示对应任务可能阻塞。", "按最先超时的任务定位 RTOS 阻塞点。", "ChassisFrame.*HeartbeatAgeMs"), ({ chassis }) => fields(chassis, "nrfUpdateHeartbeatAgeMs", "nrfAckHeartbeatAgeMs", "chassisUpdateHeartbeatAgeMs", "communHeartbeatAgeMs"), (v) => tuple(v, 0), (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Math.max(...v.map(Number)) > 1000 ? "error" : Math.max(...v.map(Number)) > 300 ? "warn" : "normal"),
  simple("v3_ack_path", "ACK 写入", "ack_write_age / lock_fail / notify_timeout", "", sourceTip("ACK payload 最近写入年龄及锁/通知失败历史。", "写入持续刷新且历史错误为 0。", "当前年龄超时为红，历史累计为黄。", "检查 NrfAck 调度、mutex 和通知等待。", "ChassisFrame.ackWriteAgeMs/ackLockFailCount/ackNotifyTimeoutCount"), ({ chassis }) => fields(chassis, "ackWriteAgeMs", "ackLockFailCount", "ackNotifyTimeoutCount"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `age=${v[0]} ms · lock=${v[1]} · notify=${v[2]}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[0]) > 1000 ? "error" : Number(v[0]) > 300 || Number(v[1]) > 0 || Number(v[2]) > 0 ? "warn" : "normal"),
  simple("v3_link_edges", "链路边沿历史", "raw_lost / scan_timeout / weak / recover", "次", sourceTip("链路丢失、扫描超时、弱链与恢复累计次数。", "稳定运行时不增长。", "非零只代表历史，显示黄色。", "查看 CEVT_NRF_LINK 确认最近一次边沿。", "ChassisFrame.link*Count"), ({ chassis }) => fields(chassis, "linkRawLostCount", "linkScanTimeoutCount", "linkWeakScanCount", "linkRecoverCount"), (v) => tuple(v, 0), (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : v.some((item) => Number(item) > 0) ? "warn" : "normal"),
  simple("v3_spi_errors", "NRF SPI 错误历史", "nrf_spi_error_count / last_age", "", sourceTip("NRF SPI 调用错误累计值与距最近错误时间。", "累计为 0。", "非零历史为黄；近期错误由 age 判红。", "检查 SPI、CSN/CE、供电及任务互斥。", "ChassisFrame.nrfSpiErrorCount/nrfSpiLastErrorAgeMs"), ({ chassis }) => fields(chassis, "nrfSpiErrorCount", "nrfSpiLastErrorAgeMs"), (v) => !Array.isArray(v) || v.every(missing) ? "—" : `count=${v[0] ?? "—"} · age=${v[1] ?? "—"} ms`, (v) => !Array.isArray(v) || missing(v[0]) ? "unknown" : !missing(v[1]) && Number(v[1]) <= 1000 ? "error" : Number(v[0]) > 0 ? "warn" : "normal"),
  simple("v3_nrf_registers", "NRF 寄存器快照", "reg_age / mismatch / pack0..2", "", sourceTip("在 NrfUpdate 持锁时每秒采集的寄存器快照。", "mismatch=0 且快照年龄正常。", "当前 mismatch 为红；无法采样显示未知。", "按 mismatch 位与三个 pack 对照 CONFIG、信道和动态载荷。", "ChassisFrame.nrfReg*"), ({ chassis }) => fields(chassis, "nrfRegAgeMs", "nrfRegMismatchMask", "nrfRegPack0", "nrfRegPack1", "nrfRegPack2"), (v) => !Array.isArray(v) || missing(v[0]) ? "—" : `age=${v[0]} ms · mismatch=${missing(v[1]) ? "—" : `0x${Number(v[1]).toString(16)}`} · ${v.slice(2).map((x) => missing(x) ? "—" : `0x${Number(x).toString(16).padStart(8, "0")}`).join(" / ")}`, (v) => !Array.isArray(v) || missing(v[0]) || missing(v[1]) ? "unknown" : Number(v[1]) !== 0 ? "error" : Number(v[0]) > 2000 ? "warn" : "normal"),
];

/** CDBG v3: requested remote mode versus the state actually applied by the chassis. */
export const modeSyncMetricSpecs: readonly MetricSpec[] = [
  simple("v3_mode_tuple", "模式三元组", "remote_mode / live_mode / chassis_state", "", sourceTip("遥控帧模式、最新实时遥控模式与底盘实际状态；两套枚举数值不同。", "自由/走点/锁定模式映射到对应底盘状态；高层任务模式只展示，不强行映射。", "实时模式与底盘状态的有效映射不一致为当前故障。", "确认底盘重启后是否收到新的 MODE 帧。", "ChassisFrame.remoteMode/activeRemoteModeLive/chassisState"), ({ chassis }) => fields(chassis, "remoteMode", "activeRemoteModeLive", "chassisState"), (v) => !Array.isArray(v) || v.every(missing) ? "—" : `frame=${v[0] ?? "—"} · live=${v[1] ?? "—"} · chassis=${v[2] ?? "—"}`, (v) => !Array.isArray(v) || missing(v[1]) || missing(v[2]) ? "unknown" : modeStateMismatch(Number(v[1]), Number(v[2])) ? "error" : !missing(v[0]) && Number(v[0]) !== Number(v[1]) ? "warn" : "normal"),
  simple("v3_state_queue", "状态队列", "state_q / enqueue_drop", "", sourceTip("待应用状态队列深度和入队失败累计数。", "队列很快归零且无 drop。", "当前积压为红；历史 drop 为黄。", "检查状态消费者 heartbeat 和模式投递。", "ChassisFrame.stateQ/stateEnqueueDropCount"), ({ chassis }) => fields(chassis, "stateQ", "stateEnqueueDropCount"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `queued=${v[0]} · drops=${v[1]}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[0]) > 0 ? "error" : Number(v[1]) > 0 ? "warn" : "normal"),
  simple("v3_state_apply_age", "最近状态应用", "last_state_apply_age_ms", "ms", sourceTip("距离底盘最近一次应用模式状态的时间。", "MODE 操作后及时归零。", "操作期间长时间不刷新。", "对齐 MODE_SYNC 事件与 mode_frame_age。", "ChassisFrame.lastStateApplyAgeMs"), ({ chassis }) => field(chassis, "lastStateApplyAgeMs"), int, liveAgeStatus),
  simple("v3_mode_frame", "MODE 帧", "mode_frame_age / count", "", sourceTip("最近 MODE 帧年龄和累计接收数。", "切换模式时 count 增长且 age 归零。", "链路在线但切换时没有增长。", "检查遥控器包类型与底盘分类帧计数。", "ChassisFrame.modeFrameAgeMs/modeFrameCount"), ({ chassis }) => fields(chassis, "modeFrameAgeMs", "modeFrameCount"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `age=${v[0]} ms · count=${v[1]}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[0]) > 1000 ? "warn" : "normal"),
];

/** CDBG v3: ACT queue -> USART1 -> mechanism feedback path. */
export const mechanismMetricSpecs: readonly MetricSpec[] = [
  simple("v3_action_queue", "ACT 动作队列", "enqueue_ok / drop / dequeue / age", "", sourceTip("ACT 入队成功/失败、出队数和最近出队年龄。", "动作时 ok 与 dequeue 同步增长。", "队列 drop 历史为黄；动作未出队需结合 Commun heartbeat。", "单次安全动作后对齐 MECH_CMD 事件。", "ChassisFrame.action*"), ({ chassis }) => fields(chassis, "actionEnqueueOkCount", "actionEnqueueDropCount", "actionDequeueCount", "actionDequeueAgeMs"), (v) => !Array.isArray(v) || v.slice(0, 3).some(missing) ? "—" : `in=${v[0]} · drop=${v[1]} · out=${v[2]} · age=${v[3] ?? "—"} ms`, (v) => !Array.isArray(v) || v.slice(0, 3).some(missing) ? "unknown" : Number(v[1]) > 0 ? "warn" : "normal"),
  simple("v3_mech_tx", "USART1 机构发送", "start / ok / fail / in_flight / duration / status", "", sourceTip("机构发送开始、成功、失败、当前阻塞年龄与最近状态。", "发送迅速完成且成功计数增长。", "当前 in-flight 超时或 HAL 状态异常为红；失败历史为黄。", "检查 HAL_UART_Transmit 前后 MECH_TX 事件。", "ChassisFrame.mechTx*"), ({ chassis }) => fields(chassis, "mechTxStartCount", "mechTxOkCount", "mechTxFailCount", "mechTxInFlightAgeMs", "mechTxLastDurationMs", "mechTxLastStatus"), (v) => !Array.isArray(v) || v.slice(0, 3).some(missing) ? "—" : `start=${v[0]} · ok=${v[1]} · fail=${v[2]} · active=${v[3] ?? "—"} ms · last=${v[4] ?? "—"} ms/${v[5] ?? "—"}`, (v) => !Array.isArray(v) || v.slice(0, 3).some(missing) ? "unknown" : !missing(v[3]) && Number(v[3]) > 1000 ? "error" : !missing(v[5]) && Number(v[5]) !== 0 ? "error" : Number(v[2]) > 0 ? "warn" : "normal"),
  simple("v3_uart1_state", "USART1 当前状态", "g_state / rx_state / error_code", "", sourceTip("HAL UART1 全局状态、接收状态与当前错误码。", "错误码为 0，状态不长期 BUSY。", "当前 error_code 非 0 为红。", "结合 UART1_ERR 事件和发送 in-flight 年龄。", "ChassisFrame.uart1GState/uart1RxState/uart1ErrorCode"), ({ chassis }) => fields(chassis, "uart1GState", "uart1RxState", "uart1ErrorCode"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `g=${v[0]} · rx=${v[1]} · err=0x${Number(v[2]).toString(16)}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[2]) !== 0 ? "error" : "normal"),
  simple("v3_mech_feedback", "机构反馈", "ok / bad / queue_drop / age", "", sourceTip("机构板反馈校验、队列投递和最近有效反馈年龄。", "动作后 RX 字节到达且 ok 增长。", "坏帧/drop 历史为黄；动作后长期无反馈需结合发送时刻。", "检查 F5…5F、接线、机构板供电与反馈队列。", "ChassisFrame.mechFeedback*"), ({ chassis }) => fields(chassis, "mechFeedbackOkCount", "mechFeedbackBadCount", "mechFeedbackQueueDropCount", "mechFeedbackAgeMs"), (v) => !Array.isArray(v) || v.slice(0, 3).some(missing) ? "—" : `ok=${v[0]} · bad=${v[1]} · drop=${v[2]} · age=${v[3] ?? "—"} ms`, (v) => !Array.isArray(v) || v.slice(0, 3).some(missing) ? "unknown" : Number(v[1]) > 0 || Number(v[2]) > 0 ? "warn" : "normal"),
  simple("v3_uart1_rx", "USART1 接收与重挂", "error / rearm_ok / rearm_fail / bytes / age", "", sourceTip("UART1 错误、接收中断重挂与收到字节的累计/年龄。", "重挂成功、无当前错误，动作后字节增长。", "重挂失败历史为黄；近期 UART 错误事件为红。", "检查 USART1 RX、共地、波特率及回调执行。", "ChassisFrame.uart1*Count/uart1RxByteAgeMs"), ({ chassis }) => fields(chassis, "uart1ErrorCount", "uart1RearmOkCount", "uart1RearmFailCount", "uart1RxByteCount", "uart1RxByteAgeMs"), (v) => !Array.isArray(v) || v.slice(0, 4).some(missing) ? "—" : `err=${v[0]} · rearm=${v[1]}/${v[2]} · bytes=${v[3]} · age=${v[4] ?? "—"} ms`, (v) => !Array.isArray(v) || v.slice(0, 4).some(missing) ? "unknown" : Number(v[0]) > 0 || Number(v[2]) > 0 ? "warn" : "normal"),
];

const locationTip = (meaning: string, normal: string, abnormal: string, check: string, source: string) => tip(meaning, normal, abnormal, check, source);
const quad = (chassis: ChassisFrame | null, stem: string) => fields(chassis, `${stem}1`, `${stem}2`, `${stem}3`, `${stem}4`);
const sumTuple = (value: unknown): number | null => !Array.isArray(value) || value.some(missing)
  ? null : value.reduce((sum, item) => sum + Number(item), 0);

/** CDBG v5: point-control internals, DGM recovery, and steering cascade details. */
export const pointDebugMetricSpecs: readonly MetricSpec[] = [
  simple("v5_point_error", "走点距离 / yaw 误差", "point_distance_m / point_yaw_error_deg", "m / deg", locationTip("走点模式内部距离误差与目标 yaw 包角误差。", "走点过程中逐步回落，到点后接近 0。", "距离或 yaw 误差长期不收敛。", "对齐目标点、定位输入、yaw PID 与 motion source。", "ChassisFrame.pointDistanceM/pointYawErrorDeg"), ({ chassis }) => fields(chassis, "pointDistanceM", "pointYawErrorDeg"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `${Number(v[0]).toFixed(3)} m · yaw=${Number(v[1]).toFixed(1)}°`),
  simple("v5_point_output", "走点 PID / 速度输出", "point_pid_out / point_speed_output", "", locationTip("走点距离 PID 输出与最终速度输出。", "有距离误差时有输出，到点后回落。", "有误差但输出为 0，或到点后仍持续输出。", "检查 pointPid、最小速度限制、死区和目标点状态。", "ChassisFrame.pointPidOut/pointSpeedOutput"), ({ chassis }) => fields(chassis, "pointPidOut", "pointSpeedOutput"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `pid=${Number(v[0]).toFixed(3)} · speed=${Number(v[1]).toFixed(3)}`),
  simple("v5_dgm_recover", "DGM 恢复计数 ID1..4", "dgm_recover_count1..4", "次", locationTip("四个 DGM 自动恢复错误计数，网页由四轮计数派生总数。", "全部为 0 或不再增长。", "任一轮累计增加表示该轮 DGM 报错后触发恢复。", "按 ID1右前、ID2右后、ID3左前、ID4左后检查驱动器错误、供电和 CAN。", "ChassisFrame.dgmRecoverCount1..4"), ({ chassis }) => quad(chassis, "dgmRecoverCount"), (v) => {
    const total = sumTuple(v);
    return total === null ? "—" : `total=${total} · ${tuple(v, 0)}`;
  }, (v) => {
    const total = sumTuple(v);
    return total === null ? "unknown" : total > 0 ? "warn" : "normal";
  }),
  simple("v5_steer_pos_pid", "Steer position PID ID1..4", "steer_pos_pid_out1..4", "PID", locationTip("四个舵向位置外环 PID output，会作为速度环目标。", "转向时有输出，角度接近目标后回落。", "外环有大输出但舵向误差不收敛。", "对比 Steer error、Steer speed PID output 和 GM6020 转速。", "ChassisFrame.steerPosPidOut1..4"), ({ chassis }) => quad(chassis, "steerPosPidOut"), (v) => tuple(v)),
  simple("v5_steer_rotor_speed", "Steer rotor speed ID1..4", "steer_rotor_speed_rpm1..4", "rpm", locationTip("四个 GM6020 舵向电机 rotor_speed。", "转向时反馈速度跟随外环/速度环输出。", "有 PID 输出但速度长期为 0 或方向异常。", "检查 GM6020 反馈、CAN、电机使能和机械卡滞。", "ChassisFrame.steerRotorSpeedRpm1..4"), ({ chassis }) => quad(chassis, "steerRotorSpeedRpm"), (v) => tuple(v, 0)),
];

export const locationMetricSpecs: readonly MetricSpec[] = [
  simple("pos", "Chassis pose", "pos_x / pos_y / yaw", "cm / deg", locationTip("底盘最终定位姿态。", "有限且连续。", "缺失、非有限或突跳。", "比较 Locater、LiDAR 和编码器输入。", "ChassisFrame.posX/posY/yaw"), ({ chassis }) => fields(chassis, "posX", "posY", "yaw"), pose, (_v, c) => locationStatus(c.chassis)),
  simple("locater_pose", "Locater pose", "locater_x / locater_y / locater_yaw", "cm / deg", locationTip("定位板输入姿态。", "随底盘运动连续更新。", "冻结、全零或突跳。", "检查 USART3 PG 帧路径。", "ChassisFrame.locaterX/locaterY/locaterYaw"), ({ chassis }) => fields(chassis, "locaterX", "locaterY", "locaterYaw"), pose),
  simple("lidar_pose", "Lidar pose", "lidar_x / lidar_y / lidar_yaw", "cm / deg", locationTip("LiDAR 定位输入。", "有效时与最终姿态接近。", "失效、跳变或长期不更新。", "检查 LiDAR 在线和定位质量。", "ChassisFrame.lidarX/lidarY/lidarYaw"), ({ chassis }) => fields(chassis, "lidarX", "lidarY", "lidarYaw"), pose),
  simple("encoder_xy", "Encoder XY", "encoder_x / encoder_y", "cm", locationTip("编码轮累计位置。", "随运动连续变化。", "静止、反向或突跳。", "检查编码器接线和方向。", "ChassisFrame.encoderX/encoderY"), ({ chassis }) => fields(chassis, "encoderX", "encoderY"), (v) => tuple(v)),
  simple("h30_yaw", "H30 yaw", "h30_yaw", "deg", locationTip("H30 航向角。", "有限且连续。", "冻结、非有限或突跳。", "检查 H30 数据和姿态有效位。", "ChassisFrame.h30Yaw"), ({ chassis }) => field(chassis, "h30Yaw"), fixed),
  simple("dt35", "DT35", "dt35_1 / dt35_2", "mm", locationTip("两路 DT35 测距。", "有效范围内稳定变化。", "零、超量程或突跳。", "检查安装、遮挡和串口数据。", "ChassisFrame.dt35_1/dt35_2"), ({ chassis }) => fields(chassis, "dt35_1", "dt35_2"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `DT35-1=${Number(v[0]).toFixed(0)}, DT35-2=${Number(v[1]).toFixed(0)}`),
  simple("loc_frame_age_ms", "Locater frame age", "loc_frame_age_ms", "ms", locationTip("底盘最近定位帧年龄。", "≤200 ms", "201–500 ms 警告，>500 ms 异常。", "检查定位板 USART3 PG 帧。", "ChassisFrame.locFrameAgeMs"), ({ chassis }) => field(chassis, "locFrameAgeMs"), int, (v) => ageStatus(v, 200, 500)),
  simple("loc_rx", "Locater RX", "loc_rx_ok / loc_rx_bad / loc_checksum_err", "", locationTip("定位帧接收与校验统计。", "bad=0 且 checksum=0。", "错误计数增长。", "检查波特率、接线、帧格式和干扰。", "ChassisFrame.locRxOk/locRxBad/locChecksumErr"), ({ chassis }) => fields(chassis, "locRxOk", "locRxBad", "locChecksumErr"), (v) => !Array.isArray(v) || tupleMissing(v) ? "—" : `ok=${v[0]}, bad=${v[1]}, checksum=${v[2]}`, (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Number(v[1]) > 0 || Number(v[2]) > 0 ? "warn" : "normal"),
  simple("motor_age", "Motor FB age", "m_age1..4", "ms", locationTip("四个电机反馈年龄。", "每路≤200 ms。", ">200 ms 警告，>500 ms 或 0xFFFFFFFF 异常。", "检查 CAN、驱动供电和反馈帧。", "ChassisFrame.mAge1..mAge4"), ({ chassis }) => quad(chassis, "mAge"), (v) => tuple(v, 0), (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : v.some((x) => Number(x) === 0xffffffff || Number(x) > 500) ? "error" : v.some((x) => Number(x) > 200) ? "warn" : "normal"),
  simple("drv_cmd", "Drive command", "drv_cmd1..4", "", locationTip("四轮驱动目标。", "与运动命令一致。", "异常不对称或无输入时非零。", "检查运动学和 motion source。", "ChassisFrame.drvCmd1..4"), ({ chassis }) => quad(chassis, "drvCmd"), (v) => tuple(v)),
  simple("drv_fb", "Drive feedback", "drv_fb1..4", "", locationTip("四轮驱动反馈。", "跟随 Drive command。", "有命令无反馈或零命令仍运动。", "检查 CAN、电机电源和使能。", "ChassisFrame.drvFb1..4"), ({ chassis }) => quad(chassis, "drvFb"), (v) => tuple(v)),
  simple("drv_pid_out", "Drive output ID1..4", "drv_pid_out1..4", "r/s", locationTip("按实车 ID1右前、ID2右后、ID3左前、ID4左后输出的轮向控制量。当前 DGM 轮向为速度模式，本字段是发给 DGM 速度环的目标速度输出。", "与 Drive command 同源并跟随运动命令。", "有输出但反馈不跟随，或无输出却被带动。", "重点对比同 ID 的 Drive command、Drive feedback 与 DGM 反馈年龄。", "ChassisFrame.drvPidOut1..4"), ({ chassis }) => quad(chassis, "drvPidOut"), (v) => tuple(v)),
  simple("steer_cmd", "Steer command", "steer_cmd1..4", "deg", locationTip("四轮转向目标角。", "符合底盘运动学。", "异常不对称或突跳。", "检查转向解算和模式输入。", "ChassisFrame.steerCmd1..4"), ({ chassis }) => quad(chassis, "steerCmd"), (v) => tuple(v)),
  simple("steer_fb", "Steer feedback", "steer_fb1..4", "deg", locationTip("四轮转向反馈角。", "跟随 Steer command。", "冻结或偏差持续扩大。", "检查编码器、CAN 和舵向驱动。", "ChassisFrame.steerFb1..4"), ({ chassis }) => quad(chassis, "steerFb"), (v) => tuple(v)),
  simple("steer_err", "Steer error", "steer_err1..4", "deg", locationTip("四轮目标与反馈误差。", "绝对值≤30°。", ">30° 警告，>45° 异常。", "检查方向到位、编码器零点和机械卡滞。", "ChassisFrame.steerErr1..4"), ({ chassis }) => quad(chassis, "steerErr"), (v) => tuple(v), (v) => !Array.isArray(v) || tupleMissing(v) ? "unknown" : Math.max(...v.map((x) => Math.abs(Number(x)))) > 45 ? "error" : Math.max(...v.map((x) => Math.abs(Number(x)))) > 30 ? "warn" : "normal"),
  simple("steer_pid_out", "Steer PID output ID1..4", "steer_pid_out1..4", "PID", locationTip("按实车 ID1右前、ID2右后、ID3左前、ID4左后输出的舵向速度环 PID output。", "转向时有输出，接近目标后回落。", "长期高输出但 steer_err 不减小，说明舵向可能卡滞、编码器/方向/驱动异常。", "把同 ID 的 Steer command、feedback、error 与 PID output 放到同一示波器观察。", "ChassisFrame.steerPidOut1..4"), ({ chassis }) => quad(chassis, "steerPidOut"), (v) => tuple(v)),
  simple("motor_fault_mask", "Motor fault mask", "motor_fault_mask", "", locationTip("电机故障位掩码。", "0", ">0 表示至少一个故障。", "按驱动器故障码检查对应电机。", "ChassisFrame.motorFaultMask"), ({ chassis }) => field(chassis, "motorFaultMask"), int, countStatus),
  simple("can_rx_count", "CAN RX count", "can_rx_count", "帧", locationTip("CAN 接收累计帧数。", "运行中持续增长。", "长期不变。", "检查 CAN 总线、终端电阻和节点供电。", "ChassisFrame.canRxCount"), ({ chassis }) => field(chassis, "canRxCount")),
  simple("can_tx_err", "CAN TX errors", "can_tx_err", "次", locationTip("CAN 发送错误累计数。", "0", ">0。", "检查总线占用、仲裁、接线和终端。", "ChassisFrame.canTxErr"), ({ chassis }) => field(chassis, "canTxErr"), int, countStatus),
];

const aggregateStatus = (specs: readonly MetricSpec[], context: MetricContext): DiagnosticStatus => {
  if (!context.chassis) return "unknown";
  const rank: Record<DiagnosticStatus, number> = { unknown: 0, normal: 1, warn: 2, error: 3 };
  return specs.reduce<DiagnosticStatus>((worst, spec) => {
    const next = spec.evaluator?.(spec.getter(context), context) ?? "unknown";
    return rank[next] > rank[worst] ? next : worst;
  }, "normal");
};

export const panelStatus = {
  remote: ({ remote }: MetricContext) => remoteLinkStatus(remote),
  chassis: chassisNrfStatus,
  wireless: (context: MetricContext) => aggregateStatus(wirelessReceiveMetricSpecs, context),
  mode: (context: MetricContext) => aggregateStatus(modeSyncMetricSpecs, context),
  mechanism: (context: MetricContext) => aggregateStatus(mechanismMetricSpecs, context),
  pointDebug: (context: MetricContext) => aggregateStatus(pointDebugMetricSpecs, context),
  location: ({ chassis }: MetricContext) => locationStatus(chassis),
};

export const metricInternals = { missing, tupleMissing, ageStatus, countStatus };
