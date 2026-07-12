import type { ParseOutcome, ProtocolAdapter } from "../core/types";
import type { RemoteFrame, RemoteTxEvent } from "./models";
import { integer, outcomeError } from "./numeric";
import { parseDebugEvent } from "./cdbg";

export const RDBG_FIELD_COUNT = 18;
export const RDBG_TX_V1_FIELD_COUNT = 16;
export const RDBG_TX_V2_FIELD_COUNT = 19;
export const RDBG_TX_FIELD_COUNT = RDBG_TX_V1_FIELD_COUNT;

function optionalInteger(value: string, field: string): number | null {
  const text = value.trim();
  if (text === "" || /^(?:NA|N\/A|null|unknown|unavailable|-|—)$/i.test(text)) return null;
  return integer(text, field);
}

function optionalText(value: string): string | null {
  const text = value.trim();
  return text === "" || /^(?:NA|N\/A|null|unknown|unavailable|-|—)$/i.test(text) ? null : text;
}

function hexBytes(value: string, len: number, field: string): number[] {
  if (!Number.isInteger(len) || len < 0 || len > 32) throw new RangeError(`${field} length out of range: ${len}`);
  if (len === 0 && value === "-") return [];
  if (len === 0 && value !== "-") throw new Error(`${field} must be '-' when length is 0`);
  if (len > 0 && value === "-") throw new Error(`${field} is missing`);
  if (value.length !== len * 2) throw new Error(`${field} length ${value.length / 2} != ${len}`);
  if (!/^[0-9A-Fa-f]*$/.test(value)) throw new Error(`${field} is not hex`);
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 2) {
    bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return bytes;
}

export function parseRdbgTx(line: string, observedAtMs: number): ParseOutcome<RemoteTxEvent> {
  const marker = line.indexOf("RDBG_TX,");
  if (marker < 0) return { kind: "ignored", reason: "not_rdbg_tx" };
  const rawLine = line.slice(marker).trim();
  const parts = rawLine.split(",").map((part) => part.trim());
  if (parts[1] === "2") return parseRdbgTxV2(rawLine, parts, observedAtMs);
  if (parts.length !== RDBG_TX_V1_FIELD_COUNT) {
    return {
      kind: "error",
      code: parts.length < RDBG_TX_V1_FIELD_COUNT ? "incomplete_frame" : "trailing_fields",
      detail: `RDBG_TX field count ${parts.length} != ${RDBG_TX_V1_FIELD_COUNT}`,
    };
  }
  try {
    const version = integer(parts[1]!, "version");
    if (version !== 1) return { kind: "error", code: "unsupported_version", detail: `RDBG_TX unsupported version ${version}` };
    const txLen = integer(parts[5]!, "tx_len");
    const txHex = parts[6]!.toUpperCase();
    const ackLen = integer(parts[8]!, "ack_len");
    const ackHex = parts[9] === "-" ? "-" : parts[9]!.toUpperCase();
    const txBytes = hexBytes(txHex, txLen, "tx_hex");
    const ackBytes = hexBytes(ackHex, ackLen, "ack_hex");
    return {
      kind: "frame",
      protocolVersion: "rdbg-tx-v1",
      warnings: [],
      frame: {
        observedAtMs,
        rawLine,
        protocolVersion: 1,
        ms: integer(parts[2]!, "ms"),
        seq: integer(parts[3]!, "seq"),
        packetType: parts[4]!,
        txLen,
        txHex,
        txBytes,
        txRet: integer(parts[7]!, "tx_ret"),
        ackLen,
        ackHex,
        ackBytes,
        lost: integer(parts[10]!, "lost"),
        retry: integer(parts[11]!, "retry"),
        args: [
          integer(parts[12]!, "arg0"),
          integer(parts[13]!, "arg1"),
          integer(parts[14]!, "arg2"),
          integer(parts[15]!, "arg3"),
        ],
      },
    };
  } catch (error) {
    return outcomeError(error);
  }
}

