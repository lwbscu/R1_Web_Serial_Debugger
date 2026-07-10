import type { ParseOutcome, ProtocolAdapter } from "../core/types";
import { crc16CcittFalse } from "./crc16";
import type { LocatorFrame } from "./models";
import { integer, outcomeError, requiredFinite } from "./numeric";

export type LocatorMode = "auto" | "r1m" | "r1_csv_v2" | "r1_csv_v3" | "legacy_csv";

export interface LocatorParserOptions {
  mode?: LocatorMode;
  allowNoCrc?: boolean;
  allowLegacyCsv?: boolean;
}

function emptyFrame(observedAtMs: number, rawLine: string, protocol: LocatorFrame["protocol"]): LocatorFrame {
  return {
    observedAtMs,
    rawLine,
    protocol,
    sourceTimeMs: 0,
    seq: 0,
    posXcm: 0,
    posYcm: 0,
    posYawDeg: 0,
    calibXcm: 0,
    calibYcm: 0,
    calibYawDeg: 0,
    encoderXcm: 0,
    encoderYcm: 0,
    h30Xcm: 0,
    h30Ycm: 0,
    h30YawDeg: 0,
    lidarXcm: 0,
    lidarYcm: 0,
    lidarYawDeg: 0,
    dt35_1mm: 0,
    dt35_2mm: 0,
    status: 0,
    h30Valid: false,
    h30HasAttitude: false,
    h30HasAccel: false,
    lidarValid: false,
    lidarOnline: false,
    dt35_1Valid: false,
    dt35_2Valid: false,
    xPulseSeen: false,
    yPulseSeen: false,
    crcOk: false,
    crcState: "no_crc",
    diagnostics: {},
  };
}

function applyStatus(frame: LocatorFrame): void {
  frame.h30Valid ||= Boolean(frame.status & (1 << 1));
  frame.lidarValid ||= Boolean(frame.status & (1 << 2));
  frame.lidarOnline ||= Boolean(frame.status & (1 << 3));
  frame.dt35_1Valid ||= Boolean(frame.status & (1 << 4));
  frame.dt35_2Valid ||= Boolean(frame.status & (1 << 5));
  frame.xPulseSeen ||= Boolean(frame.status & (1 << 10));
  frame.yPulseSeen ||= Boolean(frame.status & (1 << 11));
}

function parseR1m(rawLine: string, observedAtMs: number, allowNoCrc: boolean): ParseOutcome<LocatorFrame> {
  let payload = rawLine.slice(1);
  const warnings: string[] = [];
  let crcOk = true;
  let crcState: "ok" | "no_crc" = "ok";
  if (payload.includes("*")) {
    const separator = payload.lastIndexOf("*");
    const body = payload.slice(0, separator);
    const receivedText = payload.slice(separator + 1).trim();
    if (!/^[\da-f]{1,4}$/i.test(receivedText)) {
      return { kind: "error", code: "bad_crc_text", detail: `invalid CRC: ${receivedText}` };
    }
    const received = Number.parseInt(receivedText, 16);
    const calculated = crc16CcittFalse(body);
    if (received !== calculated) {
      return {
        kind: "error",
        code: "crc_mismatch",
        detail: `crc_mismatch calc=${calculated.toString(16).padStart(4, "0").toUpperCase()} got=${receivedText.toUpperCase()}`,
      };
    }
    payload = body;
  } else {
    if (!allowNoCrc) return { kind: "error", code: "missing_crc", detail: "R1M CRC is required" };
    crcOk = false;
    crcState = "no_crc";
    warnings.push("no_crc");
  }
  payload = payload.replace(/,+$/, "");
  const parts = payload.split(",").map((part) => part.trim());
  if (parts.length !== 19 || parts[0] !== "R1M") {
    return { kind: "error", code: "field_count", detail: `R1M field count ${parts.length} != 19` };
  }
  try {
    const status = integer(parts[18]!, "status");
    const frame = emptyFrame(observedAtMs, rawLine, "r1m");
    Object.assign(frame, {
      sourceTimeMs: integer(parts[2]!, "source_time_ms"),
      seq: integer(parts[3]!, "seq"),
      posXcm: requiredFinite(parts[4]!, "pos_x_cm"),
      posYcm: requiredFinite(parts[5]!, "pos_y_cm"),
      posYawDeg: requiredFinite(parts[6]!, "pos_yaw_deg"),
      calibXcm: requiredFinite(parts[7]!, "calib_x_cm"),
      calibYcm: requiredFinite(parts[8]!, "calib_y_cm"),
      calibYawDeg: requiredFinite(parts[9]!, "calib_yaw_deg"),
      encoderXcm: requiredFinite(parts[7]!, "encoder_x_cm"),
      encoderYcm: requiredFinite(parts[8]!, "encoder_y_cm"),
      h30Xcm: requiredFinite(parts[10]!, "h30_x_cm"),
      h30Ycm: requiredFinite(parts[11]!, "h30_y_cm"),
      h30YawDeg: requiredFinite(parts[12]!, "h30_yaw_deg"),
      lidarXcm: requiredFinite(parts[13]!, "lidar_x_cm"),
      lidarYcm: requiredFinite(parts[14]!, "lidar_y_cm"),
      lidarYawDeg: requiredFinite(parts[15]!, "lidar_yaw_deg"),
      dt35_1mm: requiredFinite(parts[16]!, "dt35_1_mm"),
      dt35_2mm: requiredFinite(parts[17]!, "dt35_2_mm"),
      status,
      crcOk,
      crcState,
    });
    applyStatus(frame);
    return { kind: "frame", frame, protocolVersion: `r1m-v${integer(parts[1]!, "version")}`, warnings };
  } catch (error) {
    return outcomeError(error);
  }
}

