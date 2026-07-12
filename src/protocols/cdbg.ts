import type { ParseOutcome, ProtocolAdapter, ProtocolEvent } from "../core/types";
import type { ChassisFrame } from "./models";
import { finite, integer, outcomeError } from "./numeric";

const LEGACY_30_FIELDS = [
  "ms", "seq", "locSrc", "posX", "posY", "yaw", "locaterX", "locaterY", "locaterYaw",
  "lidarX", "lidarY", "lidarYaw", "encoderX", "encoderY", "h30Yaw", "dt35_1", "dt35_2",
  "locFrameAgeMs", "locRxOk", "locRxBad", "locChecksumErr", "nrfScanState", "nrfCh",
  "lastSigAgeMs", "lastRawAgeMs", "linkReason", "ackScore", "scanWaitMaxMs", "ackWriteCount",
] as const;

const CONTROL_FIELDS = ["cmdType", "cmdAgeMs", "targetX", "targetY", "targetYaw"] as const;

const V1_72_FIELDS = [
  "ms", "seq", "nrfScanState", "nrfCh", "lastSigAgeMs", "lastRawAgeMs", "ackScore",
  "packetLossRate", "packetLostWin", "packetTotalWin", "nrfUpdateMaxMs", "nrfAckMaxMs",
  "scanWaitMaxMs", "ackWriteCount", "linkReason", "joyAgeMs", "joyValid", "joyLx", "joyLy",
  "joyRx", "joyRy", "cmdVx", "cmdVy", "cmdWz", "remoteMode", "modeAgeMs", "modeX", "modeY",
  "motionSource", "activeMode", "autoActive", "pointQ", "threeZoneQ", "actionQ", "lastModeExecMs",
  "audioCount", "audioLastReason", "audioLastHeader", "audioLastData", "audioAgeMs", "locFrameAgeMs",
  "locRxOk", "locRxBad", "locChecksumErr", "mAge1", "mAge2", "mAge3", "mAge4", "drvCmd1",
  "drvCmd2", "drvCmd3", "drvCmd4", "drvFb1", "drvFb2", "drvFb3", "drvFb4", "steerCmd1",
  "steerCmd2", "steerCmd3", "steerCmd4", "steerFb1", "steerFb2", "steerFb3", "steerFb4",
  "steerErr1", "steerErr2", "steerErr3", "steerErr4", "motorFaultMask", "canRxCount", "canTxErr",
] as const;

const V2_90_FIELDS = [
  "ms", "seq", "locSrc", "posX", "posY", "yaw", "locaterX", "locaterY", "locaterYaw", "lidarX",
  "lidarY", "lidarYaw", "encoderX", "encoderY", "h30Yaw", "dt35_1", "dt35_2", "nrfScanState",
  "nrfCh", "lastSigAgeMs", "lastRawAgeMs", "ackScore", "packetLossRate", "packetLostWin",
  "packetTotalWin", "nrfUpdateMaxMs", "nrfAckMaxMs", "scanWaitMaxMs", "ackWriteCount", "linkReason",
  "joyAgeMs", "joyValid", "joyLx", "joyLy", "joyRx", "joyRy", "cmdVx", "cmdVy", "cmdWz",
  "remoteMode", "modeAgeMs", "modeX", "modeY", "motionSource", "activeMode", "autoActive", "pointQ",
  "threeZoneQ", "actionQ", "lastModeExecMs", "audioCount", "audioLastReason", "audioLastHeader",
  "audioLastData", "audioAgeMs", "locFrameAgeMs", "locRxOk", "locRxBad", "locChecksumErr", "mAge1",
  "mAge2", "mAge3", "mAge4", "drvCmd1", "drvCmd2", "drvCmd3", "drvCmd4", "drvFb1", "drvFb2",
  "drvFb3", "drvFb4", "steerCmd1", "steerCmd2", "steerCmd3", "steerCmd4", "steerFb1", "steerFb2",
  "steerFb3", "steerFb4", "steerErr1", "steerErr2", "steerErr3", "steerErr4", "motorFaultMask",
  "canRxCount", "canTxErr", "diagDropCount",
] as const;

/**
 * Frozen CDBG v3 extension. Keep this order byte-for-byte aligned with
 * chassis firmware. A v3 frame is 3 header tokens + 87 v2 payload tokens +
 * these 61 tokens = 151 tokens in total.
 */