function packetArgs(packetType: string, bytes: readonly number[]): [number, number, number, number] {
  if (packetType === "ACT" && bytes.length >= 5) return [bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0];
  if (packetType === "KEY" && bytes.length >= 2) return [bytes[1] ?? 0, 0, 0, 0];
  if ((packetType === "ADC" || packetType === "T") && bytes.length >= 9) {
    const word = (offset: number) => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
    return [word(1), word(3), word(5), word(7)];
  }
  if ((packetType === "MODE" || packetType === "VMODE") && bytes.length >= 5) {
    return [bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0];
  }
  return [0, 0, 0, 0];
}

function parseRdbgTxV2(rawLine: string, parts: readonly string[], observedAtMs: number): ParseOutcome<RemoteTxEvent> {
  if (parts.length !== RDBG_TX_V2_FIELD_COUNT) {
    return {
      kind: "error",
      code: parts.length < RDBG_TX_V2_FIELD_COUNT ? "incomplete_frame" : "trailing_fields",
      detail: `RDBG_TX v2 field count ${parts.length} != ${RDBG_TX_V2_FIELD_COUNT}`,
    };
  }
  try {
    const declared = integer(parts[2]!, "declared_count");
    if (declared !== RDBG_TX_V2_FIELD_COUNT) return { kind: "error", code: "unsupported_field_count", detail: `RDBG_TX v2 declared count ${declared}` };
    const txLen = integer(parts[6]!, "packet_len");
    const txHex = parts[7]!.toUpperCase();
    const ackLen = integer(parts[10]!, "ack_len");
    const ackHex = parts[11] === "-" ? "-" : parts[11]!.toUpperCase();
    const txBytes = hexBytes(txHex, txLen, "packet_hex");
    const ackBytes = hexBytes(ackHex, ackLen, "ack_hex");
    const packetType = parts[5]!;
    const failReason = optionalText(parts[9]!);
    if (failReason !== null && !new Set(["OK", "MAX_RT", "STATUS_TIMEOUT", "BAD_STATUS", "NO_ACK_PAYLOAD", "UNKNOWN"]).has(failReason)) {
      return { kind: "error", code: "invalid_enum", detail: `RDBG_TX fail_reason ${failReason}` };
    }
    const txRet = integer(parts[8]!, "tx_ret");
    return {
      kind: "frame",
      protocolVersion: "rdbg-tx-v2",
      warnings: [],
      frame: {
        observedAtMs,
        rawLine,
        protocolVersion: 2,
        ms: integer(parts[3]!, "ms"),
        seq: integer(parts[4]!, "tx_seq"),
        packetType,
        txLen,
        txHex,
        txBytes,
        txRet,
        ackLen,
        ackHex,
        ackBytes,
        lost: txRet === 0 ? 1 : 0,
        retry: integer(parts[12]!, "retry_count"),
        args: packetArgs(packetType, txBytes),
        failReason,
        statusReg: optionalInteger(parts[13]!, "status_reg"),
        fifoStatus: optionalInteger(parts[14]!, "fifo_status"),
        observeTx: optionalInteger(parts[15]!, "observe_tx"),
        linkOnline: optionalInteger(parts[16]!, "link_online"),
        noAckStreak: optionalInteger(parts[17]!, "no_ack_streak"),
        dropTotal: optionalInteger(parts[18]!, "rdbg_tx_drop_total"),
      },
    };
  } catch (error) {
    return outcomeError(error);
  }
}

