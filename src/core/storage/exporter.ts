import { AsyncZipDeflate, Zip, ZipPassThrough } from "fflate";

import type { SessionFileStore } from "./fileStore";
import { prepareQuickSerialExport, readPreparedQuickSerialVolume } from "./quickExport";
import { readSession } from "./repository";
import {
  DEFAULT_MAX_ZIP_VOLUME_BYTES,
  expectedArtifacts,
  type RecordingArtifact,
  type SessionManifest,
  type StoredSegment,
} from "./types";

export interface ExportedVolume {
  filename: string;
  index: number;
  total: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  bytes: Uint8Array | Blob;
  sizeBytes: number;
}

export interface ExportSessionOptions {
  maxVolumeBytes?: number;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  onProgress?: (progress: ExportSessionProgress) => void | Promise<void>;
}

export type ExportSessionProgressPhase = "reading" | "compressing" | "ready" | "done";

export interface ExportSessionProgress {
  phase: ExportSessionProgressPhase;
  sessionId: string;
  volumeIndex: number;
  volumeTotal: number;
  bytesRead: number;
  totalBytes: number;
  percent: number;
  filename?: string;
}

const encoder = new TextEncoder();
const CODEX_README_NAME = "README_Codex.md";
const QUICK_SERIAL_EXPORT_ARTIFACTS = new Set<RecordingArtifact>([
  "remote_raw.log",
  "chassis_raw.log",
  "locator_raw.log",
  "raw_serial.log",
  "connection_status.csv",
]);

function concatenate(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((size, part) => size + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function zipCompressionLevel(level: ExportSessionOptions["compressionLevel"]): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  return level ?? 0;
}

function exportCompressionLevel(manifest: SessionManifest, level: ExportSessionOptions["compressionLevel"]): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  if (manifest.recordingProfile === "quickSerial") return 0;
  return zipCompressionLevel(level);
}