export const V3_EXTENSION_FIELDS = [
  "resetFlags", "linkAlive", "rawScore", "chassisState", "activeRemoteModeLive", "stateQ",
  "stateEnqueueDropCount", "lastStateApplyAgeMs", "lastFrameType", "validFrameCount",
  "badFrameCount", "rxWidthErrorCount", "adcAgeMs", "adcCount", "modeFrameAgeMs",
  "modeFrameCount", "keyAgeMs", "keyCount", "taskFrameAgeMs", "taskFrameCount",
  "nrfUpdateHeartbeatAgeMs", "nrfAckHeartbeatAgeMs", "chassisUpdateHeartbeatAgeMs",
  "communHeartbeatAgeMs", "ackWriteAgeMs", "ackLockFailCount", "ackNotifyTimeoutCount",
  "linkRawLostCount", "linkScanTimeoutCount", "linkWeakScanCount", "linkRecoverCount",
  "scoreZeroMs", "nrfSpiErrorCount", "nrfSpiLastErrorAgeMs", "nrfRegAgeMs",
  "nrfRegMismatchMask", "nrfRegPack0", "nrfRegPack1", "nrfRegPack2",
  "actionEnqueueOkCount", "actionEnqueueDropCount", "actionDequeueCount", "actionDequeueAgeMs",
  "mechTxStartCount", "mechTxOkCount", "mechTxFailCount", "mechTxInFlightAgeMs",
  "mechTxLastDurationMs", "mechTxLastStatus", "uart1GState", "uart1RxState", "uart1ErrorCode",
  "mechFeedbackOkCount", "mechFeedbackBadCount", "mechFeedbackQueueDropCount",
  "mechFeedbackAgeMs", "uart1ErrorCount", "uart1RearmOkCount", "uart1RearmFailCount",
  "uart1RxByteCount", "uart1RxByteAgeMs",
] as const;

export const V4_EXTENSION_FIELDS = [
  "drvPidOut1", "drvPidOut2", "drvPidOut3", "drvPidOut4",
  "steerPidOut1", "steerPidOut2", "steerPidOut3", "steerPidOut4",
] as const;

export const V5_EXTENSION_FIELDS = [
  "pointDistanceM", "pointYawErrorDeg",
  "dgmRecoverCount1", "dgmRecoverCount2", "dgmRecoverCount3", "dgmRecoverCount4",
  "steerPosPidOut1", "steerPosPidOut2", "steerPosPidOut3", "steerPosPidOut4",
  "steerRotorSpeedRpm1", "steerRotorSpeedRpm2", "steerRotorSpeedRpm3", "steerRotorSpeedRpm4",
  "pointPidOut", "pointSpeedOutput",
] as const;

const V6_FIELD_SOURCE = "ms,loop_seq,task_mode,side_profile,motion_state,control_source,build_short,reset_flags,vbat_mv,imu_yaw,imu_pitch,imu_roll,pos_x,pos_y,pos_theta,loc_valid,loc_age_ms,dt35_1,dt35_2,dt35_3,dt35_4,dt35_age_ms,joy_lx,joy_ly,joy_rx,joy_ry,key_bits,act_seq_seen,act_type,act_age_ms,nrf_rx_total,nrf_valid_total,nrf_bad_total,nrf_raw_ts,nrf_raw_age_ms,nrf_safe_age_ms,nrf_link_state,nrf_loss_streak,nrf_recover_streak,nrf_last_reason,nrf_status,nrf_fifo,nrf_config,nrf_rf_ch,nrf_rf_setup,nrf_en_aa,nrf_en_rxaddr,nrf_feature,nrf_dynpd,nrf_spi_bad_total,uart1_rx_bytes,uart1_good_frames,uart1_bad_frames,uart1_pe_total,uart1_fe_total,uart1_ne_total,uart1_ore_total,uart1_rto_total,uart1_rearm_fail_total,uart1_last_error,uart1_last_isr,uart1_last_age_ms,uart1_recovery_total,uart1_recovery_ok_total,uart1_parser_resets,mech_cmd_enq_total,mech_cmd_deq_total,mech_tx_start_total,mech_tx_ok_total,mech_tx_fail_total,mech_tx_busy_total,mech_tx_timeout_total,mech_tx_block_age_ms,mech_fb_total,mech_fb_valid_total,mech_fb_seq,mech_fb_echo_seq,mech_fb_age_ms,mech_fb_fresh,mech_fb_task_raw,mech_fb_status,mech_fb_error,commun_heartbeat,commun_queue_depth,commun_last_deq_age_ms,chassis_fault_bits,snapshot_version,w1_drv_cmd,w1_drv_fb,w1_drv_err,w1_drv_pid_out,w1_steer_cmd,w1_steer_fb,w1_steer_err,w1_steer_pid_out,w1_steer_target_raw,w1_steer_fb_raw,w1_steer_current_ma,w1_drv_current_ma,w1_wheel_fault_bits,w1_feedback_age_ms,w1_control_owner,w2_drv_cmd,w2_drv_fb,w2_drv_err,w2_drv_pid_out,w2_steer_cmd,w2_steer_fb,w2_steer_err,w2_steer_pid_out,w2_steer_target_raw,w2_steer_fb_raw,w2_steer_current_ma,w2_drv_current_ma,w2_wheel_fault_bits,w2_feedback_age_ms,w2_control_owner,w3_drv_cmd,w3_drv_fb,w3_drv_err,w3_drv_pid_out,w3_steer_cmd,w3_steer_fb,w3_steer_err,w3_steer_pid_out,w3_steer_target_raw,w3_steer_fb_raw,w3_steer_current_ma,w3_drv_current_ma,w3_wheel_fault_bits,w3_feedback_age_ms,w3_control_owner,w4_drv_cmd,w4_drv_fb,w4_drv_err,w4_drv_pid_out,w4_steer_cmd,w4_steer_fb,w4_steer_err,w4_steer_pid_out,w4_steer_target_raw,w4_steer_fb_raw,w4_steer_current_ma,w4_drv_current_ma,w4_wheel_fault_bits,w4_feedback_age_ms,w4_control_owner,wheel_id_order,aux_out1,aux_out2,aux_out3,aux_out4,aux_out5,aux_out6,aux_out7,aux_out8,tick_now,loop_dt_us,loop_max_dt_us,printf_drop_total,cdbg_seq,cdbg_format_version,cdbg_declared_count,cdbg_format_crc16,free_heap,stack_min,can_rx_total,can_tx_total,can_err_total,imu_age_ms,locator_frame_total,locator_bad_total,frame_crc16,schema_crc16,reserved0,end_token";
export const V6_FIELDS = V6_FIELD_SOURCE.split(",");

