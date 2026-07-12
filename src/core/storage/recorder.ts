import { parseLocatorCoordinateMetadata } from "../locator";
import { type SessionFileStore, type StoredData, toBytes } from "./fileStore";
import {
  DEFAULT_ROLLING_POLICY,
  type RecordingArtifact,
  type RecordingCheckpoint,
  type RollingPolicy,
  type SessionManifest,
  type StoredSegment,
  isArtifactForKind,
} from "./types";
import { readCheckpoint } from "./repository";

const textDecoder = new TextDecoder();

function sessionRoot(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error("sessionId may only contain letters, digits, underscore, and hyphen");
  }
  return `sessions/${sessionId}`;
}

function segmentPath(sessionId: string, index: number, artifact: RecordingArtifact): string {
  return `${sessionRoot(sessionId)}/segments/${String(index).padStart(6, "0")}/${artifact}`;
}

function newSegment(index: number, nowMs: number): StoredSegment {
  return {
    index,
    startedAtMs: nowMs,
    endedAtMs: nowMs,
    sizeBytes: 0,
    artifacts: {},
  };
}

export interface SessionRecorderOptions {
  rollingPolicy?: Partial<RollingPolicy>;
  now?: () => number;
}

/**
 * Crash-tolerant recorder. Every append is serialized and followed by a
 * checkpoint update, so a page reload can recover all fully written appends.
 */
