import type uPlot from "uplot";
import { minMaxDecimate, type SeriesId, type TelemetryPoint, type TelemetrySource, type YScaleMode } from "../../core/telemetry";

export interface PlotSeriesInput {
  id: SeriesId;
  label: string;
  color: string;
  visible: boolean;
  points: readonly TelemetryPoint[];
  description?: string;
  sourceLabel?: string;
  unit?: string;
  fieldPath?: string;
}

export interface AlignedPlotData {
  data: uPlot.AlignedData;
  series: PlotSeriesInput[];
}

export function alignPlotSeries(inputs: readonly PlotSeriesInput[], maxPointsPerSeries = 10_000): AlignedPlotData {
  const prepared = inputs.map((input) => ({
    ...input,
    points: minMaxDecimate(input.points, maxPointsPerSeries),
  }));
  const timestamps = new Set<number>();
  for (const input of prepared) for (const point of input.points) timestamps.add(point.atMs / 1000);
  const x = [...timestamps].sort((a, b) => a - b);
  const xIndex = new Map(x.map((value, index) => [value, index]));
  const columns: (number | null)[][] = prepared.map(() => Array.from<number | null>({ length: x.length }).fill(null));
  prepared.forEach((input, seriesIndex) => {
    for (const point of input.points) {
      const index = xIndex.get(point.atMs / 1000);
      if (index !== undefined) columns[seriesIndex]![index] = point.value;
    }
  });
  return { data: [x, ...columns] as uPlot.AlignedData, series: prepared };
}

/**
 * Absolute lower bound for an X window. Epoch timestamps impose a larger
 * bound at runtime (see minimumSafeXSpanSeconds), so the slider never asks
 * uPlot to represent a range that collapses to the same IEEE-754 number.
 */
export const MIN_X_SPAN_SECONDS = 0.000001;

const SOURCE_LABELS: Record<TelemetrySource, string> = {
  remote: "遥控器 RDBG",
  chassis: "底盘 CDBG",
  locator: "定位板 CSV / R1M",
};