const V6_TEXT_FIELDS = new Set([
  "sideProfile", "motionState", "controlSource", "buildShort", "actType", "nrfLastReason",
  "uart1LastError", "uart1LastIsr", "mechFbTaskRaw", "mechFbStatus", "mechFbError",
  "w1ControlOwner", "w2ControlOwner", "w3ControlOwner", "w4ControlOwner", "wheelIdOrder",
  "reserved0", "endToken",
]);

const V6_ALIAS_FIELDS: Record<string, string> = {
  loopSeq: "seq",
  posX: "posX",
  posY: "posY",
  posTheta: "yaw",
  locAgeMs: "locFrameAgeMs",
  dt351: "dt35_1",
  dt352: "dt35_2",
  nrfRfCh: "nrfCh",
  nrfSafeAgeMs: "lastSigAgeMs",
  nrfRawAgeMs: "lastRawAgeMs",
  nrfValidTotal: "validFrameCount",
  nrfBadTotal: "badFrameCount",
  nrfSpiBadTotal: "nrfSpiErrorCount",
  uart1RxBytes: "uart1RxByteCount",
  uart1LastAgeMs: "uart1RxByteAgeMs",
  uart1RearmFailTotal: "uart1RearmFailCount",
  mechCmdEnqTotal: "actionEnqueueOkCount",
  mechCmdDeqTotal: "actionDequeueCount",
  mechTxStartTotal: "mechTxStartCount",
  mechTxOkTotal: "mechTxOkCount",
  mechTxFailTotal: "mechTxFailCount",
  mechTxBlockAgeMs: "mechTxInFlightAgeMs",
  mechFbTotal: "mechFeedbackOkCount",
  mechFbAgeMs: "mechFeedbackAgeMs",
  printfDropTotal: "diagDropCount",
  cdbgSeq: "seq",
  canRxTotal: "canRxCount",
  canErrTotal: "canTxErr",
  locatorFrameTotal: "locRxOk",
  locatorBadTotal: "locRxBad",
};

for (let index = 1; index <= 4; index += 1) {
  Object.assign(V6_ALIAS_FIELDS, {
    [`w${index}DrvCmd`]: `drvCmd${index}`,
    [`w${index}DrvFb`]: `drvFb${index}`,
    [`w${index}DrvErr`]: `drvErr${index}`,
    [`w${index}DrvPidOut`]: `drvPidOut${index}`,
    [`w${index}SteerCmd`]: `steerCmd${index}`,
    [`w${index}SteerFb`]: `steerFb${index}`,
    [`w${index}SteerErr`]: `steerErr${index}`,
    [`w${index}SteerPidOut`]: `steerPidOut${index}`,
    [`w${index}FeedbackAgeMs`]: `mAge${index}`,
  });
}

