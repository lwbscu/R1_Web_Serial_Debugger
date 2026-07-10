import type { ParseOutcome, ProtocolAdapter } from "../core/types";
import type { RemoteFrame } from "./models";
import { integer, outcomeError } from "./numeric";

export const RDBG_FIELD_COUNT = 18;

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
  readonly parserVersion = "1.0.0";

  parse(line: string, observedAtMs: number): ParseOutcome<RemoteFrame> {
    const marker = line.search(/RDBG_CFG,|RDBG_CMD,|RDBG,/);
    if (marker < 0) return { kind: "ignored", reason: "unsupported_remote_line" };
    const clean = line.slice(marker).trim();
    if (clean.startsWith("RDBG,")) return parseRdbg(clean, observedAtMs);
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
