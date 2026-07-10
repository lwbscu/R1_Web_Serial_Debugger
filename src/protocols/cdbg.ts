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

const FLOAT_FIELDS = new Set([
  "posX", "posY", "yaw", "locaterX", "locaterY", "locaterYaw", "lidarX", "lidarY", "lidarYaw",
  "encoderX", "encoderY", "h30Yaw", "dt35_1", "dt35_2", "targetX", "targetY", "targetYaw",
  "packetLossRate", "cmdVx", "cmdVy", "cmdWz", "drvCmd1", "drvCmd2", "drvCmd3", "drvCmd4",
  "drvFb1", "drvFb2", "drvFb3", "drvFb4", "steerCmd1", "steerCmd2", "steerCmd3", "steerCmd4",
  "steerFb1", "steerFb2", "steerFb3", "steerFb4", "steerErr1", "steerErr2", "steerErr3", "steerErr4",
]);

function assignFields(frame: ChassisFrame, names: readonly string[], values: readonly string[]): void {
  names.forEach((name, index) => {
    const text = values[index];
    if (text === undefined) return;
    frame[name] = FLOAT_FIELDS.has(name) ? finite(text, name) : integer(text, name);
  });
}

export function parseCdbg(line: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
  const marker = line.indexOf("CDBG,");
  if (marker < 0) return { kind: "ignored", reason: "not_cdbg" };
  const rawLine = line.slice(marker).trim();
  let parts = rawLine.split(",").map((part) => part.trim());
  let warnings: string[] = [];

  try {
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
      detail: `CDBG field count ${parts.length} != 30/35/72/90`,
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

function eventOutcome(clean: string, observedAtMs: number): ParseOutcome<ChassisFrame> {
  const parts = clean.split(",").map((part) => part.trim());
  const isCevt = parts[0] === "CEVT";
  if (isCevt && parts.length < 4) return { kind: "error", code: "field_count", detail: `CEVT field count ${parts.length} < 4` };
  const sourceTimeMs = isCevt ? integer(parts[2]!, "ms") : 0;
  const event: ProtocolEvent = {
    source: "chassis",
    eventKind: isCevt ? parts[1]! : parts[0]!,
    observedAtMs,
    sourceTimeMs,
    fields: (isCevt ? parts.slice(3) : parts.slice(1)).map(parseEventValue),
    rawLine: clean,
  };
  return { kind: "event", event };
}

export class ChassisProtocolAdapter implements ProtocolAdapter<ChassisFrame> {
  readonly id = "chassis-cdbg";
  readonly parserVersion = "2.0.0";

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
