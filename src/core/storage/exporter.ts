import { zipSync } from "fflate";

import type { SessionFileStore } from "./fileStore";
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
  bytes: Uint8Array;
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

function segmentBytes(segments: readonly StoredSegment[]): number {
  return segments.reduce((total, segment) => total + segment.sizeBytes, 0);
}

function progressPercent(bytesRead: number, totalBytes: number, phase: ExportSessionProgressPhase): number {
  if (totalBytes <= 0) return phase === "reading" ? 0 : 100;
  return Math.min(100, Math.max(0, (bytesRead / totalBytes) * 100));
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
    const entries: Record<string, Uint8Array> = {};
    for (const artifact of expectedArtifacts(manifest.kind)) {
      if (artifact === metadataName) continue;
      const parts: Uint8Array[] = [];
      for (const segment of segments) {
        const stored = segment.artifacts[artifact];
        if (stored) {
          const bytes = await store.read(stored.path);
          parts.push(bytes);
          bytesRead += bytes.byteLength;
          await report("reading", index);
        }
      }
      entries[artifact] = concatenate(parts);
    }
    entries[metadataName] = exportMetadata(manifest, index, groups.length, segments);
    await report("compressing", index);
    const bytes = zipSync(entries, { level: options.compressionLevel ?? 6 });
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
    };
  }
  await report("done", groups.length - 1);
}

/** Starts an ordinary browser download; the browser owns the destination path. */
export function downloadVolume(volume: ExportedVolume): void {
  const blob = new Blob([volume.bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = volume.filename;
  anchor.rel = "noopener";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