const UINT32_SENTINEL_FIELDS = new Set<string>([
  "lastSigAgeMs", "lastRawAgeMs", "joyAgeMs", "modeAgeMs", "lastModeExecMs",
  "audioAgeMs", "locFrameAgeMs", "mAge1", "mAge2", "mAge3", "mAge4",
  "lastStateApplyAgeMs", "adcAgeMs", "modeFrameAgeMs", "keyAgeMs", "taskFrameAgeMs",
  "nrfUpdateHeartbeatAgeMs", "nrfAckHeartbeatAgeMs", "chassisUpdateHeartbeatAgeMs",
  "communHeartbeatAgeMs", "ackWriteAgeMs", "scoreZeroMs", "nrfSpiLastErrorAgeMs",
  "nrfRegAgeMs", "nrfRegMismatchMask", "nrfRegPack0", "nrfRegPack1", "nrfRegPack2",
  "actionDequeueAgeMs", "mechTxInFlightAgeMs", "mechTxLastDurationMs", "mechFeedbackAgeMs",
  "uart1RxByteAgeMs",
]);

const UINT8_SENTINEL_FIELDS = new Set<string>([
  "remoteMode", "activeMode", "audioLastReason", "activeRemoteModeLive", "lastFrameType",
  "mechTxLastStatus", "uart1GState", "uart1RxState",
]);

const FLOAT_FIELDS = new Set([
  "posX", "posY", "yaw", "locaterX", "locaterY", "locaterYaw", "lidarX", "lidarY", "lidarYaw",
  "encoderX", "encoderY", "h30Yaw", "dt35_1", "dt35_2", "targetX", "targetY", "targetYaw",
  "packetLossRate", "cmdVx", "cmdVy", "cmdWz", "drvCmd1", "drvCmd2", "drvCmd3", "drvCmd4",
  "drvFb1", "drvFb2", "drvFb3", "drvFb4", "steerCmd1", "steerCmd2", "steerCmd3", "steerCmd4",
  "steerFb1", "steerFb2", "steerFb3", "steerFb4", "steerErr1", "steerErr2", "steerErr3", "steerErr4",
  "drvPidOut1", "drvPidOut2", "drvPidOut3", "drvPidOut4",
  "steerPidOut1", "steerPidOut2", "steerPidOut3", "steerPidOut4",
  "pointDistanceM", "pointYawErrorDeg",
  "steerPosPidOut1", "steerPosPidOut2", "steerPosPidOut3", "steerPosPidOut4",
  "pointPidOut", "pointSpeedOutput",
]);

function isOptionalNull(text: string): boolean {
  return /^(?:NA|N\/A|null|unknown|unavailable|-|—)$/i.test(text.trim());
}