function parseNumbers(rawLine: string): number[] {
  return rawLine
    .split(",")
    .filter((part) => part.trim() !== "")
    .map((part, index) => requiredFinite(part, `field_${index}`));
}

function parseV2(values: number[], rawLine: string, observedAtMs: number): ParseOutcome<LocatorFrame> {
  if (values.length < 25) return { kind: "error", code: "field_count", detail: `R1 CSV v2 field count ${values.length} < 25` };
  const warnings = values.length > 41 ? ["trailing_fields"] : [];
  const v = values.slice(0, 41);
  const at = (index: number): number => v[index] ?? 0;
  const status = Math.trunc(at(24));
  const frame = emptyFrame(observedAtMs, rawLine, "r1_csv_v2");
  Object.assign(frame, {
    posXcm: at(0), posYcm: at(1), posYawDeg: at(2),
    lidarXcm: at(3), lidarYcm: at(4), lidarYawDeg: at(5),
    calibXcm: at(6), calibYcm: at(7), calibYawDeg: at(8),
    h30YawDeg: at(9), h30Xcm: at(10), h30Ycm: at(11),
    encoderXcm: at(12), encoderYcm: at(13),
    h30Valid: Math.trunc(at(14)) !== 0,
    h30HasAttitude: Math.trunc(at(15)) !== 0,
    lidarValid: Math.trunc(at(16)) !== 0,
    lidarOnline: Math.trunc(at(17)) !== 0,
    sourceTimeMs: Math.trunc(at(25)), status,
    h30HasAccel: Math.trunc(at(27)) !== 0,
    xPulseSeen: Boolean(status & (1 << 10)) || at(33) !== 0 || at(35) !== 0,
    yPulseSeen: Boolean(status & (1 << 11)) || at(34) !== 0 || at(36) !== 0,
  });
  const diagnosticIndexes: ReadonlyArray<readonly [string, number]> = [
    ["h30PacketCount", 18], ["lidarPacketCount", 19], ["h30CrcErrorCount", 20],
    ["h30FrameErrorCount", 21], ["lidarChecksumErrorCount", 22], ["lidarFrameErrorCount", 23],
    ["sourceTimeMs", 25], ["h30RxByteCount", 26], ["h30HasAccel", 27],
    ["h30LastUpdateMs", 28], ["lidarRxByteCount", 29], ["lidarLastUpdateMs", 30],
    ["xRawCount", 31], ["yRawCount", 32], ["xDeltaCount", 33], ["yDeltaCount", 34],
    ["xTotalCount", 35], ["yTotalCount", 36], ["xIndexSeen", 37], ["yIndexSeen", 38],
    ["encoderDisPmm", 39], ["encoderDisQmm", 40],
  ];
  diagnosticIndexes.forEach(([name, index]) => { frame.diagnostics[name] = at(index); });
  applyStatus(frame);
  return { kind: "frame", frame, protocolVersion: values.length >= 41 ? "r1-csv-v2-diag" : "r1-csv-v2", warnings };
}