export function parseRdbg(line: string, observedAtMs: number): ParseOutcome<RemoteFrame> {
  const marker = line.indexOf("RDBG,");
  if (marker < 0) return { kind: "ignored", reason: "not_rdbg" };
  const rawLine = line.slice(marker).trim();
  const incoming = rawLine.split(",").map((part) => part.trim());
  if (incoming.length < RDBG_FIELD_COUNT) {
    return {
      kind: "error",
      code: "incomplete_frame",
      detail: `RDBG incomplete field count ${incoming.length} < ${RDBG_FIELD_COUNT}`,
    };
  }
  const warnings = incoming.length > RDBG_FIELD_COUNT ? ["trailing_fields"] : [];
  const p = incoming.slice(0, RDBG_FIELD_COUNT);
  try {
    return {
      kind: "frame",
      protocolVersion: "rdbg-v1",
      warnings,
      frame: {
        observedAtMs,
        rawLine,
        ms: integer(p[1]!, "ms"),
        seq: integer(p[2]!, "seq"),
        packetType: p[3]!,
        rfCh: integer(p[4]!, "rf_ch"),
        txRet: integer(p[5]!, "tx_ret"),
        ackLen: integer(p[6]!, "ack_len"),
        failCount: integer(p[7]!, "fail_count"),
        ackOkCount: integer(p[8]!, "ack_ok_count"),
        signalBars: integer(p[9]!, "signal_bars"),
        linkReady: integer(p[10]!, "link_ready"),
        linkOnline: integer(p[11]!, "link_online"),
        noAckMs: integer(p[12]!, "no_ack_ms"),
        lost: integer(p[13]!, "lost"),
        retry: integer(p[14]!, "retry"),
        rxScore: integer(p[15]!, "rx_score"),
        localPresent: integer(p[16]!, "local_present"),
        xReason: p[17]!,
      },
    };
  } catch (error) {
    return outcomeError(error);
  }
}

export class RemoteProtocolAdapter implements ProtocolAdapter<RemoteFrame> {
  readonly id = "remote-rdbg";
  readonly parserVersion = "2.1.0";

  parse(line: string, observedAtMs: number): ParseOutcome<RemoteFrame> {
    const marker = line.search(/DBG_META,|CEVT,|RDBG_TX,|RDBG_CFG,|RDBG_CMD,|RDBG,/);
    if (marker < 0) return { kind: "ignored", reason: "unsupported_remote_line" };
    const clean = line.slice(marker).trim();
    if (clean.startsWith("RDBG,")) return parseRdbg(clean, observedAtMs);
    if (clean.startsWith("RDBG_TX,")) {
      const outcome = parseRdbgTx(clean, observedAtMs);
      if (outcome.kind !== "frame") return outcome;
      return {
        kind: "event",
        event: {
          source: "remote",
          eventKind: "RDBG_TX",
          observedAtMs,
          sourceTimeMs: outcome.frame.ms,
          fields: [
            outcome.frame.protocolVersion,
            outcome.frame.seq,
            outcome.frame.packetType,
            outcome.frame.txLen,
            outcome.frame.txHex,
            outcome.frame.txRet,
            outcome.frame.ackLen,
            outcome.frame.ackHex,
            outcome.frame.lost,
            outcome.frame.retry,
            ...outcome.frame.args,
            outcome.frame.failReason ?? "",
            outcome.frame.statusReg ?? "",
            outcome.frame.fifoStatus ?? "",
            outcome.frame.observeTx ?? "",
            outcome.frame.linkOnline ?? "",
            outcome.frame.noAckStreak ?? "",
            outcome.frame.dropTotal ?? "",
          ],
          rawLine: clean,
        },
      };
    }
    if (clean.startsWith("DBG_META,") || clean.startsWith("CEVT,")) {
      try {
        const outcome = parseDebugEvent(clean, observedAtMs, "remote");
        if (outcome.kind === "frame") return { kind: "error", code: "internal_parser_error", detail: "debug event returned a frame" };
        return outcome;
      } catch (error) {
        return outcomeError(error);
      }
    }
    const parts = clean.split(",").map((part) => part.trim());
    return {
      kind: "event",
      event: {
        source: "remote",
        eventKind: parts[0]!,
        observedAtMs,
        sourceTimeMs: 0,
        fields: parts.slice(1),
        rawLine: clean,
      },
    };
  }
}
