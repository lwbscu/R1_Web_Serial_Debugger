import type { ParseOutcome, SourceRole } from "../types";
import {
  ChassisProtocolAdapter,
  detectProtocolRole,
  LocatorProtocolAdapter,
  RemoteProtocolAdapter,
} from "../../protocols";
import { LineFramer } from "./lineFramer";
import type { ReadOnlySerialPort, SerialReaderLike } from "./types";

export type ProbeConfidence = "confident" | "ambiguous" | "unknown";
export type ProbeReason = "classified" | "mixed_roles" | "duplicate_role" | "insufficient_evidence" | "timeout" | "cancelled" | "open_error" | "read_error";

export interface ProbeCandidate {
  id: string;
  port: ReadOnlySerialPort;
  label?: string;
}

export interface ProbeEvidence {
  role: SourceRole;
  line: string;
  outcome: "frame" | "event" | "error";
  protocolVersion?: string;
  score: number;
  detail?: string;
}

export interface PortProbeResult {
  id: string;
  label: string;
  usbLabel: string;
  portInfo: { usbVendorId?: number; usbProductId?: number };
  confidence: ProbeConfidence;
  role: SourceRole | null;
  reason: ProbeReason;
  evidence: ProbeEvidence[];
  scores: Record<SourceRole, number>;
  validFrameCounts: Record<SourceRole, number>;
  protocolEvidence: Record<SourceRole, Record<string, number>>;
  inspectedLines: number;
  framingWarnings: string[];
  error: string | null;
}

export interface PortProbeOptions {
  baudRate?: number;
  timeoutMs?: number;
  maxLines?: number;
  minValidFrames?: number;
  settleMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onRawLine?: (candidate: ProbeCandidate, line: string, observedAtMs: number) => void;
}

const ADAPTERS = {
  remote: new RemoteProtocolAdapter(),
  chassis: new ChassisProtocolAdapter(),
  locator: new LocatorProtocolAdapter(),
} as const;

class ProbeCancelledError extends Error {}
class ProbeTimeoutError extends Error {}

export function usbPortLabel(info: { usbVendorId?: number; usbProductId?: number }): string {
  const hex = (value: number | undefined) => value === undefined ? "????" : value.toString(16).toUpperCase().padStart(4, "0");
  return `VID ${hex(info.usbVendorId)} · PID ${hex(info.usbProductId)}`;
}

function blankScores(): Record<SourceRole, number> {
  return { remote: 0, chassis: 0, locator: 0 };
}

