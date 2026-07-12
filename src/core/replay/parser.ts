import type { ParseReplayOptions, ReplayFormat, ReplayRecord } from "./types";

const DEFAULT_INTERVAL_MS = 20;
const TIMESTAMP_HEADERS = [
  "capture_elapsed_ms",
  "source_time_ms",
  "observed_at_ms",
  "timestamp_ms",
  "time_ms",
  "pc_time",
  "timestamp",
  "time_s",
  "elapsed_s",
  "elapsed_ms",
] as const;

interface CsvSourceRecord {
  raw: string;
  lineNumber: number;
}

function splitCsvRecords(text: string): CsvSourceRecord[] {
  const records: CsvSourceRecord[] = [];
  let start = 0;
  let startLine = 1;
  let line = 1;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (char === "\n") {
      if (!quoted) {
        const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
        records.push({ raw: text.slice(start, end), lineNumber: startLine });
        start = index + 1;
        startLine = line + 1;
      }
      line += 1;
    }
  }
  if (start < text.length) records.push({ raw: text.slice(start), lineNumber: startLine });
  return records;
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

function looksLikeHeader(fields: string[]): boolean {
  const normalized = fields.map(normalizeHeader);
  return normalized.some((field) => TIMESTAMP_HEADERS.includes(field as (typeof TIMESTAMP_HEADERS)[number])) ||
    normalized.some((field) => /^(x|y|yaw|frame|status|protocol|channel|signal)/.test(field));
}

function columnIndex(headers: readonly string[], requested: string | undefined): number {
  if (!requested) return -1;
  const normalized = normalizeHeader(requested);
  const direct = headers.indexOf(normalized);
  if (direct >= 0) return direct;
  const positional = /^column_(\d+)$/.exec(normalized);
  if (!positional) return -1;
  const index = Number(positional[1]) - 1;
  return Number.isInteger(index) && index >= 0 && index < headers.length ? index : -1;
}

function inferFormat(lines: string[], requested: ReplayFormat): Exclude<ReplayFormat, "auto"> {
  if (requested !== "auto") return requested;
  const sample = lines.find((line) => line.trim().length > 0) ?? "";
  if (/^(?:\s*\[[^\]]+\]\s*)?(?:RDBG_TX|RDBG|CDBG|CEVT|DBG_META|RDBG_CFG|RDBG_CMD|CDBG_BOOT|\$R1M),/.test(sample)) {
    return "raw";
  }
  return sample.includes(",") ? "csv" : "raw";
}

function numericTimestamp(value: string, header: string, unit?: "milliseconds" | "seconds"): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const resolvedUnit = unit ?? (header === "pc_time" || (/(_s|seconds?)$/.test(header) && !/_ms$/.test(header)) ? "seconds" : "milliseconds");
  if (resolvedUnit === "seconds") return number * 1000;
  // Epoch seconds are commonly stored under a generic "timestamp" header.
  if (header === "timestamp" && number > 1e9 && number < 1e11) return number * 1000;
  return number;
}