function camelCase(name: string): string {
  return name.replaceAll(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function assignFields(frame: ChassisFrame, names: readonly string[], values: readonly (string | null)[], normalizeSentinels = false): void {
  names.forEach((name, index) => {
    const text = values[index];
    if (text === undefined) return;
    if (text === null || isOptionalNull(text)) {
      frame[name] = null;
      return;
    }
    const value = FLOAT_FIELDS.has(name) ? finite(text, name) : integer(text, name);
    frame[name] = normalizeSentinels && (
      (UINT32_SENTINEL_FIELDS.has(name) && value === 0xffffffff) ||
      (UINT8_SENTINEL_FIELDS.has(name) && value === 0xff)
    ) ? null : value;
  });
}

function assignFlexibleFields(frame: ChassisFrame, names: readonly string[], values: readonly string[]): void {
  names.forEach((rawName, index) => {
    const text = values[index];
    if (text === undefined) return;
    const name = camelCase(rawName);
    if (isOptionalNull(text)) {
      frame[name] = null;
    } else if (V6_TEXT_FIELDS.has(name)) {
      frame[name] = text;
    } else {
      const numeric = /^[-+]?(?:0x[\da-f]+|(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[-+]?\d+)?)$/i.test(text) ? Number(text) : Number.NaN;
      if (!Number.isFinite(numeric)) throw new Error(`${rawName} is not numeric: ${text}`);
      frame[name] = numeric;
    }
    const alias = V6_ALIAS_FIELDS[name];
    if (alias && frame[name] !== undefined) frame[alias] = frame[name];
  });
  frame.layoutVariant = "v6";
  frame.declaredFieldCount = 179;
  frame.actualFieldCount = 179;
  frame.wheelOrderDescription = "ID1=right-front, ID2=right-rear, ID3=left-front, ID4=left-rear";
}

const V6_WHEEL_ORDERS = new Set(["1RF-2RR-3LF-4LR", "4321"]);

function validateV6Guards(frame: ChassisFrame): void {
  if (frame.cdbgFormatVersion !== 6) throw new Error(`cdbg_format_version ${String(frame.cdbgFormatVersion)} != 6`);
  if (frame.cdbgDeclaredCount !== 179) throw new Error(`cdbg_declared_count ${String(frame.cdbgDeclaredCount)} != 179`);
  if (frame.endToken !== "END") throw new Error(`end_token ${String(frame.endToken)} != END`);
  if (!V6_WHEEL_ORDERS.has(String(frame.wheelIdOrder))) throw new Error(`wheel_id_order ${String(frame.wheelIdOrder)} is unknown`);
  if (typeof frame.schemaCrc16 !== "number") throw new Error("schema_crc16 is missing");
}

function parseLegacy158(parts: readonly string[], observedAtMs: number): ParseOutcome<ChassisFrame> {
  const declared = integer(parts[2]!, "field_count");
  if (declared !== 159 || parts.length !== 158) {
    return { kind: "error", code: "field_count", detail: `legacy158 fingerprint mismatch: declared ${declared}, actual ${parts.length}` };
  }
  const whole = (value: string, min: number, max: number) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max;
  };
  const finiteRange = (value: string, min: number, max: number) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max;
  };
  const normalSegmentOne = whole(parts[20]!, 0, 10) && whole(parts[21]!, 0, 125) &&
    whole(parts[24]!, 0, 100) && finiteRange(parts[25]!, 0, 100) &&
    whole(parts[32]!, 0, 255) && whole(parts[34]!, 0, 1) &&
    [35, 36, 37, 38].every((index) => whole(parts[index]!, -32768, 32767));
  if (normalSegmentOne) {
    return { kind: "error", code: "incomplete_frame", detail: "CDBG v4/159 is missing its final token; historical legacy158 fingerprint not present" };
  }
  // Historical formatter bug: Segment 1 emitted 35 instead of 36 payload
  // tokens and invoked undefined varargs conversions after dt35_1. Segment 2
  // starts again at actual token index 38, so only the independent later
  // segments can be realigned safely.
  const v2: Array<string | null> = [
    ...parts.slice(3, 19),
    ...Array.from({ length: 20 }, () => null),
    ...parts.slice(38, 89),
  ];
  const frame: ChassisFrame = {
    observedAtMs,
    rawLine: parts.join(","),
    protocolVersion: 4,
    fieldCount: 159,
    declaredFieldCount: 159,
    actualFieldCount: 158,
    layoutVariant: "legacy158",
    compatibilityWarnings: "declared159_actual158",
  };
  assignFields(frame, V2_90_FIELDS, v2, true);
  assignFields(frame, V3_EXTENSION_FIELDS, parts.slice(89, 150), true);
  assignFields(frame, V4_EXTENSION_FIELDS, parts.slice(150, 158), true);
  return { kind: "frame", frame, protocolVersion: "cdbg-v4-legacy158", warnings: ["legacy158_declared159_actual158"] };
}