function parseV3(values: number[], rawLine: string, observedAtMs: number): ParseOutcome<LocatorFrame> {
  if (values.length !== 12) return { kind: "error", code: "field_count", detail: `R1 CSV v3 field count ${values.length} != 12` };
  const status = Math.trunc(values[11]!);
  const frame = emptyFrame(observedAtMs, rawLine, "r1_csv_v3");
  Object.assign(frame, {
    posXcm: values[0], posYcm: values[1], posYawDeg: values[2],
    lidarXcm: values[3], lidarYcm: values[4], lidarYawDeg: values[5],
    calibXcm: values[6], calibYcm: values[7], calibYawDeg: values[8],
    encoderXcm: values[6], encoderYcm: values[7], h30YawDeg: values[8],
    dt35_1mm: values[9], dt35_2mm: values[10], status,
  });
  applyStatus(frame);
  frame.h30HasAttitude = frame.h30Valid;
  return { kind: "frame", frame, protocolVersion: "r1-csv-v3", warnings: [] };
}

function parseLegacy(values: number[], rawLine: string, observedAtMs: number): ParseOutcome<LocatorFrame> {
  const frame = emptyFrame(observedAtMs, rawLine, "legacy_csv");
  if (values.length === 5) {
    const [yaw, h30X, h30Y, encX, encY] = values as [number, number, number, number, number];
    Object.assign(frame, {
      posXcm: encX, posYcm: encY, posYawDeg: yaw,
      calibXcm: encX, calibYcm: encY, calibYawDeg: yaw,
      encoderXcm: encX, encoderYcm: encY,
      h30Xcm: h30X, h30Ycm: h30Y, h30YawDeg: yaw,
      h30Valid: true, h30HasAttitude: true, status: 0x0027,
    });
  } else if (values.length === 6) {
    Object.assign(frame, {
      posXcm: values[0], posYcm: values[1], posYawDeg: values[2],
      lidarXcm: values[3], lidarYcm: values[4], lidarYawDeg: values[5],
      lidarValid: true, status: 0x0038,
    });
  } else if (values.length >= 9) {
    Object.assign(frame, {
      posXcm: values[0], posYcm: values[1], posYawDeg: values[2],
      lidarXcm: values[3], lidarYcm: values[4], lidarYawDeg: values[5],
      calibXcm: values[6], calibYcm: values[7], calibYawDeg: values[8],
      encoderXcm: values[6], encoderYcm: values[7], h30YawDeg: values[8],
      h30Valid: true, h30HasAttitude: true, lidarValid: true, status: 0x002f,
    });
    if (values.length > 9) return { kind: "frame", frame, protocolVersion: "legacy-csv-9", warnings: ["trailing_fields"] };
  } else {
    return { kind: "error", code: "field_count", detail: `legacy CSV field count ${values.length}` };
  }
  return { kind: "frame", frame, protocolVersion: `legacy-csv-${values.length}`, warnings: [] };
}

export function parseLocator(
  line: string,
  observedAtMs: number,
  options: LocatorParserOptions = {},
): ParseOutcome<LocatorFrame> {
  const mode = options.mode ?? "auto";
  const allowNoCrc = options.allowNoCrc ?? true;
  const allowLegacyCsv = options.allowLegacyCsv ?? true;
  let rawLine = line.replace(/^\uFEFF/, "").replace(/[\0\r\n ]+$/g, "").trimStart();
  const r1mMarker = rawLine.indexOf("$R1M,");
  if (r1mMarker > 0) rawLine = rawLine.slice(r1mMarker);
  if (!rawLine) return { kind: "ignored", reason: "empty" };

  if ((mode === "auto" || mode === "r1m") && rawLine.startsWith("$R1M,")) {
    return parseR1m(rawLine, observedAtMs, allowNoCrc);
  }
  if (!allowLegacyCsv || mode === "r1m") return { kind: "ignored", reason: "unsupported_locator_line" };
  try {
    const values = parseNumbers(rawLine);
    if (mode === "r1_csv_v3") return parseV3(values, rawLine, observedAtMs);
    if (mode === "r1_csv_v2") return parseV2(values, rawLine, observedAtMs);
    if (values.length >= 25) return parseV2(values, rawLine, observedAtMs);
    if (values.length === 12) return parseV3(values, rawLine, observedAtMs);
    return parseLegacy(values, rawLine, observedAtMs);
  } catch (error) {
    return outcomeError(error);
  }
}

export class LocatorProtocolAdapter implements ProtocolAdapter<LocatorFrame> {
  readonly id = "locator-auto";
  readonly parserVersion = "3.0.0";

  constructor(private readonly options: LocatorParserOptions = {}) {}

  parse(line: string, observedAtMs: number): ParseOutcome<LocatorFrame> {
    return parseLocator(line, observedAtMs, this.options);
  }
}