const FIELD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ms: "设备启动后的毫秒时间戳",
  sourceTimeMs: "数据源随帧携带的毫秒时间戳",
  seq: "协议帧递增序号，用于观察丢帧或乱序",
  protocolVersion: "底盘调试帧协议版本",
  fieldCount: "本帧实际解析的字段数量",
  signalBars: "遥控器估算的无线信号强度格数",
  noAckMs: "距离最近一次有效 NRF 应答的时间",
  failCount: "连续无线发送失败次数",
  ackOkCount: "成功收到有效 ACK 的累计次数",
  rfCh: "遥控器当前 NRF 射频信道",
  nrfCh: "底盘当前 NRF 射频信道",
  ackLen: "最近一帧 ACK 载荷长度",
  ackScore: "底盘计算的无线应答质量分数",
  packetLossRate: "滑动窗口内的数据包丢失率",
  packetLostWin: "滑动窗口内丢失包数量",
  packetTotalWin: "滑动窗口内总包数量",
  lastSigAgeMs: "距离最近一帧有效遥控器信号的时间",
  lastRawAgeMs: "距离最近一帧原始无线数据的时间",
  locFrameAgeMs: "距离最近一帧有效定位数据的时间",
  posX: "底盘当前融合定位结果的世界 X 坐标",
  posY: "底盘当前融合定位结果的世界 Y 坐标",
  yaw: "底盘当前融合定位结果的航向角",
  locaterX: "底盘接收的定位板 X 坐标",
  locaterY: "底盘接收的定位板 Y 坐标",
  locaterYaw: "底盘接收的定位板航向角",
  encoderX: "底盘编码器里程计的 X 坐标",
  encoderY: "底盘编码器里程计的 Y 坐标",
  lidarX: "底盘接收的 LiDAR 世界 X 坐标",
  lidarY: "底盘接收的 LiDAR 世界 Y 坐标",
  lidarYaw: "底盘接收的 LiDAR 航向角",
  h30Yaw: "底盘接收的 H30 航向角",
  dt35_1: "底盘第一路 DT35 原始测距值",
  dt35_2: "底盘第二路 DT35 原始测距值",
  posXcm: "融合定位结果的世界 X 坐标",
  posYcm: "融合定位结果的世界 Y 坐标",
  posYawDeg: "融合定位结果的车头航向角",
  calibXcm: "编码器/标定坐标系的 X 坐标",
  calibYcm: "编码器/标定坐标系的 Y 坐标",
  calibYawDeg: "编码器/标定姿态的航向角",
  lidarXcm: "LiDAR 定位输出的世界 X 坐标",
  lidarYcm: "LiDAR 定位输出的世界 Y 坐标",
  lidarYawDeg: "LiDAR 定位输出的航向角",
  h30YawDeg: "H30 姿态传感器输出的航向角",
  dt35_1mm: "左侧 DT35-1 的原始测距值",
  dt35_2mm: "右侧 DT35-2 的原始测距值",
  cmdVx: "底盘控制指令的 X 向速度",
  cmdVy: "底盘控制指令的 Y 向速度",
  cmdWz: "底盘控制指令的角速度",
  nrfUpdateMaxMs: "NRF 更新流程观测到的最大耗时",
  nrfAckMaxMs: "NRF ACK 流程观测到的最大耗时",
  scanWaitMaxMs: "NRF 扫频等待观测到的最大耗时",
  ackWriteCount: "底盘写入 ACK 载荷的累计次数",
  linkReason: "底盘无线链路状态原因码",
  canRxCount: "底盘 CAN 接收帧累计数量",
  canTxErr: "底盘 CAN 发送错误累计数量",
  status: "定位状态位掩码，各 bit 表示传感器和脉冲状态",
  crcOk: "定位帧 CRC 校验是否通过",
  linkReady: "遥控器无线链路是否完成初始化",
  linkOnline: "遥控器无线链路当前是否在线",
  localPresent: "遥控器本机输入数据是否存在",
  txRet: "最近一次无线发送调用的返回状态",
  rxScore: "遥控器估算的接收质量分数",
  lost: "遥控器链路丢失标志",
  retry: "最近一次发送使用的重试次数",
  locRxOk: "底盘成功接收定位帧的累计数量",
  locRxBad: "底盘接收异常定位帧的累计数量",
  locChecksumErr: "底盘定位帧校验错误累计数量",
  nrfScanState: "底盘 NRF 信道扫描状态",
  joyAgeMs: "距离最近一帧有效摇杆数据的时间",
  joyValid: "底盘当前摇杆数据是否有效",
  joyLx: "左摇杆 X 轴输入",
  joyLy: "左摇杆 Y 轴输入",
  joyRx: "右摇杆 X 轴输入",
  joyRy: "右摇杆 Y 轴输入",
  motorFaultMask: "四轮电机故障状态位掩码",
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
  ms: "设备时间",
  sourceTimeMs: "源时间",
  seq: "帧序号",
  protocolVersion: "协议版本",
  fieldCount: "字段数",
  signalBars: "信号格数",
  noAckMs: "无 ACK 时长",
  failCount: "连续发送失败",
  ackOkCount: "ACK 成功累计",
  rfCh: "遥控器信道",
  nrfCh: "底盘信道",
  ackLen: "ACK 长度",
  ackScore: "ACK 质量分",
  packetLossRate: "窗口丢包率",
  packetLostWin: "窗口丢包数",
  packetTotalWin: "窗口总包数",
  lastSigAgeMs: "有效信号帧龄",
  lastRawAgeMs: "原始无线帧龄",
  locFrameAgeMs: "定位帧龄",
  posX: "底盘融合 X",
  posY: "底盘融合 Y",
  yaw: "底盘融合航向角",
  locaterX: "定位板 X",
  locaterY: "定位板 Y",
  locaterYaw: "定位板航向角",
  encoderX: "编码器 X",
  encoderY: "编码器 Y",
  lidarX: "底盘 LiDAR X",
  lidarY: "底盘 LiDAR Y",
  lidarYaw: "底盘 LiDAR 航向角",
  h30Yaw: "底盘 H30 航向角",
  dt35_1: "底盘 DT35-1",
  dt35_2: "底盘 DT35-2",
  posXcm: "融合 X",
  posYcm: "融合 Y",
  posYawDeg: "融合航向角",
  calibXcm: "标定 X",
  calibYcm: "标定 Y",
  calibYawDeg: "标定航向角",
  encoderXcm: "编码器 X",
  encoderYcm: "编码器 Y",
  lidarXcm: "LiDAR X",
  lidarYcm: "LiDAR Y",
  lidarYawDeg: "LiDAR 航向角",
  h30YawDeg: "H30 航向角",
  dt35_1mm: "DT35-1 距离",
  dt35_2mm: "DT35-2 距离",
  cmdVx: "指令 Vx",
  cmdVy: "指令 Vy",
  cmdWz: "指令 Wz",
  nrfUpdateMaxMs: "NRF 更新最大耗时",
  nrfAckMaxMs: "NRF ACK 最大耗时",
  scanWaitMaxMs: "扫频等待最大耗时",
  ackWriteCount: "ACK 写入累计",
  linkReason: "链路原因码",
  canRxCount: "CAN 接收累计",
  canTxErr: "CAN 发送错误",
  linkReady: "链路就绪",
  linkOnline: "链路在线",
  localPresent: "本机输入存在",
  txRet: "发送返回值",
  rxScore: "接收评分",
  lost: "丢失标志",
  retry: "重试次数",
  status: "状态位",
  crcOk: "CRC 正常",
};