export function parseCdbg(line: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
  const marker = line.indexOf("CDBG,");
  if (marker < 0) return { kind: "ignored", reason: "not_cdbg" };
  const rawLine = line.slice(marker).trim();
  let parts = rawLine.split(",").map((part) => part.trim());
  let warnings: string[] = [];

  try {
    if (parts[1] === "6") {
      const declared = integer(parts[2]!, "field_count");
      if (declared !== 179) return { kind: "error", code: "unsupported_field_count", detail: `CDBG v6 field_count ${declared}` };
      if (parts.length < declared) return { kind: "error", code: "incomplete_frame", detail: `CDBG v6 incomplete field count ${parts.length} < ${declared}` };
      if (parts.length > declared) return { kind: "error", code: "trailing_fields", detail: `CDBG v6 trailing field count ${parts.length} > ${declared}` };
      const frame: ChassisFrame = { observedAtMs, rawLine, protocolVersion: 6, fieldCount: declared };
      assignFlexibleFields(frame, V6_FIELDS, parts.slice(3));
      validateV6Guards(frame);
      return { kind: "frame", frame, protocolVersion: "cdbg-v6", warnings };
    }

    if (parts[1] === "4" && parts[2] === "159" && parts.length === 158) {
      return parseLegacy158(parts, observedAtMs);
    }

    if (parts[1] === "3" || parts[1] === "4" || parts[1] === "5") {
      const version = integer(parts[1]!, "protocol_version");
      const declared = integer(parts[2]!, "field_count");
      const expected = version === 5 ? 175 : version === 4 ? 159 : 151;
      if (declared !== expected) return { kind: "error", code: "unsupported_field_count", detail: `CDBG v${version} field_count ${declared}` };
      if (parts.length < declared) return { kind: "error", code: "incomplete_frame", detail: `CDBG v${version} incomplete field count ${parts.length} < ${declared}` };
      if (parts.length > declared) return { kind: "error", code: "trailing_fields", detail: `CDBG v${version} trailing field count ${parts.length} > ${declared}` };
      const frame: ChassisFrame = { observedAtMs, rawLine, protocolVersion: version, fieldCount: declared };
      assignFields(frame, V2_90_FIELDS, parts.slice(3, 90), true);
      assignFields(frame, V3_EXTENSION_FIELDS, parts.slice(90, 151), true);
      if (version >= 4) assignFields(frame, V4_EXTENSION_FIELDS, parts.slice(151, 159), true);
      if (version >= 5) assignFields(frame, V5_EXTENSION_FIELDS, parts.slice(159), true);
      return { kind: "frame", frame, protocolVersion: `cdbg-v${version}`, warnings };
    }

    if (/^\d+$/.test(parts[1] ?? "") && Number(parts[1]) >= 2 && parts.length > 72) {
      const version = integer(parts[1]!, "protocol_version");
      if (version !== 2) return { kind: "error", code: "unsupported_version", detail: `CDBG version ${version}` };
    }

    if (parts[1] === "2" && (parts.length > 72 || parts[2] === "90")) {
      const version = integer(parts[1]!, "protocol_version");
      const declared = integer(parts[2]!, "field_count");
      if (version !== 2) return { kind: "error", code: "unsupported_version", detail: `CDBG version ${version}` };
      if (declared !== 90) return { kind: "error", code: "unsupported_field_count", detail: `CDBG v2 field_count ${declared}` };
      if (parts.length < declared) return { kind: "error", code: "incomplete_frame", detail: `CDBG incomplete field count ${parts.length} < ${declared}` };
      if (parts.length > declared) {
        warnings = ["trailing_fields"];
        parts = parts.slice(0, declared);
      }
      const frame: ChassisFrame = { observedAtMs, rawLine, protocolVersion: 2, fieldCount: 90 };
      assignFields(frame, V2_90_FIELDS, parts.slice(3));
      return { kind: "frame", frame, protocolVersion: "cdbg-v2", warnings };
    }

    if (parts.length === 72) {
      const frame: ChassisFrame = { observedAtMs, rawLine, protocolVersion: 1, fieldCount: 72 };
      assignFields(frame, V1_72_FIELDS, parts.slice(1));
      return { kind: "frame", frame, protocolVersion: "cdbg-v1-72", warnings };
    }
    if (parts.length === 30 || parts.length === 35) {
      const frame: ChassisFrame = { observedAtMs, rawLine, protocolVersion: 0, fieldCount: parts.length };
      assignFields(frame, LEGACY_30_FIELDS, parts.slice(1, 30));
      if (parts.length === 35) assignFields(frame, CONTROL_FIELDS, parts.slice(30));
      return { kind: "frame", frame, protocolVersion: `cdbg-legacy-${parts.length}`, warnings };
    }
    return {
      kind: "error",
      code: "field_count",
      detail: `CDBG field count ${parts.length} != 30/35/72/90/151/159/175/179`,
    };
  } catch (error) {
    return outcomeError(error);
  }
}

function parseEventValue(value: string): unknown {
  const trimmed = value.trim();
  if (isOptionalNull(trimmed)) return null;
  if (/^[-+]?(?:0x[\da-f]+|\d+)$/i.test(trimmed)) return integer(trimmed, "event");
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : trimmed;
}

function normalizeEventSentinels(eventKind: string, values: unknown[]): unknown[] {
  const uint32Indices: Readonly<Record<string, readonly number[]>> = {
    NRF_LINK: [2, 3],
    NRF_REG: [1, 2, 3, 4],
    MODE_SYNC: [5],
    MECH_TX: [6],
    UART1_ERR: [6],
  };
  const uint8Indices: Readonly<Record<string, readonly number[]>> = {
    MODE_SYNC: [0, 1],
    MECH_CMD: [1, 2, 3, 4],
    MECH_TX: [1, 2, 3, 4, 5],
    MECH_FB: [1, 2, 3, 4],
  };
  const u32 = new Set(uint32Indices[eventKind] ?? []);
  const u8 = new Set(uint8Indices[eventKind] ?? []);
  return values.map((value, index) => (
    (u32.has(index) && value === 0xffffffff) || (u8.has(index) && value === 0xff)
      ? null
      : value
  ));
}

