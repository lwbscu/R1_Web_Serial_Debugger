import type { SessionFileStore } from "./fileStore";
import { toBytes, type StoredData } from "./fileStore";
import { readSession } from "./repository";
import {
  expectedArtifacts,
  type RecordingArtifact,
  type RecordingCheckpoint,
  type SessionManifest,
} from "./types";

const encoder = new TextEncoder();
const QUICK_EXPORT_SCHEMA_VERSION = 1;
const QUICK_EXPORTER_VERSION = "quick-zip-v1";
const CODEX_README_NAME = "README_Codex.md";
const ZIP32_LIMIT = 0xffffffff;
const QUICK_SERIAL_EXPORT_ARTIFACTS = new Set<RecordingArtifact>([
  "remote_raw.log",
  "chassis_raw.log",
  "locator_raw.log",
  "raw_serial.log",
  "connection_status.csv",
]);

export type QuickExportStatus = "recording" | "ready" | "failed";

export interface QuickExportChunk {
  path: string;
  offset: number;
  length: number;
}

export interface QuickExportEntry {
  name: string;
  crc32: number;
  sizeBytes: number;
  firstObservedAtMs?: number;
  lastObservedAtMs?: number;
  chunks: QuickExportChunk[];
}

export interface QuickExportManifest {
  schemaVersion: 1;
  exporterVersion: typeof QUICK_EXPORTER_VERSION;
  sessionId: string;
  kind: SessionManifest["kind"];
  status: QuickExportStatus;
  startedAtMs: number;
  updatedAtMs: number;
  entries: QuickExportEntry[];
  zip?: {
    filename: string;
    sizeBytes: number;
    firstObservedAtMs: number;
    lastObservedAtMs: number;
    entryCount: number;
  };
  error?: string;
}

export interface QuickExportAppendChunk {
  artifact: RecordingArtifact;
  data: StoredData;
  path: string;
  offset: number;
  observedAtMs: number;
}

export interface PreparedQuickExportVolume {
  filename: string;
  index: 1;
  total: 1;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  sizeBytes: number;
  blob: Blob;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

export function crc32(bytes: Uint8Array, seed = 0): number {
  let value = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)) >>> 0;
  return (value ^ 0xffffffff) >>> 0;
}

export function isQuickSerialExportArtifact(artifact: RecordingArtifact): boolean {
  return QUICK_SERIAL_EXPORT_ARTIFACTS.has(artifact);
}

function safeSessionId(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("sessionId may only contain letters, digits, underscore, and hyphen");
  }
  return sessionId;
}

function sessionRoot(sessionId: string): string {
  return `sessions/${safeSessionId(sessionId)}`;
}

function quickExportPath(sessionId: string): string {
  return `${sessionRoot(sessionId)}/export.quickSerial.manifest.json`;
}

function quickExportDataPath(sessionId: string, name: string): string {
  return `${sessionRoot(sessionId)}/quick-export/${name}`;
}