function parseDateOrNumber(value: string, header: string, unit?: "milliseconds" | "seconds"): number | undefined {
  const numeric = numericTimestamp(value.trim(), header, unit);
  if (numeric !== undefined) return numeric;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rawTimestamp(line: string): { observedAtMs?: number; payload: string } {
  const bracketed = /^\s*\[([^\]]+)]\s*(.*)$/.exec(line);
  if (bracketed) {
    const token = bracketed[1]!.trim();
    const asNumber = Number(token);
    const observedAtMs = Number.isFinite(asNumber)
      ? asNumber * 1000
      : Number.isFinite(Date.parse(token))
        ? Date.parse(token)
        : undefined;
    if (observedAtMs !== undefined) return { observedAtMs, payload: bracketed[2]! };
  }

  const iso = /^\s*(\d{4}-\d{2}-\d{2}T\S+|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*[|,]?\s+(.*)$/.exec(line);
  if (iso) {
    const observedAtMs = Date.parse(iso[1]!);
    if (Number.isFinite(observedAtMs)) return { observedAtMs, payload: iso[2]! };
  }
  return { payload: line };
}

function monotonicRecords(
  rows: Array<Omit<ReplayRecord, "offsetMs">>,
  defaultIntervalMs: number,
): ReplayRecord[] {
  let firstTimestamp: number | undefined;
  let previousOffset = -defaultIntervalMs;
  return rows.map((row) => {
    let timestampOffset: number | undefined;
    if (row.observedAtMs !== undefined) {
      if (firstTimestamp === undefined) {
        firstTimestamp = row.observedAtMs;
        timestampOffset = previousOffset < 0 ? 0 : previousOffset + defaultIntervalMs;
      } else {
        timestampOffset = row.observedAtMs - firstTimestamp;
      }
    }
    const offsetMs =
      timestampOffset === undefined
        ? Math.max(0, previousOffset + defaultIntervalMs)
        : Math.max(0, previousOffset, timestampOffset);
    previousOffset = offsetMs;
    return { ...row, offsetMs };
  });
}

export function parseReplayText(text: string, options: ParseReplayOptions = {}): ReplayRecord[] {
  const defaultIntervalMs = options.defaultIntervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(defaultIntervalMs) || defaultIntervalMs < 0) {
    throw new Error("defaultIntervalMs must be a non-negative finite number");
  }
  const cleanText = text.replace(/^\uFEFF/, "");
  const lines = cleanText.split(/\r?\n/);
  const format = inferFormat(lines, options.format ?? "auto");
  const rows: Array<Omit<ReplayRecord, "offsetMs">> = [];

  if (format === "raw") {
    lines.forEach((raw, index) => {
      if (raw.length === 0) return;
      const parsed = rawTimestamp(raw);
      rows.push({ lineNumber: index + 1, raw, payload: parsed.payload, observedAtMs: parsed.observedAtMs });
    });
    return monotonicRecords(rows, defaultIntervalMs);
  }

  const csvRecords = splitCsvRecords(cleanText);
  const firstIndex = csvRecords.findIndex((record) => record.raw.trim().length > 0);
  if (firstIndex < 0) return [];
  const firstFields = parseCsvRow(csvRecords[firstIndex]!.raw);
  const hasHeader = looksLikeHeader(firstFields);
  const headers = hasHeader
    ? firstFields.map((field, index) => normalizeHeader(field) || `column_${index + 1}`)
    : firstFields.map((_, index) => `column_${index + 1}`);
  const requestedTimestamp = options.timestampColumn ? normalizeHeader(options.timestampColumn) : undefined;
  const timestampHeader = requestedTimestamp ?? headers.find((header) => TIMESTAMP_HEADERS.includes(header as (typeof TIMESTAMP_HEADERS)[number]));
  const timestampIndex = requestedTimestamp ? columnIndex(headers, requestedTimestamp) : timestampHeader ? headers.indexOf(timestampHeader) : -1;
  const payloadIndex = columnIndex(headers, options.payloadColumn);

  csvRecords.forEach(({ raw, lineNumber }, index) => {
    if (raw.length === 0 || (hasHeader && index === firstIndex)) return;
    const fields = parseCsvRow(raw);
    const columns = Object.fromEntries(headers.map((header, fieldIndex) => [header, fields[fieldIndex] ?? ""]));
    const observedAtMs =
      timestampIndex >= 0
        ? parseDateOrNumber(fields[timestampIndex] ?? "", timestampHeader ?? headers[timestampIndex]!, options.timestampUnit)
        : undefined;
    rows.push({ lineNumber, raw, payload: payloadIndex >= 0 ? fields[payloadIndex] ?? "" : raw, observedAtMs, columns });
  });
  return monotonicRecords(rows, defaultIntervalMs);
}

export const csvReplay = { parseRow: parseCsvRow };
