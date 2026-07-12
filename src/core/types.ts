export type SourceRole = "remote" | "chassis" | "locator";

export type PortLifecycle =
  | "idle"
  | "requesting"
  | "opening"
  | "reading"
  | "closing"
  | "error";

export type DataHealth = "no-data" | "bytes-only" | "format-mismatch" | "valid" | "stale" | "wrong-role";
export type TransportStatus = "not-selected" | "idle" | "opening" | "receiving" | "closing" | "error";
export type ProtocolStatus = "unknown" | "valid" | "stale" | "mismatch" | "wrong-role";

export interface ProtocolEvent {
  source: SourceRole;
  eventKind: string;
  observedAtMs: number;
  sourceTimeMs: number;
  fields: readonly unknown[];
  rawLine: string;
}

export type ParseOutcome<T> =
  | { kind: "frame"; frame: T; protocolVersion: string; warnings: string[] }
  | { kind: "event"; event: ProtocolEvent }
  | { kind: "ignored"; reason: string }
  | { kind: "error"; code: string; detail: string };

export interface ProtocolAdapter<T> {
  readonly id: string;
  readonly parserVersion: string;
  parse(line: string, observedAtMs: number): ParseOutcome<T>;
}
