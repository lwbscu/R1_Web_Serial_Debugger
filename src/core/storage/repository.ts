import type { SessionFileStore } from "./fileStore";
import type { RecordingCheckpoint, RecoverableSession, SessionManifest } from "./types";

const decoder = new TextDecoder();

async function readJson<T>(store: SessionFileStore, path: string): Promise<T> {
  return JSON.parse(decoder.decode(await store.read(path))) as T;
}

export async function readCheckpoint(
  store: SessionFileStore,
  root: string,
): Promise<RecordingCheckpoint> {
  try {
    return await readJson<RecordingCheckpoint>(store, `${root}/checkpoint.json`);
  } catch (primaryError) {
    try {
      return await readJson<RecordingCheckpoint>(store, `${root}/checkpoint.recovery.json`);
    } catch {
      throw primaryError;
    }
  }
}

export async function listRecoverableSessions(
  store: SessionFileStore,
): Promise<RecoverableSession[]> {
  const files = await store.list("sessions");
  const roots = new Set(
    files.flatMap((path) => {
      const match = /^(sessions\/[^/]+)\/checkpoint(?:\.recovery)?\.json$/.exec(path);
      return match?.[1] ? [match[1]] : [];
    }),
  );
  const sessions: RecoverableSession[] = [];
  for (const root of roots) {
    try {
      const [checkpoint, manifest] = await Promise.all([
        readCheckpoint(store, root),
        readJson<SessionManifest>(store, `${root}/manifest.json`),
      ]);
      if (checkpoint.schemaVersion !== 1 || manifest.schemaVersion !== 1) continue;
      if (checkpoint.status === "exported") continue;
      sessions.push({
        checkpoint,
        manifest,
        totalBytes: checkpoint.segments.reduce((total, segment) => total + segment.sizeBytes, 0),
      });
    } catch {
      // A single corrupt/incompletely created session must not hide healthy
      // recoverable sessions. Its files remain available for manual cleanup.
    }
  }
  return sessions.sort((left, right) => right.checkpoint.updatedAtMs - left.checkpoint.updatedAtMs);
}

export async function deleteSession(store: SessionFileStore, sessionId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid sessionId");
  await store.remove(`sessions/${sessionId}`);
}

export async function readSession(
  store: SessionFileStore,
  sessionId: string,
): Promise<{ manifest: SessionManifest; checkpoint: RecordingCheckpoint }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid sessionId");
  const root = `sessions/${sessionId}`;
  return {
    manifest: await readJson(store, `${root}/manifest.json`),
    checkpoint: await readCheckpoint(store, root),
  };
}
