import type { LocatorCoordinateContext } from "../locator";

export type RecordingKind = "communication" | "locator" | "global";
export type RecordingProfile = "quickSerial" | "full";

export type CommunicationArtifact =
  | "remote_raw.log"
  | "chassis_raw.log"
  | "remote_rdbg.csv"
  | "remote_rdbg_tx.csv"
  | "chassis_cdbg.csv"
  | "chassis_cevt.csv"
  | "events.csv"
  | "session.json";

export type LocatorArtifact =
  | "raw_serial.log"
  | "raw_frames.csv"
  | "display_frames.csv"
  | "events.log"
  | "metadata.json";

export type GlobalArtifact =
  | "remote_raw.log"
  | "chassis_raw.log"
  | "remote_rdbg.csv"
  | "remote_rdbg_tx.csv"
  | "chassis_cdbg.csv"
  | "chassis_cevt.csv"
  | "locator_raw.log"
  | "raw_serial.log"
  | "locator_frames.csv"
  | "locator_display_frames.csv"
  | "events.csv"
  | "connection_status.csv"
  | "session.json";

export type RecordingArtifact = CommunicationArtifact | LocatorArtifact | GlobalArtifact;

export interface SessionManifest {
  schemaVersion: 1;
  sessionId: string;
  kind: RecordingKind;
  recordingProfile?: RecordingProfile;
  startedAt: string;
  sourceCommits?: {
    remote?: string;
    chassis?: string;
    locator?: string;
  };
  /** Delivery candidates only. Actual flashed identity must come from DBG_META or the Windows session note. */
  expectedSourceCommits?: Record<string, string>;
  parserVersions?: Record<string, string>;
  locatorCoordinates?: LocatorCoordinateContext;
  notes?: string;
}

export interface StoredArtifactChunk {
  name: RecordingArtifact;
  path: string;
  sizeBytes: number;
}

export interface StoredSegment {
  index: number;
  startedAtMs: number;
  endedAtMs: number;
  sizeBytes: number;
  artifacts: Partial<Record<RecordingArtifact, StoredArtifactChunk>>;
}

export type RecordingStatus = "active" | "stopped" | "exported";

export interface RecordingCheckpoint {
  schemaVersion: 1;
  sessionId: string;
  kind: RecordingKind;
  status: RecordingStatus;
  startedAtMs: number;
  updatedAtMs: number;
  currentSegment: number;
  segments: StoredSegment[];
  exportedAtMs?: number;
}

export interface RecoverableSession {
  manifest: SessionManifest;
  checkpoint: RecordingCheckpoint;
  totalBytes: number;
}

export interface RollingPolicy {
  maxSegmentBytes: number;
  maxSegmentDurationMs: number;
}

export const DEFAULT_ROLLING_POLICY: Readonly<RollingPolicy> = {
  maxSegmentBytes: 4 * 1024 * 1024,
  maxSegmentDurationMs: 30_000,
};

export const DEFAULT_MAX_ZIP_VOLUME_BYTES = 256 * 1024 * 1024;

const COMMUNICATION_ARTIFACTS: readonly CommunicationArtifact[] = [
  "remote_raw.log",
  "chassis_raw.log",
  "remote_rdbg.csv",
  "remote_rdbg_tx.csv",
  "chassis_cdbg.csv",
  "chassis_cevt.csv",
  "events.csv",
  "session.json",
];

const LOCATOR_ARTIFACTS: readonly LocatorArtifact[] = [
  "raw_serial.log",
  "raw_frames.csv",
  "display_frames.csv",
  "events.log",
  "metadata.json",
];

const GLOBAL_ARTIFACTS: readonly GlobalArtifact[] = [
  "remote_raw.log",
  "chassis_raw.log",
  "remote_rdbg.csv",
  "remote_rdbg_tx.csv",
  "chassis_cdbg.csv",
  "chassis_cevt.csv",
  "locator_raw.log",
  "raw_serial.log",
  "locator_frames.csv",
  "locator_display_frames.csv",
  "events.csv",
  "connection_status.csv",
  "session.json",
];

export function expectedArtifacts(kind: RecordingKind): readonly RecordingArtifact[] {
  if (kind === "communication") return COMMUNICATION_ARTIFACTS;
  if (kind === "locator") return LOCATOR_ARTIFACTS;
  return GLOBAL_ARTIFACTS;
}

export function isArtifactForKind(
  kind: RecordingKind,
  name: string,
): name is RecordingArtifact {
  return expectedArtifacts(kind).includes(name as RecordingArtifact);
}