function normalizeCevtV2Fields(eventKind: string, values: unknown[]): unknown[] {
  if (eventKind === "MECH_CMD") {
    const [seq, cmdSeq, stage, queueDepth, taskRaw, source, ageMs, enqTotal, deqTotal] = values;
    return [stage, null, null, null, null, queueDepth, seq, cmdSeq, taskRaw, source, ageMs, enqTotal, deqTotal];
  }
  if (eventKind === "MECH_TX") {
    const [seq, cmdSeq, stage, halStatus, txLen, durationMs, timeoutMs, okTotal, failTotal, busyTotal] = values;
    return [stage, null, null, null, null, halStatus, durationMs, seq, cmdSeq, txLen, timeoutMs, okTotal, failTotal, busyTotal];
  }
  if (eventKind === "MECH_FB") {
    const [seq, fbSeq, echoCmdSeq, valid, fresh, ageMs, taskRaw, status, error, validTotal] = values;
    const phase = valid === 1 || valid === true ? 1 : 3;
    return [phase, null, null, status, fresh, null, null, seq, fbSeq, echoCmdSeq, ageMs, taskRaw, error, validTotal];
  }
  return values;
}

const CEVT_V2_COUNTS: Readonly<Record<string, number>> = {
  NRF_LINK: 14,
  NRF_TX: 14,
  TIMESTAMP_ANOMALY: 12,
  UART_ERR: 17,
  UART_RECOVERY: 14,
  MECH_CMD: 14,
  MECH_TX: 15,
  MECH_FB: 15,
  RESET_CAUSE: 14,
  HEARTBEAT: 14,
};

const PROTOCOL_CONTRACT_SHA16 = "705953ec5e9d13e1";