function safeDownloadStem(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function quickArtifactsForManifest(manifest: SessionManifest): readonly RecordingArtifact[] {
  return expectedArtifacts(manifest.kind).filter((artifact) => QUICK_SERIAL_EXPORT_ARTIFACTS.has(artifact));
}

async function readQuickExportManifest(store: SessionFileStore, sessionId: string): Promise<QuickExportManifest | null> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await store.read(quickExportPath(sessionId)))) as QuickExportManifest;
    if (
      parsed.schemaVersion !== QUICK_EXPORT_SCHEMA_VERSION ||
      parsed.exporterVersion !== QUICK_EXPORTER_VERSION ||
      parsed.sessionId !== sessionId
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeQuickExportManifest(store: SessionFileStore, manifest: QuickExportManifest): Promise<void> {
  await store.write(quickExportPath(manifest.sessionId), JSON.stringify(manifest, null, 2));
}

function emptyQuickExportManifest(manifest: SessionManifest, startedAtMs: number): QuickExportManifest {
  return {
    schemaVersion: QUICK_EXPORT_SCHEMA_VERSION,
    exporterVersion: QUICK_EXPORTER_VERSION,
    sessionId: manifest.sessionId,
    kind: manifest.kind,
    status: "recording",
    startedAtMs,
    updatedAtMs: startedAtMs,
    entries: quickArtifactsForManifest(manifest).map((artifact) => ({
      name: artifact,
      crc32: 0,
      sizeBytes: 0,
      chunks: [],
    })),
  };
}

export async function createQuickExportManifest(
  store: SessionFileStore,
  manifest: SessionManifest,
  startedAtMs: number,
): Promise<void> {
  if (manifest.recordingProfile !== "quickSerial") return;
  await writeQuickExportManifest(store, emptyQuickExportManifest(manifest, startedAtMs));
}

export async function appendQuickExportChunks(
  store: SessionFileStore,
  manifest: SessionManifest,
  chunks: readonly QuickExportAppendChunk[],
  updatedAtMs: number,
): Promise<void> {
  if (manifest.recordingProfile !== "quickSerial") return;
  const quickChunks = chunks.filter((chunk) => QUICK_SERIAL_EXPORT_ARTIFACTS.has(chunk.artifact));
  if (quickChunks.length === 0) return;
  const startedAtMs = Date.parse(manifest.startedAt);
  const quickManifest = await readQuickExportManifest(store, manifest.sessionId)
    ?? emptyQuickExportManifest(manifest, Number.isFinite(startedAtMs) ? startedAtMs : updatedAtMs);
  const byName = new Map(quickManifest.entries.map((entry) => [entry.name, entry]));

  for (const chunk of quickChunks) {
    let entry = byName.get(chunk.artifact);
    if (!entry) {
      entry = { name: chunk.artifact, crc32: 0, sizeBytes: 0, chunks: [] };
      quickManifest.entries.push(entry);
      byName.set(chunk.artifact, entry);
    }
    const bytes = toBytes(chunk.data);
    if (bytes.byteLength === 0) continue;
    entry.crc32 = crc32(bytes, entry.crc32);
    entry.sizeBytes += bytes.byteLength;
    entry.firstObservedAtMs = Math.min(entry.firstObservedAtMs ?? chunk.observedAtMs, chunk.observedAtMs);
    entry.lastObservedAtMs = Math.max(entry.lastObservedAtMs ?? chunk.observedAtMs, chunk.observedAtMs);
    const previous = entry.chunks.at(-1);
    if (previous && previous.path === chunk.path && previous.offset + previous.length === chunk.offset) {
      previous.length += bytes.byteLength;
    } else {
      entry.chunks.push({
        path: chunk.path,
        offset: chunk.offset,
        length: bytes.byteLength,
      });
    }
  }

  quickManifest.status = "recording";
  quickManifest.updatedAtMs = updatedAtMs;
  delete quickManifest.zip;
  delete quickManifest.error;
  await writeQuickExportManifest(store, quickManifest);
}

function storedQuickBytes(checkpoint: RecordingCheckpoint): Map<string, number> {
  const expected = new Map<string, number>();
  for (const segment of checkpoint.segments) {
    for (const artifact of Object.values(segment.artifacts)) {
      if (!artifact || !QUICK_SERIAL_EXPORT_ARTIFACTS.has(artifact.name)) continue;
      expected.set(artifact.path, (expected.get(artifact.path) ?? 0) + artifact.sizeBytes);
    }
  }
  return expected;
}

function validateQuickManifest(manifest: QuickExportManifest, checkpoint: RecordingCheckpoint): boolean {
  const expected = storedQuickBytes(checkpoint);
  const actual = new Map<string, number>();
  for (const entry of manifest.entries) {
    for (const chunk of entry.chunks) {
      actual.set(chunk.path, (actual.get(chunk.path) ?? 0) + chunk.length);
    }
  }
  if (expected.size !== actual.size) return false;
  for (const [path, size] of expected) {
    if (actual.get(path) !== size) return false;
  }
  return true;
}

function exportMetadata(
  manifest: SessionManifest,
  firstObservedAtMs: number,
  lastObservedAtMs: number,
): Uint8Array {
  return encoder.encode(
    JSON.stringify(
      {
        ...manifest,
        export: {
          format: "r1-web-serial-debugger",
          schemaVersion: 1,
          volume: 1,
          volumeCount: 1,
          firstObservedAtMs,
          lastObservedAtMs,
          quickExport: QUICK_EXPORTER_VERSION,
        },
      },
      null,
      2,
    ),
  );
}

function exportCodexReadme(manifest: SessionManifest): Uint8Array {
  const profile = manifest.recordingProfile ?? "full";
  const lines = [
    "# R1 Recording Package",
    "",
    `sessionId: ${manifest.sessionId}`,
    `kind: ${manifest.kind}`,
    `profile: ${profile}`,
    `startedAt: ${manifest.startedAt}`,
    "",
    "## 文件含义",
    "",
    "- `remote_raw.log`: 遥控器串口原始行。常见内容包括 `RDBG` 摘要和 `RDBG_TX` 真实 NRF 发包事件。",
    "- `chassis_raw.log`: 底盘串口原始行。常见内容包括 `CDBG` 主诊断帧和 `CEVT` 事件。",
    "- `locator_raw.log` / `raw_serial.log`: 定位/码盘板串口原始行。",
    "- `connection_status.csv`: 三串口连接状态变化，旧列保持 role、health、lifecycle、RX 字节和帧数，追加 transport/protocol 分层状态与计数。",
    "- `session.json` / `metadata.json`: 录制会话、版本、分卷和时间窗口元数据。",
    "",
    "## 快速串口包",
    "",
    "快速串口包只保存原始串口数据和连接状态，便于 Codex 后续离线重放分析。",
    "原始行在协议解析前写入；协议不匹配、浏览器 stale、USB close/open 都不等于车端 NRF 断连。",
    "该模式不会保存解析派生 CSV、诊断事件 CSV，也不会包含地图 PNG 或网页画布导出。",
    "本包使用预生成快速 ZIP 清单封口，文件内容不压缩，停止时无需重新读取完整串口日志。",
    "",
  ];
  return encoder.encode(lines.join("\n"));
}

function firstObserved(checkpoint: RecordingCheckpoint): number {
  return checkpoint.segments[0]?.startedAtMs ?? checkpoint.startedAtMs;
}

function lastObserved(checkpoint: RecordingCheckpoint): number {
  return checkpoint.segments.at(-1)?.endedAtMs ?? checkpoint.updatedAtMs;
}

async function addSmallEntry(
  store: SessionFileStore,
  quickManifest: QuickExportManifest,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const path = quickExportDataPath(quickManifest.sessionId, name);
  await store.write(path, bytes);
  const entry: QuickExportEntry = {
    name,
    crc32: crc32(bytes),
    sizeBytes: bytes.byteLength,
    chunks: [{ path, offset: 0, length: bytes.byteLength }],
  };
  const existingIndex = quickManifest.entries.findIndex((item) => item.name === name);
  if (existingIndex >= 0) quickManifest.entries[existingIndex] = entry;
  else quickManifest.entries.push(entry);
}

export async function prepareQuickSerialExport(store: SessionFileStore, sessionId: string): Promise<QuickExportManifest | null> {
  const { manifest, checkpoint } = await readSession(store, sessionId);
  if (manifest.recordingProfile !== "quickSerial") return null;
  const quickManifest = await readQuickExportManifest(store, sessionId);
  if (!quickManifest || quickManifest.status === "failed") return null;
  if (!validateQuickManifest(quickManifest, checkpoint)) {
    quickManifest.status = "failed";
    quickManifest.error = "Quick export manifest is stale; falling back to legacy export.";
    quickManifest.updatedAtMs = checkpoint.updatedAtMs;
    await writeQuickExportManifest(store, quickManifest);
    return null;
  }

  const metadataName = manifest.kind === "locator" ? "metadata.json" : "session.json";
  const observedFirst = firstObserved(checkpoint);
  const observedLast = lastObserved(checkpoint);
  await addSmallEntry(store, quickManifest, metadataName, exportMetadata(manifest, observedFirst, observedLast));
  await addSmallEntry(store, quickManifest, CODEX_README_NAME, exportCodexReadme(manifest));

  quickManifest.entries.sort((left, right) => {
    const order = [...quickArtifactsForManifest(manifest), metadataName, CODEX_README_NAME];
    return order.indexOf(left.name as RecordingArtifact) - order.indexOf(right.name as RecordingArtifact);
  });

  const zipSizeBytes = estimateStoredZipSize(quickManifest.entries);
  quickManifest.status = "ready";
  quickManifest.updatedAtMs = checkpoint.updatedAtMs;
  quickManifest.zip = {
    filename: `${safeDownloadStem(sessionId)}.zip`,
    sizeBytes: zipSizeBytes,
    firstObservedAtMs: observedFirst,
    lastObservedAtMs: observedLast,
    entryCount: quickManifest.entries.length,
  };
  delete quickManifest.error;
  await writeQuickExportManifest(store, quickManifest);
  return quickManifest;
}

function dosDateTime(ms: number): { time: number; date: number } {
  const date = new Date(ms);
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function writeU16(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
  output[offset + 2] = (value >>> 16) & 0xff;
  output[offset + 3] = (value >>> 24) & 0xff;
}

function assertZip32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_LIMIT) {
    throw new Error(`${label} exceeds ZIP32 limits; falling back to legacy export.`);
  }
}

