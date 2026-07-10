import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadVolume, exportSessionVolumes, listRecoverableSessions, OpfsFileStore, SessionRecorder, type RecordingArtifact, type RecordingKind, type RecoverableSession } from "../../core/storage";
import { BUILD_INFO } from "../../shared/buildInfo";
import { sessionId } from "../../shared/format";

export function useRecorder(kind: RecordingKind) {
  const storeRef = useRef<OpfsFileStore | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const [active, setActive] = useState(false);
  const [recoverable, setRecoverable] = useState<RecoverableSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const store = storeRef.current ??= new OpfsFileStore();
      setRecoverable((await listRecoverableSessions(store)).filter((item) => item.manifest.kind === kind));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [kind]);
  useEffect(() => { void refresh(); }, [refresh]);
  const start = useCallback(async () => {
    try {
      const store = storeRef.current ??= new OpfsFileStore();
      recorderRef.current = await SessionRecorder.create(store, {
        schemaVersion: 1, sessionId: sessionId(kind), kind, startedAt: new Date().toISOString(),
        sourceCommits: { remote: BUILD_INFO.remoteSource, locator: BUILD_INFO.locatorSource },
        parserVersions: BUILD_INFO.parsers,
      });
      setActive(true); setError(null); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [kind, refresh]);
  const append = useCallback((artifact: RecordingArtifact, text: string, at = Date.now()) => {
    return recorderRef.current?.append(artifact, text, at).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  const stopAndDownload = useCallback(async () => {
    const recorder = recorderRef.current;
    const store = storeRef.current;
    if (!recorder || !store) return;
    try {
      await recorder.stop();
      for await (const volume of exportSessionVolumes(store, recorder.manifest.sessionId)) downloadVolume(volume);
      recorderRef.current = null; setActive(false); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [refresh]);
  const downloadRecovered = useCallback(async (id: string) => {
    try {
      const store = storeRef.current ??= new OpfsFileStore();
      for await (const volume of exportSessionVolumes(store, id)) downloadVolume(volume);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  return useMemo(() => ({ active, recoverable, error, start, append, stopAndDownload, downloadRecovered }), [
    active, recoverable, error, start, append, stopAndDownload, downloadRecovered,
  ]);
}