function blankProtocolEvidence(): Record<SourceRole, Record<string, number>> {
  return { remote: {}, chassis: {}, locator: {} };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEvidence(line: string, observedAtMs: number): ProbeEvidence[] {
  if (line.includes("CEVT,")) return [];
  const accepted: ProbeEvidence[] = [];
  for (const [role, adapter] of Object.entries(ADAPTERS) as Array<[SourceRole, typeof ADAPTERS[SourceRole]]>) {
    const outcome: ParseOutcome<unknown> = adapter.parse(line, observedAtMs);
    if (outcome.kind === "frame") {
      const strong = role !== "locator" || isStrongLocatorIdentity(line, outcome.protocolVersion, outcome.warnings);
      accepted.push({
        role, line, outcome: "frame", protocolVersion: outcome.protocolVersion, score: strong ? 3 : 1,
        detail: strong ? undefined : "兼容解析成功，但布局不足以自动确认设备身份；请手动连接确认。",
      });
    }
    else if (outcome.kind === "event") accepted.push({ role, line, outcome: "event", score: 1 });
  }
  if (accepted.length > 0) return accepted;

  const prefixedRole = detectProtocolRole(line);
  if (!prefixedRole) return [];
  const rejected = ADAPTERS[prefixedRole].parse(line, observedAtMs);
  if (rejected.kind !== "error") return [];
  const prefixOnly = prefixedRole === "remote" || prefixedRole === "chassis" ||
    (prefixedRole === "locator" && line.includes("$R1M,"));
  return [{
    role: prefixedRole,
    line,
    outcome: "error",
    protocolVersion: prefixOnly ? "prefix-only" : undefined,
    score: prefixOnly ? 1 : 0,
    detail: `${rejected.code}: ${rejected.detail}`,
  }];
}

function isStrongLocatorIdentity(line: string, protocolVersion: string, warnings: readonly string[]): boolean {
  const text = line.trim();
  if (protocolVersion.startsWith("r1m-v")) return text.startsWith("$R1M,") && !warnings.includes("no_crc");
  if (warnings.includes("trailing_fields")) return false;
  const fieldCount = text.split(",").filter((part) => part.trim() !== "").length;
  if (protocolVersion === "r1-csv-v3") return fieldCount === 12;
  if (protocolVersion === "r1-csv-v2") return fieldCount === 25;
  if (protocolVersion === "r1-csv-v2-diag") return fieldCount === 41;
  return false;
}

function waitForPromise<T>(promise: Promise<T>, remainingMs: number, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted) return Promise.reject(new ProbeCancelledError("probe cancelled"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new ProbeCancelledError("probe cancelled")));
    const timer = setTimeout(() => finish(() => reject(new ProbeTimeoutError("probe timeout"))), Math.max(0, remainingMs));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function waitForRead(
  reader: SerialReaderLike,
  remainingMs: number,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) return Promise.reject(new ProbeCancelledError("probe cancelled"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new ProbeCancelledError("probe cancelled")));
    const timer = setTimeout(() => finish(() => reject(new ProbeTimeoutError("probe timeout"))), Math.max(0, remainingMs));
    signal?.addEventListener("abort", abort, { once: true });
    // Close the small race between the initial check and registering the listener.
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      reader.read().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function hasConsistentFrames(result: PortProbeResult, role: SourceRole, minValidFrames: number): boolean {
  if ((result.protocolEvidence[role]["prefix-only"] ?? 0) >= minValidFrames) return true;
  return result.validFrameCounts[role] >= minValidFrames
    && Object.values(result.protocolEvidence[role]).some((count) => count >= minValidFrames);
}

function classify(result: PortProbeResult, minValidFrames: number, terminalReason?: ProbeReason): PortProbeResult {
  const ranked = (Object.entries(result.scores) as Array<[SourceRole, number]>).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
  const qualified = (["remote", "chassis", "locator"] as const).filter((role) => hasConsistentFrames(result, role, minValidFrames));
  if (qualified.length === 1 && ranked.length === 1) {
    return { ...result, confidence: "confident", role: qualified[0]!, reason: "classified" };
  }
  if (qualified.length > 1 || ranked.length > 1) {
    return { ...result, confidence: "ambiguous", role: qualified[0] ?? ranked[0]?.[0] ?? null, reason: "mixed_roles" };
  }
  return { ...result, confidence: "unknown", role: ranked[0]?.[0] ?? null, reason: terminalReason ?? "insufficient_evidence" };
}

export async function probePort(candidate: ProbeCandidate, options: PortProbeOptions = {}): Promise<PortProbeResult> {
  const baudRate = options.baudRate ?? 115200;
  const timeoutMs = options.timeoutMs ?? 2800;
  const maxLines = options.maxLines ?? 36;
  const minValidFrames = options.minValidFrames ?? 3;
  const settleMs = options.settleMs ?? 150;
  const now = options.now ?? (() => performance.now());
  const info = candidate.port.getInfo?.() ?? {};
  let result: PortProbeResult = {
    id: candidate.id,
    label: candidate.label ?? candidate.id,
    usbLabel: usbPortLabel(info),
    portInfo: info,
    confidence: "unknown",
    role: null,
    reason: "insufficient_evidence",
    evidence: [],
    scores: blankScores(),
    validFrameCounts: blankScores(),
    protocolEvidence: blankProtocolEvidence(),
    inspectedLines: 0,
    framingWarnings: [],
    error: null,
  };
  if (options.signal?.aborted) return { ...result, reason: "cancelled" };

  let reader: SerialReaderLike | null = null;
  let opened = false;
  let streamDone = false;
  const framer = new LineFramer();
  const startedAt = now();
  let qualifiedAt: number | null = null;
  const accept = (line: string, warnings: readonly string[]): void => {
    if (!line || result.inspectedLines >= maxLines) return;
    options.onRawLine?.(candidate, line, now());
    result.inspectedLines += 1;
    for (const warning of warnings) if (!result.framingWarnings.includes(warning)) result.framingWarnings.push(warning);
    const evidenceItems = parseEvidence(line, now());
    for (const evidence of evidenceItems) {
      if (result.evidence.length < maxLines) result.evidence.push(evidence);
      result.scores[evidence.role] += evidence.score;
      if (evidence.outcome === "error" && evidence.protocolVersion === "prefix-only" && evidence.score > 0) {
        const protocols = result.protocolEvidence[evidence.role];
        protocols[evidence.protocolVersion] = (protocols[evidence.protocolVersion] ?? 0) + 1;
      }
      if (evidence.outcome === "frame" && evidence.protocolVersion && evidence.score >= 3) {
        result.validFrameCounts[evidence.role] += 1;
        const protocols = result.protocolEvidence[evidence.role];
        protocols[evidence.protocolVersion] = (protocols[evidence.protocolVersion] ?? 0) + 1;
      }
    }
    const qualifiedRoles = (["remote", "chassis", "locator"] as const).filter((role) => hasConsistentFrames(result, role, minValidFrames));
    if (qualifiedAt === null && qualifiedRoles.length === 1 && Object.values(result.scores).filter((score) => score > 0).length === 1) qualifiedAt = now();
  };

  try {
    let openSettled = false;
    const openPromise = candidate.port.open({ baudRate }).then(
      () => { openSettled = true; },
      (error) => { openSettled = true; throw error; },
    );
    try {
      await waitForPromise(openPromise, timeoutMs - (now() - startedAt), options.signal);
    } catch (error) {
      if (!openSettled) {
        void openPromise.then(() => candidate.port.close()).catch(() => undefined);
      }
      throw error;
    }
    opened = true;
    if (!candidate.port.readable) throw new Error("serial port opened without a readable stream");
    reader = candidate.port.readable.getReader();
    while (result.inspectedLines < maxLines) {
      const deadline = qualifiedAt === null ? startedAt + timeoutMs : Math.min(startedAt + timeoutMs, qualifiedAt + settleMs);
      const remaining = deadline - now();
      if (remaining <= 0) throw new ProbeTimeoutError("probe timeout");
      const readResult = await waitForRead(reader, remaining, options.signal);
      if (readResult.done) { streamDone = true; break; }
      if (!readResult.value?.byteLength) continue;
      for (const framed of framer.push(readResult.value)) accept(framed.line, framed.warnings);
    }
    for (const framed of framer.flush()) accept(framed.line, framed.warnings);
    result = classify(result, minValidFrames);
  } catch (error) {
    if (error instanceof ProbeCancelledError) result = { ...result, confidence: "unknown", role: null, reason: "cancelled" };
    else if (error instanceof ProbeTimeoutError) result = classify(result, minValidFrames, "timeout");
    else {
      result.error = describe(error);
      result = classify(result, minValidFrames, opened ? "read_error" : "open_error");
    }
  } finally {
    if (reader) {
      if (!streamDone) { try { await reader.cancel("probe complete"); } catch { /* disconnected */ } }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    if (opened) { try { await candidate.port.close(); } catch (error) { result.error ??= describe(error); } }
  }
  return result;
}

export async function probePorts(candidates: readonly ProbeCandidate[], options: PortProbeOptions = {}): Promise<PortProbeResult[]> {
  const results = await Promise.all(candidates.map((candidate) => probePort(candidate, options)));
  const byRole = new Map<SourceRole, number[]>();
  results.forEach((result, index) => {
    if (result.confidence !== "confident" || !result.role) return;
    const indexes = byRole.get(result.role) ?? [];
    indexes.push(index); byRole.set(result.role, indexes);
  });
  for (const indexes of byRole.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      results[index] = { ...results[index]!, confidence: "ambiguous", reason: "duplicate_role" };
    }
  }
  return results;
}