export function parseDebugEvent(clean: string, observedAtMs: number, source: "remote" | "chassis"): ParseOutcome<ChassisFrame> {
  const parts = clean.split(",").map((part) => part.trim());
  const isCevt = parts[0] === "CEVT";
  if (parts[0] === "DBG_META") {
    if (parts.length !== 19) return { kind: "error", code: "field_count", detail: `DBG_META field count ${parts.length} != 19` };
    const version = integer(parts[1]!, "protocol_version");
    const declared = integer(parts[2]!, "field_count");
    if (version !== 1 || declared !== 19) return { kind: "error", code: "unsupported_version", detail: `DBG_META v${version}/${declared}` };
    const sourceTimeMs = integer(parts[3]!, "ms");
    if (parts[4] !== source) return { kind: "error", code: "wrong_role", detail: `DBG_META role ${parts[4] ?? ""} != ${source}` };
    if (!parts[5] || !parts[7] || !parts[8] || !parts[9] || !parts[10] || !parts[11]) {
      return { kind: "error", code: "invalid_meta", detail: "DBG_META identity field is empty" };
    }
    if (!/^[0-9a-f]{40}$/i.test(parts[9]!)) return { kind: "error", code: "invalid_meta", detail: `DBG_META commit ${parts[9]}` };
    if (parts[12] !== PROTOCOL_CONTRACT_SHA16) {
      return { kind: "error", code: "contract_mismatch", detail: `DBG_META contract ${parts[12] ?? ""}` };
    }
    const cdbgVersion = integer(parts[13]!, "cdbg_version");
    const cdbgCount = integer(parts[14]!, "cdbg_count");
    const rdbgVersion = integer(parts[15]!, "rdbg_tx_version");
    const rdbgCount = integer(parts[16]!, "rdbg_tx_count");
    const cevtVersion = integer(parts[17]!, "cevt_version");
    if (cevtVersion !== 2 ||
        (source === "chassis" && (cdbgVersion !== 6 || cdbgCount !== 179)) ||
        (source === "remote" && (rdbgVersion !== 2 || rdbgCount !== 19))) {
      return { kind: "error", code: "protocol_tuple_mismatch", detail: `DBG_META ${cdbgVersion}/${cdbgCount} ${rdbgVersion}/${rdbgCount} CEVT${cevtVersion}` };
    }
    const event: ProtocolEvent = {
      source,
      eventKind: "DBG_META",
      observedAtMs,
      sourceTimeMs,
      fields: parts.slice(4).map(parseEventValue),
      rawLine: clean,
    };
    return { kind: "event", event };
  }
  if (parts[0] === "CDBG_BOOT") {
    if (source !== "chassis") return { kind: "error", code: "wrong_role", detail: "CDBG_BOOT is chassis-only" };
    if (parts.length !== 5) return { kind: "error", code: "field_count", detail: `CDBG_BOOT field count ${parts.length} != 5` };
    const version = integer(parts[1]!, "protocol_version");
    const declared = integer(parts[2]!, "field_count");
    if (version !== 3 && version !== 4 && version !== 5 && version !== 6) return { kind: "error", code: "unsupported_version", detail: `CDBG_BOOT version ${version}` };
    const expected = version === 6 ? 179 : version === 5 ? 175 : version === 4 ? 159 : 151;
    if (declared !== expected) {
      return { kind: "error", code: "unsupported_field_count", detail: `CDBG_BOOT field_count ${declared}` };
    }
    const sourceTimeMs = integer(parts[3]!, "ms");
    const event: ProtocolEvent = {
      source: "chassis", eventKind: "CDBG_BOOT", observedAtMs, sourceTimeMs,
      fields: [version, declared, integer(parts[4]!, "reset_flags")], rawLine: clean,
    };
    return { kind: "event", event };
  }
  if (!isCevt) return { kind: "error", code: "unsupported_event", detail: `Unsupported chassis event ${parts[0] ?? ""}` };
  if (parts.length < 4) return { kind: "error", code: "field_count", detail: `CEVT field count ${parts.length} < 4` };
  if (parts[1] === "2") {
    if (parts.length < 5) return { kind: "error", code: "field_count", detail: `CEVT v2 field count ${parts.length} < 5` };
    const kind = parts[2]!;
    const declared = integer(parts[3]!, "declared_count");
    if (declared !== parts.length) {
      return { kind: "error", code: "field_count", detail: `CEVT v2 ${kind} declared ${declared} != actual ${parts.length}` };
    }
    const expected = CEVT_V2_COUNTS[kind];
    if (expected === undefined) return { kind: "error", code: "unsupported_event", detail: `Unsupported CEVT v2 kind ${kind}` };
    if (declared !== expected) return { kind: "error", code: "field_count", detail: `CEVT v2 ${kind} count ${declared} != ${expected}` };
    const sourceTimeMs = integer(parts[4]!, "ms");
    const fields = parts.slice(5).map(parseEventValue);
    const textIndices: Readonly<Record<string, readonly number[]>> = {
      NRF_LINK: [1, 2],
      NRF_TX: [3],
      TIMESTAMP_ANOMALY: [1, 5, 6],
      UART_ERR: [1, 11],
      UART_RECOVERY: [1, 2, 3],
      MECH_CMD: [5],
      MECH_TX: [3],
      MECH_FB: [7, 8],
      HEARTBEAT: [1],
    };
    const optionalNumeric: Readonly<Record<string, readonly number[]>> = { MECH_FB: [2, 6] };
    const text = new Set(textIndices[kind] ?? []);
    const optional = new Set(optionalNumeric[kind] ?? []);
    for (let index = 0; index < fields.length; index += 1) {
      if (text.has(index)) continue;
      const value = fields[index];
      if (typeof value === "number" || (value === null && optional.has(index))) continue;
      return { kind: "error", code: "invalid_field", detail: `CEVT v2 ${kind} field ${index + 1} is not numeric` };
    }
    const event: ProtocolEvent = {
      source,
      eventKind: kind,
      observedAtMs,
      sourceTimeMs,
      fields: normalizeCevtV2Fields(kind, fields),
      rawLine: clean,
    };
    return { kind: "event", event };
  }
  const eventKind = parts[1]!;
  const v3PayloadCounts: Readonly<Record<string, number>> = {
    NRF_LINK: 7,
    NRF_REG: 6,
    MODE_SYNC: 6,
    MECH_CMD: 6,
    MECH_TX: 7,
    MECH_FB: 7,
    UART1_ERR: 7,
  };
  const legacyKinds = new Set(["AUDIO", "MODE_EXEC", "NRF_LOST", "MOTOR_FAULT"]);
  const payloadCount = v3PayloadCounts[eventKind];
  if (payloadCount === undefined && !legacyKinds.has(eventKind)) {
    return { kind: "error", code: "unsupported_event", detail: `Unsupported CEVT kind ${eventKind}` };
  }
  if (payloadCount !== undefined && parts.length !== payloadCount + 3) {
    return {
      kind: "error",
      code: "field_count",
      detail: `CEVT ${eventKind} field count ${parts.length} != ${payloadCount + 3}`,
    };
  }
  const sourceTimeMs = integer(parts[2]!, "ms");
  const event: ProtocolEvent = {
    source: "chassis",
    eventKind,
    observedAtMs,
    sourceTimeMs,
    fields: normalizeEventSentinels(eventKind, parts.slice(3).map(parseEventValue)),
    rawLine: clean,
  };
  return { kind: "event", event };
}

export class ChassisProtocolAdapter implements ProtocolAdapter<ChassisFrame> {
  readonly id = "chassis-cdbg";
  readonly parserVersion = "5.0.0";

  parse(line: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
    const marker = line.search(/DBG_META,|CDBG_BOOT,|CDBG,|CEVT,/);
    if (marker < 0) return { kind: "ignored", reason: "unsupported_chassis_line" };
    const clean = line.slice(marker).trim();
    if (clean.startsWith("CDBG,")) return parseCdbg(clean, observedAtMs);
    try {
      return parseDebugEvent(clean, observedAtMs, "chassis");
    } catch (error) {
      return outcomeError(error);
    }
  }
}