function leafName(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

function inferredDescription(path: string): string {
  const leaf = leafName(path);
  const motor = /^(drvCmd|drvFb|steerCmd|steerFb|steerErr)([1-4])$/.exec(leaf);
  if (motor) {
    const meanings: Record<string, string> = {
      drvCmd: "驱动电机目标值", drvFb: "驱动电机反馈值",
      steerCmd: "转向电机目标值", steerFb: "转向电机反馈值", steerErr: "转向位置误差",
    };
    return `${meanings[motor[1]!] ?? "电机字段"}（第 ${motor[2]} 轮）`;
  }
  if (/Count$/i.test(leaf)) return `${path} 的累计计数`;
  if (/AgeMs$|Ms$/i.test(leaf)) return `${path} 的时间或时延观测值`;
  if (/Valid$|Online$|Active$|Ready$|Seen$/i.test(leaf)) return `${path} 的有效、在线或触发状态`;
  return `协议字段 ${path} 的实时数值`;
}

export function inferFieldUnit(path: string): string {
  const leaf = leafName(path);
  if (/^(dt35_[12])$/i.test(leaf) || /mm$/i.test(leaf)) return "mm";
  if (/^(pos|locater|lidar|encoder)[XY]$/i.test(leaf) || /cm$/i.test(leaf)) return "cm";
  if (/deg$|yaw/i.test(leaf)) return "°";
  if (/ageMs$|Ms$/i.test(leaf)) return "ms";
  if (/packetLossRate$/i.test(leaf)) return "比例 (0–1)";
  if (/Rate$/i.test(leaf)) return "比例";
  if (/Ch$|Channel$/i.test(leaf)) return "信道";
  if (/Len$/i.test(leaf)) return "byte";
  if (/Count$|failCount$|lost$|retry$/i.test(leaf)) return "次";
  if (/Score$/i.test(leaf)) return "分";
  if (/Valid$|Online$|Active$|Ready$|Present$|Seen$|crcOk$/i.test(leaf)) return "0/1";
  if (/^seq$/i.test(leaf)) return "序号";
  return "无量纲";
}

export interface SeriesDescription {
  label: string;
  description: string;
  sourceLabel: string;
  unit: string;
  fieldPath: string;
}

export function describeSeries(id: SeriesId): SeriesDescription {
  const separator = id.indexOf(":");
  const source = id.slice(0, separator) as TelemetrySource;
  const path = id.slice(separator + 1);
  const leaf = leafName(path);
  return {
    label: FIELD_LABELS[path] ?? FIELD_LABELS[leaf] ?? path,
    description: FIELD_DESCRIPTIONS[path] ?? FIELD_DESCRIPTIONS[leaf] ?? inferredDescription(path),
    sourceLabel: SOURCE_LABELS[source] ?? source,
    unit: inferFieldUnit(path),
    fieldPath: path,
  };
}

/** Maps a normalized slider to a logarithmic zoom ratio without a preset-sized lower bound. */
export function zoomLevelToRatio(level: number, decades: number): number {
  const normalized = Math.min(100, Math.max(0, Number.isFinite(level) ? level : 0));
  return 10 ** (normalized / 100 * decades);
}

/** Slider mapping for an axis that may zoom both in and out around its center. */
export function centeredZoomLevelToRatio(level: number, decades: number): number {
  const normalized = Math.min(100, Math.max(-100, Number.isFinite(level) ? level : 0));
  return 10 ** (normalized / 100 * decades);
}

export function minimumSafeXSpanSeconds(referenceSeconds = 0): number {
  const magnitude = Math.max(1, Math.abs(Number.isFinite(referenceSeconds) ? referenceSeconds : 0));
  return Math.max(MIN_X_SPAN_SECONDS, Number.EPSILON * magnitude * 32);
}

export function zoomedXSpanSeconds(windowMs: number, ratio: number, referenceSeconds = 0): number {
  const minimum = minimumSafeXSpanSeconds(referenceSeconds);
  const base = Math.max(minimum, windowMs / 1000);
  return Math.max(minimum, base / Math.max(1, Number.isFinite(ratio) ? ratio : 1));
}

export function clampXRange(
  min: number,
  max: number,
  fullMin: number,
  fullMax: number,
  minimumSpan = minimumSafeXSpanSeconds((fullMin + fullMax) / 2),
): [number, number] {
  const fullSpan = fullMax - fullMin;
  if (![min, max, fullMin, fullMax].every(Number.isFinite) || fullSpan <= 0) return [fullMin, fullMax];
  const center = (min + max) / 2;
  const requested = Number.isFinite(max - min) ? max - min : fullSpan;
  const span = Math.min(fullSpan, Math.max(Math.min(minimumSpan, fullSpan), requested));
  let nextMin = center - span / 2;
  let nextMax = center + span / 2;
  if (nextMin < fullMin) { nextMin = fullMin; nextMax = fullMin + span; }
  if (nextMax > fullMax) { nextMax = fullMax; nextMin = fullMax - span; }
  return [nextMin, nextMax];
}

export function calculateYRange(inputs: readonly PlotSeriesInput[], mode: YScaleMode, zoomRatio = 1): [number, number] {
  let min: number;
  let max: number;
  if (mode.kind === "fixed") {
    min = mode.min; max = mode.max;
  } else {
    min = Number.POSITIVE_INFINITY; max = Number.NEGATIVE_INFINITY;
    for (const input of inputs) {
      if (!input.visible) continue;
      for (const point of input.points) {
        if (!Number.isFinite(point.value)) continue;
        min = Math.min(min, point.value); max = Math.max(max, point.value);
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1; }
    if (min === max) {
      const padding = Math.max(1, Math.abs(min) * .05);
      min -= padding; max += padding;
    } else {
      const padding = (max - min) * .05;
      min -= padding; max += padding;
    }
  }
  const center = (min + max) / 2;
  const safeRatio = Math.max(1e-9, Number.isFinite(zoomRatio) ? zoomRatio : 1);
  const span = Math.max(Number.EPSILON * Math.max(1, Math.abs(center)) * 32, (max - min) / safeRatio);
  return [center - span / 2, center + span / 2];
}