function groupSegments(segments: StoredSegment[], maxVolumeBytes: number): StoredSegment[][] {
  if (maxVolumeBytes <= 0) throw new Error("maxVolumeBytes must be positive");
  const groups: StoredSegment[][] = [];
  let current: StoredSegment[] = [];
  let currentSize = 0;
  for (const segment of segments) {
    if (current.length > 0 && currentSize + segment.sizeBytes > maxVolumeBytes) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(segment);
    currentSize += segment.sizeBytes;
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [[]];
}

function safeDownloadStem(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function exportMetadata(
  manifest: SessionManifest,
  index: number,
  total: number,
  segments: StoredSegment[],
): Uint8Array {
  return encoder.encode(
    JSON.stringify(
      {
        ...manifest,
        export: {
          format: "r1-web-serial-debugger",
          schemaVersion: 1,
          volume: index + 1,
          volumeCount: total,
          firstObservedAtMs: segments[0]?.startedAtMs ?? Date.parse(manifest.startedAt),
          lastObservedAtMs: segments.at(-1)?.endedAtMs ?? Date.parse(manifest.startedAt),
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
    "该模式不会保存解析派生 CSV、诊断事件 CSV，也不会包含地图 PNG 或网页画布导出。",
    "",
    "## 完整诊断包额外文件",
    "",
    "- `remote_rdbg.csv`: 遥控器 `RDBG` 解析前的时间戳+原始行。",
    "- `remote_rdbg_tx.csv`: 遥控器 `RDBG_TX` 解析前的时间戳+原始行。",
    "- `chassis_cdbg.csv`: 底盘 `CDBG` 解析前的时间戳+原始行。",
    "- `chassis_cevt.csv`: 底盘 `CEVT` 解析前的时间戳+原始行。",
    "- `locator_frames.csv` / `locator_display_frames.csv`: 定位串口解析和显示轨迹数据。",
    "- `events.csv`: 网页实时诊断事件和解析错误摘要。",
    "",
  ];
  return encoder.encode(lines.join("\n"));
}

function segmentBytes(segments: readonly StoredSegment[]): number {
  return segments.reduce((total, segment) => total + segment.sizeBytes, 0);
}

function progressPercent(bytesRead: number, totalBytes: number, phase: ExportSessionProgressPhase): number {
  if (totalBytes <= 0) return phase === "reading" ? 0 : 100;
  return Math.min(100, Math.max(0, (bytesRead / totalBytes) * 100));
}

function addZipFile(zip: Zip, name: string, bytes: Uint8Array, level: ExportSessionOptions["compressionLevel"]): void {
  if (zipCompressionLevel(level) === 0) {
    const file = new ZipPassThrough(name);
    zip.add(file);
    file.push(bytes, true);
    return;
  }
  const file = new AsyncZipDeflate(name, { level: zipCompressionLevel(level) });
  zip.add(file);
  file.push(bytes, true);
}

function artifactsForExport(manifest: SessionManifest): readonly RecordingArtifact[] {
  const artifacts = expectedArtifacts(manifest.kind);
  if (manifest.recordingProfile !== "quickSerial") return artifacts;
  return artifacts.filter((artifact) => QUICK_SERIAL_EXPORT_ARTIFACTS.has(artifact));
}

async function buildZipVolume(
  store: SessionFileStore,
  manifest: SessionManifest,
  metadataName: RecordingArtifact,
  segments: readonly StoredSegment[],
  metadata: Uint8Array,
  compressionLevel: ExportSessionOptions["compressionLevel"],
  onBytesRead: (bytes: number) => Promise<void>,
  onCompressing: () => Promise<void>,
): Promise<Uint8Array> {
  const outputChunks: Uint8Array[] = [];
  let resolveDone: (value: Uint8Array) => void = () => undefined;
  let rejectDone: (reason: unknown) => void = () => undefined;
  const done = new Promise<Uint8Array>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const archive = new Zip((error, chunk, final) => {
    if (error) {
      rejectDone(error);
      return;
    }
    if (chunk) outputChunks.push(chunk);
    if (final) resolveDone(concatenate(outputChunks));
  });

  try {
    for (const artifact of artifactsForExport(manifest)) {
      if (artifact === metadataName) continue;
      const level = exportCompressionLevel(manifest, compressionLevel);
      const file = level === 0
        ? new ZipPassThrough(artifact)
        : new AsyncZipDeflate(artifact, { level });
      archive.add(file);
      for (const segment of segments) {
        const stored = segment.artifacts[artifact];
        if (!stored) continue;
        const bytes = await store.read(stored.path);
        await onBytesRead(bytes.byteLength);
        file.push(bytes, false);
      }
      file.push(new Uint8Array(), true);
    }
    await onCompressing();
    addZipFile(archive, metadataName, metadata, exportCompressionLevel(manifest, compressionLevel));
    addZipFile(archive, CODEX_README_NAME, exportCodexReadme(manifest), exportCompressionLevel(manifest, compressionLevel));
    archive.end();
    return await done;
  } catch (error) {
    archive.terminate();
    throw error;
  }
}

/**
 * Produces consecutive time-window ZIP volumes. Each volume keeps the canonical
 * Python-compatible filenames, so a consumer can process every numbered ZIP as
 * an independent time window.
 */
export async function exportSession(
  store: SessionFileStore,
  sessionId: string,
  options: ExportSessionOptions = {},
): Promise<ExportedVolume[]> {
  const results: ExportedVolume[] = [];
  for await (const volume of exportSessionVolumes(store, sessionId, options)) results.push(volume);
  return results;
}

/**
 * Bounded-memory export path for the UI. Each ZIP volume is produced and can be
 * downloaded/released before the next volume is assembled.
 */
export async function* exportSessionVolumes(
  store: SessionFileStore,
  sessionId: string,
  options: ExportSessionOptions = {},
): AsyncGenerator<ExportedVolume, void, void> {
  const { manifest, checkpoint } = await readSession(store, sessionId);
  if (manifest.recordingProfile === "quickSerial") {
    try {
      await prepareQuickSerialExport(store, sessionId);
      const prepared = await readPreparedQuickSerialVolume(store, sessionId);
      if (prepared) {
        const report = async (phase: ExportSessionProgressPhase, filename?: string): Promise<void> => {
          await options.onProgress?.({
            phase,
            sessionId,
            volumeIndex: 1,
            volumeTotal: 1,
            bytesRead: prepared.sizeBytes,
            totalBytes: prepared.sizeBytes,
            percent: 100,
            filename,
          });
        };
        await report("reading");
        await report("compressing");
        await report("ready", prepared.filename);
        yield {
          filename: prepared.filename,
          index: 1,
          total: 1,
          firstObservedAtMs: prepared.firstObservedAtMs,
          lastObservedAtMs: prepared.lastObservedAtMs,
          bytes: prepared.blob,
          sizeBytes: prepared.sizeBytes,
        };
        await report("done");
        return;
      }
    } catch {
      // A missing or stale quick manifest falls back to the established export path.
    }
  }
  const maxVolumeBytes = options.maxVolumeBytes ?? DEFAULT_MAX_ZIP_VOLUME_BYTES;
  const groups = groupSegments(checkpoint.segments, maxVolumeBytes);
  const width = Math.max(3, String(groups.length).length);
  const stem = safeDownloadStem(sessionId);
  const metadataName: RecordingArtifact =
    manifest.kind === "locator" ? "metadata.json" : "session.json";
  const totalBytes = segmentBytes(checkpoint.segments);
  let bytesRead = 0;

  const report = async (phase: ExportSessionProgressPhase, index: number, filename?: string): Promise<void> => {
    await options.onProgress?.({
      phase,
      sessionId,
      volumeIndex: Math.min(index + 1, groups.length),
      volumeTotal: groups.length,
      bytesRead,
      totalBytes,
      percent: progressPercent(bytesRead, totalBytes, phase),
      filename,
    });
  };

  for (let index = 0; index < groups.length; index += 1) {
    const segments = groups[index]!;
    await report("reading", index);
    const metadata = exportMetadata(manifest, index, groups.length, segments);
    const bytes = await buildZipVolume(
      store,
      manifest,
      metadataName,
      segments,
      metadata,
      options.compressionLevel,
      async (size) => {
        bytesRead += size;
        await report("reading", index);
      },
      () => report("compressing", index),
    );
    const suffix = groups.length === 1
      ? ""
      : `_part${String(index + 1).padStart(width, "0")}_of_${String(groups.length).padStart(width, "0")}`;
    const filename = `${stem}${suffix}.zip`;
    await report("ready", index, filename);
    yield {
      filename,
      index: index + 1,
      total: groups.length,
      firstObservedAtMs: segments[0]?.startedAtMs ?? checkpoint.startedAtMs,
      lastObservedAtMs: segments.at(-1)?.endedAtMs ?? checkpoint.updatedAtMs,
      bytes,
      sizeBytes: bytes.byteLength,
    };
  }
  await report("done", groups.length - 1);
}

/** Starts an ordinary browser download; the browser owns the destination path. */
export function downloadVolume(volume: ExportedVolume): void {
  const blob = volume.bytes instanceof Blob
    ? volume.bytes
    : new Blob([volume.bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = volume.filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Prevents spreadsheet formula execution while preserving the visible value. */
export function escapeCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[\t\r ]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function encodeCsvRow(values: readonly unknown[]): string {
  return `${values.map(escapeCsvCell).join(",")}\r\n`;
}
