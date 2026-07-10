export type RecordingKind = "communication" | "locator";

export type CommunicationArtifact =
  | "remote_raw.log"
  | "chassis_raw.log"
  | "remote_rdbg.csv"
  | "chassis_cdbg.csv"
  | "events.csv"
  | "session.json";

export type LocatorArtifact =
  | "raw_serial.log"
  | "raw_frames.csv"
  | "display_frames.csv"
  | "events.log"
  | "metadata.json";

export type RecordingArtifact = CommunicationArtifact | LocatorArtifact;

export interface SessionManifest {
  schemaVersion: 1;
  sessionId: string;
  kind: RecordingKind;
  startedAt: string;
  sourceCommits?: {
    remote?: string;
    locator?: string;
  };
  parserVersions?: Record<string, string>;
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
  "chassis_cdbg.csv",
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

export function expectedArtifacts(kind: RecordingKind): readonly RecordingArtifact[] {
  return kind === "communication" ? COMMUNICATION_ARTIFACTS : LOCATOR_ARTIFACTS;
}

export function isArtifactForKind(
  kind: RecordingKind,
  name: string,
): name is RecordingArtifact {
  return expectedArtifacts(kind).includes(name as RecordingArtifact);
}
