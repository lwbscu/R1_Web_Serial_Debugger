import { unzipSync } from "fflate";

import { parseReplayText } from "./parser";
import type { ParseReplayOptions, ReplayBundle, ReplayTrack } from "./types";

const decoder = new TextDecoder();
const REPLAY_ARTIFACTS = new Set([
  "remote_raw.log",
  "chassis_raw.log",
  "remote_rdbg.csv",
  "chassis_cdbg.csv",
  "raw_serial.log",
  "raw_frames.csv",
  "display_frames.csv",
]);

export interface LoadReplayOptions extends ParseReplayOptions {
  name?: string;
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function trackFromText(name: string, text: string, options: ParseReplayOptions): ReplayTrack {
  return { name, records: parseReplayText(text, options) };
}

function decodeJson(data: Uint8Array | undefined): unknown {
  if (!data) return undefined;
  try {
    return JSON.parse(decoder.decode(data));
  } catch {
    return undefined;
  }
}

export function loadReplayZip(
  bytes: Uint8Array,
  options: LoadReplayOptions = {},
): ReplayBundle {
  const entries = unzipSync(bytes);
  const tracks: ReplayTrack[] = [];
  let metadata: unknown;
  for (const [path, data] of Object.entries(entries)) {
    const name = basename(path);
    if (name === "session.json" || name === "metadata.json") {
      metadata ??= decodeJson(data);
      continue;
    }
    if (!REPLAY_ARTIFACTS.has(name)) continue;
    const format = name.endsWith(".csv") ? "csv" : "raw";
    tracks.push(trackFromText(name, decoder.decode(data), { ...options, format }));
  }
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
    tracks: [trackFromText(name, decoder.decode(bytes), { ...options, format })],
  };
}

export async function loadReplayFile(
  file: File,
  options: Omit<LoadReplayOptions, "name"> = {},
): Promise<ReplayBundle> {
  return loadReplayBytes(new Uint8Array(await file.arrayBuffer()), { ...options, name: file.name });
}