export class SessionRecorder {
  private checkpoint: RecordingCheckpoint;
  private readonly policy: RollingPolicy;
  private readonly now: () => number;
  private operation: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: SessionFileStore,
    readonly manifest: SessionManifest,
    checkpoint: RecordingCheckpoint,
    options: SessionRecorderOptions,
  ) {
    this.checkpoint = checkpoint;
    this.policy = { ...DEFAULT_ROLLING_POLICY, ...options.rollingPolicy };
    this.now = options.now ?? Date.now;
    if (this.policy.maxSegmentBytes <= 0 || this.policy.maxSegmentDurationMs <= 0) {
      throw new Error("Rolling policy limits must be positive");
    }
  }

  static async create(
    store: SessionFileStore,
    manifest: SessionManifest,
    options: SessionRecorderOptions = {},
  ): Promise<SessionRecorder> {
    if (manifest.kind === "communication" && manifest.locatorCoordinates !== undefined) {
      throw new Error("locatorCoordinates may only be stored in a locator session");
    }
    if (
      manifest.locatorCoordinates !== undefined &&
      parseLocatorCoordinateMetadata(manifest.locatorCoordinates) === null
    ) {
      throw new Error("Invalid locatorCoordinates recording metadata");
    }
    const root = sessionRoot(manifest.sessionId);
    if (await store.exists(`${root}/checkpoint.json`)) {
      throw new Error(`Recording session already exists: ${manifest.sessionId}`);
    }
    const startedAtMs = Date.parse(manifest.startedAt);
    if (!Number.isFinite(startedAtMs)) throw new Error("manifest.startedAt must be an ISO timestamp");
    const checkpoint: RecordingCheckpoint = {
      schemaVersion: 1,
      sessionId: manifest.sessionId,
      kind: manifest.kind,
      status: "active",
      startedAtMs,
      updatedAtMs: startedAtMs,
      currentSegment: 0,
      segments: [newSegment(0, startedAtMs)],
    };
    await store.write(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
    const serialized = JSON.stringify(checkpoint, null, 2);
    await store.write(`${root}/checkpoint.recovery.json`, serialized);
    await store.write(`${root}/checkpoint.json`, serialized);
    return new SessionRecorder(store, manifest, checkpoint, options);
  }

  static async resume(
    store: SessionFileStore,
    sessionId: string,
    options: SessionRecorderOptions = {},
  ): Promise<SessionRecorder> {
    const root = sessionRoot(sessionId);
    const manifest = JSON.parse(textDecoder.decode(await store.read(`${root}/manifest.json`))) as SessionManifest;
    const checkpoint = await readCheckpoint(store, root);
    if (manifest.schemaVersion !== 1 || checkpoint.schemaVersion !== 1) {
      throw new Error(`Unsupported recording schema for ${sessionId}`);
    }
    if (
      manifest.sessionId !== sessionId ||
      checkpoint.sessionId !== sessionId ||
      manifest.kind !== checkpoint.kind
    ) {
      throw new Error(`Recording manifest/checkpoint mismatch for ${sessionId}`);
    }
    if (manifest.kind === "communication" && manifest.locatorCoordinates !== undefined) {
      throw new Error(`Invalid locator coordinate metadata for ${sessionId}`);
    }
    if (
      manifest.locatorCoordinates !== undefined &&
      parseLocatorCoordinateMetadata(manifest.locatorCoordinates) === null
    ) {
      throw new Error(`Invalid locator coordinate metadata for ${sessionId}`);
    }
    if (checkpoint.status === "exported") {
      throw new Error(`Recording session was already exported: ${sessionId}`);
    }
    // A crashed active session can continue. A stopped one remains available
    // for export but must not silently resume acquisition.
    const recorder = new SessionRecorder(store, manifest, checkpoint, options);
    await recorder.reconcileStoredSegments();
    return recorder;
  }

  get snapshot(): RecordingCheckpoint {
    return structuredClone(this.checkpoint);
  }

  append(artifact: RecordingArtifact, data: StoredData, observedAtMs = this.now()): Promise<void> {
    return this.enqueue(async () => {
      if (this.checkpoint.status !== "active") {
        throw new Error(`Cannot append to a ${this.checkpoint.status} recording`);
      }
      if (!isArtifactForKind(this.manifest.kind, artifact)) {
        throw new Error(`${artifact} does not belong to a ${this.manifest.kind} session`);
      }
      const bytes = toBytes(data);
      if (bytes.byteLength === 0) return;
      let segment = this.currentSegment();
      const elapsed = observedAtMs - segment.startedAtMs;
      if (
        segment.sizeBytes > 0 &&
        (elapsed >= this.policy.maxSegmentDurationMs ||
          segment.sizeBytes + bytes.byteLength > this.policy.maxSegmentBytes)
      ) {
        segment = this.roll(observedAtMs);
      }

      const writeSlice = async (target: StoredSegment, slice: Uint8Array): Promise<void> => {
        const path = segmentPath(this.manifest.sessionId, target.index, artifact);
        await this.store.append(path, slice);
        const previousSize = target.artifacts[artifact]?.sizeBytes ?? 0;
        target.artifacts[artifact] = {
          name: artifact,
          path,
          sizeBytes: previousSize + slice.byteLength,
        };
        target.sizeBytes += slice.byteLength;
        target.endedAtMs = Math.max(target.endedAtMs, observedAtMs);
      };

      if (bytes.byteLength <= this.policy.maxSegmentBytes) {
        await writeSlice(segment, bytes);
      } else {
        // Oversized single writes are the only case allowed to cross a segment
        // boundary. Normal log/CSV appends remain intact records per volume.
        if (segment.sizeBytes > 0) segment = this.roll(observedAtMs);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const length = Math.min(this.policy.maxSegmentBytes, bytes.byteLength - offset);
          await writeSlice(segment, bytes.subarray(offset, offset + length));
          offset += length;
          if (offset < bytes.byteLength) segment = this.roll(observedAtMs);
        }
      }
      this.checkpoint.updatedAtMs = observedAtMs;
      await this.persistCheckpoint();
    });
  }

  stop(stoppedAtMs = this.now()): Promise<void> {
    return this.enqueue(async () => {
      if (this.checkpoint.status === "exported") return;
      this.checkpoint.status = "stopped";
      this.checkpoint.updatedAtMs = stoppedAtMs;
      this.currentSegment().endedAtMs = Math.max(this.currentSegment().endedAtMs, stoppedAtMs);
      await this.persistCheckpoint();
    });
  }

  markExported(exportedAtMs = this.now()): Promise<void> {
    return this.enqueue(async () => {
      this.checkpoint.status = "exported";
      this.checkpoint.exportedAtMs = exportedAtMs;
      this.checkpoint.updatedAtMs = exportedAtMs;
      await this.persistCheckpoint();
    });
  }

  private currentSegment(): StoredSegment {
    const segment = this.checkpoint.segments.at(-1);
    if (!segment) throw new Error("Recording checkpoint has no segment");
    return segment;
  }

  private roll(nowMs: number): StoredSegment {
    const current = this.currentSegment();
    current.endedAtMs = Math.max(current.endedAtMs, nowMs);
    const next = newSegment(current.index + 1, nowMs);
    this.checkpoint.segments.push(next);
    this.checkpoint.currentSegment = next.index;
    return next;
  }

  private async persistCheckpoint(): Promise<void> {
    const root = sessionRoot(this.manifest.sessionId);
    const serialized = JSON.stringify(this.checkpoint, null, 2);
    // Recovery is written first. If the page dies while replacing the primary
    // checkpoint, startup can still use the fully written recovery copy.
    await this.store.write(`${root}/checkpoint.recovery.json`, serialized);
    await this.store.write(`${root}/checkpoint.json`, serialized);
  }

  private async reconcileStoredSegments(): Promise<void> {
    const root = sessionRoot(this.manifest.sessionId);
    const files = await this.store.list(`${root}/segments`);
    const byIndex = new Map(this.checkpoint.segments.map((segment) => [segment.index, segment]));
    let changed = false;

    for (const path of files) {
      const match = /\/segments\/(\d+)\/(.+)$/.exec(path);
      if (!match?.[1] || !match[2] || !isArtifactForKind(this.manifest.kind, match[2])) continue;
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index) || index < 0) continue;
      let segment = byIndex.get(index);
      if (!segment) {
        segment = newSegment(index, this.checkpoint.updatedAtMs);
        byIndex.set(index, segment);
        changed = true;
      }
      const actualSize = (await this.store.read(path)).byteLength;
      const previous = segment.artifacts[match[2]];
      if (!previous || previous.path !== path || previous.sizeBytes !== actualSize) {
        segment.artifacts[match[2]] = { name: match[2], path, sizeBytes: actualSize };
        changed = true;
      }
    }

    const segments = [...byIndex.values()].sort((left, right) => left.index - right.index);
    for (const segment of segments) {
      const sizeBytes = Object.values(segment.artifacts).reduce(
        (total, artifact) => total + (artifact?.sizeBytes ?? 0),
        0,
      );
      if (segment.sizeBytes !== sizeBytes) {
        segment.sizeBytes = sizeBytes;
        changed = true;
      }
    }
    if (segments.length === 0) {
      segments.push(newSegment(0, this.checkpoint.updatedAtMs));
      changed = true;
    }
    const currentSegment = segments.at(-1)!.index;
    if (this.checkpoint.currentSegment !== currentSegment) changed = true;
    this.checkpoint.segments = segments;
    this.checkpoint.currentSegment = currentSegment;
    if (changed) await this.persistCheckpoint();
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.operation.then(task, task);
    this.operation = result.catch(() => undefined);
    return result;
  }
}

export const storagePaths = { sessionRoot, segmentPath };