function localHeader(entry: QuickExportEntry, offsetMs: number): Uint8Array {
  const name = encoder.encode(entry.name);
  const { time, date } = dosDateTime(offsetMs);
  const output = new Uint8Array(30 + name.byteLength);
  writeU32(output, 0, 0x04034b50);
  writeU16(output, 4, 20);
  writeU16(output, 6, 0);
  writeU16(output, 8, 0);
  writeU16(output, 10, time);
  writeU16(output, 12, date);
  writeU32(output, 14, entry.crc32);
  writeU32(output, 18, entry.sizeBytes);
  writeU32(output, 22, entry.sizeBytes);
  writeU16(output, 26, name.byteLength);
  writeU16(output, 28, 0);
  output.set(name, 30);
  return output;
}

function centralDirectoryHeader(entry: QuickExportEntry, localHeaderOffset: number, offsetMs: number): Uint8Array {
  const name = encoder.encode(entry.name);
  const { time, date } = dosDateTime(offsetMs);
  const output = new Uint8Array(46 + name.byteLength);
  writeU32(output, 0, 0x02014b50);
  writeU16(output, 4, 20);
  writeU16(output, 6, 20);
  writeU16(output, 8, 0);
  writeU16(output, 10, 0);
  writeU16(output, 12, time);
  writeU16(output, 14, date);
  writeU32(output, 16, entry.crc32);
  writeU32(output, 20, entry.sizeBytes);
  writeU32(output, 24, entry.sizeBytes);
  writeU16(output, 28, name.byteLength);
  writeU16(output, 30, 0);
  writeU16(output, 32, 0);
  writeU16(output, 34, 0);
  writeU16(output, 36, 0);
  writeU32(output, 38, 0);
  writeU32(output, 42, localHeaderOffset);
  output.set(name, 46);
  return output;
}

function endOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Uint8Array {
  const output = new Uint8Array(22);
  writeU32(output, 0, 0x06054b50);
  writeU16(output, 4, 0);
  writeU16(output, 6, 0);
  writeU16(output, 8, entryCount);
  writeU16(output, 10, entryCount);
  writeU32(output, 12, centralSize);
  writeU32(output, 16, centralOffset);
  writeU16(output, 20, 0);
  return output;
}

function estimateStoredZipSize(entries: readonly QuickExportEntry[]): number {
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name).byteLength;
    assertZip32(entry.sizeBytes, `${entry.name} size`);
    offset += 30 + nameBytes + entry.sizeBytes;
    assertZip32(offset, "ZIP local data offset");
  }
  const centralOffset = offset;
  for (const entry of entries) {
    offset += 46 + encoder.encode(entry.name).byteLength;
    assertZip32(offset, "ZIP central directory offset");
  }
  assertZip32(offset - centralOffset, "ZIP central directory size");
  assertZip32(offset + 22, "ZIP size");
  if (entries.length > 0xffff) throw new Error("ZIP entry count exceeds ZIP32 limits.");
  return offset + 22;
}

export async function readPreparedQuickSerialVolume(
  store: SessionFileStore,
  sessionId: string,
): Promise<PreparedQuickExportVolume | null> {
  const quickManifest = await readQuickExportManifest(store, sessionId);
  if (!quickManifest || quickManifest.status !== "ready" || !quickManifest.zip) return null;
  estimateStoredZipSize(quickManifest.entries);
  const parts: BlobPart[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const timestamp = quickManifest.updatedAtMs;

  for (const entry of quickManifest.entries) {
    assertZip32(offset, `${entry.name} local header offset`);
    const header = localHeader(entry, timestamp);
    parts.push(header);
    centralParts.push(centralDirectoryHeader(entry, offset, timestamp));
    offset += header.byteLength;
    for (const chunk of entry.chunks) {
      const blob = await store.readBlob(chunk.path);
      parts.push(blob.slice(chunk.offset, chunk.offset + chunk.length));
      offset += chunk.length;
    }
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const part of centralParts) {
    parts.push(part);
    centralSize += part.byteLength;
    offset += part.byteLength;
  }
  parts.push(endOfCentralDirectory(quickManifest.entries.length, centralSize, centralOffset));
  offset += 22;

  if (offset !== quickManifest.zip.sizeBytes) {
    throw new Error("Prepared quick ZIP manifest size mismatch; falling back to legacy export.");
  }

  return {
    filename: quickManifest.zip.filename,
    index: 1,
    total: 1,
    firstObservedAtMs: quickManifest.zip.firstObservedAtMs,
    lastObservedAtMs: quickManifest.zip.lastObservedAtMs,
    sizeBytes: quickManifest.zip.sizeBytes,
    blob: new Blob(parts, { type: "application/zip" }),
  };
}

export const quickExportPaths = { quickExportPath };
