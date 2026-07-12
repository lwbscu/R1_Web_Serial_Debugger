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
]);

function assignFields(frame: ChassisFrame, names: readonly string[], values: readonly string[], normalizeSentinels = false): void {
  names.forEach((name, index) => {
    const text = values[index];
    if (text === undefined) return;
    const value = FLOAT_FIELDS.has(name) ? finite(text, name) : integer(text, name);
    frame[name] = normalizeSentinels && (
      (UINT32_SENTINEL_FIELDS.has(name) && value === 0xffffffff) ||
      (UINT8_SENTINEL_FIELDS.has(name) && value === 0xff)
    ) ? null : value;
  });
}

export function parseCdbg(line: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
  const marker = line.indexOf("CDBG,");
  if (marker < 0) return { kind: "ignored", reason: "not_cdbg" };
  const rawLine = line.slice(marker).trim();
  let parts = rawLine.split(",").map((part) => part.trim());
  let warnings: string[] = [];

  try {
    if (parts[1] === "3" || parts[1] === "4") {
      const version = integer(parts[1]!, "protocol_version");
      const declared = integer(parts[2]!, "field_count");
      const expected = version === 4 ? 159 : 151;
      if (declared !== expected) return { kind: "error", code: "unsupported_field_count", detail: `CDBG v${version} field_count ${declared}` };
      if (parts.length < declared) return { kind: "error", code: "incomplete_frame", detail: `CDBG v${version} incomplete field count ${parts.length} < ${declared}` };
      if (parts.length > declared) return { kind: "error", code: "trailing_fields", detail: `CDBG v${version} trailing field count ${parts.length} > ${declared}` };
      const frame: ChassisFrame = { observedAtMs, rawLine, protocolVersion: version, fieldCount: declared };
      assignFields(frame, V2_90_FIELDS, parts.slice(3, 90), true);
      assignFields(frame, V3_EXTENSION_FIELDS, parts.slice(90, 151), true);
      if (version === 4) assignFields(frame, V4_EXTENSION_FIELDS, parts.slice(151), true);
      return { kind: "frame", frame, protocolVersion: version === 4 ? "cdbg-v4" : "cdbg-v3", warnings };
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
      detail: `CDBG field count ${parts.length} != 30/35/72/90/151/159`,
    };
  } catch (error) {
    return outcomeError(error);
  }
}

function parseEventValue(value: string): unknown {
  const trimmed = value.trim();
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

function eventOutcome(clean: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
  const parts = clean.split(",").map((part) => part.trim());
  const isCevt = parts[0] === "CEVT";
  if (parts[0] === "CDBG_BOOT") {
    if (parts.length !== 5) return { kind: "error", code: "field_count", detail: `CDBG_BOOT field count ${parts.length} != 5` };
    const version = integer(parts[1]!, "protocol_version");
    const declared = integer(parts[2]!, "field_count");
    if (version !== 3 && version !== 4) return { kind: "error", code: "unsupported_version", detail: `CDBG_BOOT version ${version}` };
    if ((version === 3 && declared !== 151) || (version === 4 && declared !== 159)) {
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
  readonly parserVersion = "4.0.0";

  parse(line: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
    const marker = line.search(/CDBG_BOOT,|CDBG,|CEVT,/);
    if (marker < 0) return { kind: "ignored", reason: "unsupported_chassis_line" };
    const clean = line.slice(marker).trim();
    if (clean.startsWith("CDBG,")) return parseCdbg(clean, observedAtMs);
    try {
      return eventOutcome(clean, observedAtMs);
    } catch (error) {
      return outcomeError(error);
    }
  }
}
