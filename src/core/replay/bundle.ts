import { unzipSync } from "fflate";

import { parseLocatorCoordinateMetadata } from "../locator";
import { parseReplayText } from "./parser";
import type { ParseReplayOptions, ReplayBundle, ReplayCoordinateSpace, ReplayTrack } from "./types";

const decoder = new TextDecoder();
const REPLAY_ARTIFACTS = new Set([
  "remote_raw.log",
  "chassis_raw.log",
  "remote_rdbg.csv",
  "remote_rdbg_tx.csv",
  "chassis_cdbg.csv",
  "chassis_cevt.csv",
  "raw_serial.log",
  "raw_frames.csv",
  "display_frames.csv",
  "locator_raw.log",
  "locator_frames.csv",
  "locator_display_frames.csv",
]);

const PROTOCOL_CSV_ARTIFACTS = new Set([
  "remote_rdbg.csv",
  "remote_rdbg_tx.csv",
  "chassis_cdbg.csv",
  "chassis_cevt.csv",
]);

export interface LoadReplayOptions extends ParseReplayOptions {
  name?: string;
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function explicitCoordinateSpace(metadata: unknown): ReplayCoordinateSpace | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const root = metadata as Record<string, unknown>;
  if ("locatorCoordinates" in root) {
    const locatorCoordinates = root.locatorCoordinates;
    if (parseLocatorCoordinateMetadata(locatorCoordinates)) return "start-relative";
    if (locatorCoordinates && typeof locatorCoordinates === "object" && (locatorCoordinates as Record<string, unknown>).coordinateSpace === "field") return "field";
    return "unknown";
  }
  if ("renderContext" in root) return explicitCoordinateSpace(root.renderContext);
  if (parseLocatorCoordinateMetadata(metadata)) return "start-relative";
  if (!("coordinateSpace" in root)) return undefined;
  return root.coordinateSpace === "field" ? "field" : "unknown";
}

function coordinateSpaceForTrack(
  name: string,
  metadata: unknown,
  metadataState: "absent" | "valid" | "invalid",
): ReplayCoordinateSpace {
  if (name === "raw_serial.log" || name === "raw_frames.csv" || name === "locator_raw.log" || name === "locator_frames.csv") return "start-relative";
  if (name === "display_frames.csv" || name === "locator_display_frames.csv") {
    if (metadataState === "invalid") return "unknown";
    // Desktop bundles predate coordinate metadata and baked display values into
    // field coordinates. An explicit but unsupported value stays ambiguous.
    return explicitCoordinateSpace(metadata) ?? "field";
  }
  return "unknown";
}

function trackFromText(
  name: string,
  text: string,
  options: ParseReplayOptions,
  coordinateSpace: ReplayCoordinateSpace,
): ReplayTrack {
  return { name, records: parseReplayText(text, options), coordinateSpace };
}

function decodeJson(data: Uint8Array): { valid: true; value: unknown } | { valid: false } {
  try {
    return { valid: true, value: JSON.parse(decoder.decode(data)) };
  } catch {
    return { valid: false };
  }
}

export function loadReplayZip(
  bytes: Uint8Array,
  options: LoadReplayOptions = {},
): ReplayBundle {
  const entries = unzipSync(bytes);
  const replayEntries: Array<{ name: string; data: Uint8Array }> = [];
  let metadata: unknown;
  let metadataState: "absent" | "valid" | "invalid" = "absent";
  const metadataEntry = Object.entries(entries).find(([path]) => basename(path) === "metadata.json")
    ?? Object.entries(entries).find(([path]) => basename(path) === "session.json");
  if (metadataEntry) {
    const decoded = decodeJson(metadataEntry[1]);
    metadataState = decoded.valid ? "valid" : "invalid";
    if (decoded.valid) metadata = decoded.value;
  }
  for (const [path, data] of Object.entries(entries)) {
    const name = basename(path);
    if (name === "session.json" || name === "metadata.json") {
      continue;
    }
    if (REPLAY_ARTIFACTS.has(name)) replayEntries.push({ name, data });
  }
  const tracks = replayEntries.map(({ name, data }) => {
    const format = name.endsWith(".csv") ? "csv" : "raw";
    const protocolCsv = PROTOCOL_CSV_ARTIFACTS.has(name);
    return trackFromText(
      name,
      decoder.decode(data),
      protocolCsv ? { ...options, format, timestampColumn: options.timestampColumn ?? "column_1", payloadColumn: options.payloadColumn ?? "column_2" } : { ...options, format },
      coordinateSpaceForTrack(name, metadata, metadataState),
    );
  });
  if (tracks.length === 0) throw new Error("ZIP does not contain a supported R1 replay artifact");
  return { name: options.name ?? "r1-session.zip", tracks, metadata };
}

export function loadReplayBytes(
  bytes: Uint8Array,
  options: LoadReplayOptions = {},
): ReplayBundle {
  const name = options.name ?? "replay.log";
  if (name.toLowerCase().endsWith(".zip")) return loadReplayZip(bytes, options);
  const lowerName = name.toLowerCase();
  const format = lowerName.endsWith(".csv")
    ? "csv"
    : lowerName.endsWith(".log") || lowerName.endsWith(".txt")
      ? "raw"
      : options.format;
  return {
    name,
    tracks: [trackFromText(
      name,
      decoder.decode(bytes),
      { ...options, format },
      coordinateSpaceForTrack(basename(name).toLowerCase(), undefined, "absent"),
    )],
  };
}

export async function loadReplayFile(
  file: File,
  options: Omit<LoadReplayOptions, "name"> = {},
): Promise<ReplayBundle> {
  return loadReplayBytes(new Uint8Array(await file.arrayBuffer()), { ...options, name: file.name });
}
