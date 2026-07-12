import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadVolume, exportSessionVolumes, listRecoverableSessions, OpfsFileStore, SessionRecorder, type ExportSessionProgress, type RecordingArtifact, type RecordingKind, type RecoverableSession, type SessionManifest } from "../../core/storage";
import { BUILD_INFO } from "../../shared/buildInfo";
import { sessionId } from "../../shared/format";

export type RecordingDownloadPhase =
  | "stopping"
  | "reading"
  | "compressing"
  | "downloading"
  | "complete"
  | "error";

export interface RecordingDownloadProgress {
  phase: RecordingDownloadPhase;
  sessionId: string;
  current: number;
  total: number;
  percent: number;
  label: string;
  detail: string;
}

export type RecorderManifestExtras = Pick<SessionManifest, "locatorCoordinates" | "notes">;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function progressLabel(progress: ExportSessionProgress): string {
  if (progress.phase === "reading") return `正在读取录制分片 ${progress.volumeIndex}/${progress.volumeTotal}`;
  if (progress.phase === "compressing") return `正在压缩 ZIP ${progress.volumeIndex}/${progress.volumeTotal}`;
  if (progress.phase === "ready") return `ZIP 已生成 ${progress.volumeIndex}/${progress.volumeTotal}`;
  return "下载已触发";
}

function exportProgressState(progress: ExportSessionProgress): RecordingDownloadProgress {
  const phase: RecordingDownloadPhase =
    progress.phase === "compressing" ? "compressing" :
    progress.phase === "done" ? "complete" :
    progress.phase === "ready" ? "downloading" :
    "reading";
  return {
    phase,
    sessionId: progress.sessionId,
    current: progress.volumeIndex,
    total: progress.volumeTotal,
    percent: Math.round(progress.percent),
    label: progressLabel(progress),
    detail: `${formatBytes(progress.bytesRead)} / ${formatBytes(progress.totalBytes)}${progress.filename ? ` · ${progress.filename}` : ""}`,
  };
}

function waitForPaint(): Promise<void> {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function updateExportProgress(
  progress: ExportSessionProgress,
  setDownloadProgress: (value: RecordingDownloadProgress) => void,
): Promise<void> {
  if (progress.phase === "done") return;
  setDownloadProgress(exportProgressState(progress));
  if (progress.phase !== "reading") await waitForPaint();
}

export function useRecorder(kind: RecordingKind) {
  const storeRef = useRef<OpfsFileStore | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const exportingRef = useRef(false);
  const [active, setActive] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<RecordingDownloadProgress | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const store = storeRef.current ??= new OpfsFileStore();
      setRecoverable((await listRecoverableSessions(store)).filter((item) => item.manifest.kind === kind));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [kind]);
  useEffect(() => { void refresh(); }, [refresh]);
  const start = useCallback(async (extras: RecorderManifestExtras = {}) => {
    if (exportingRef.current) return;
    try {
      if (kind !== "locator" && extras.locatorCoordinates !== undefined) {
        throw new Error("locatorCoordinates may only be recorded in a locator session");
      }
      const store = storeRef.current ??= new OpfsFileStore();
      recorderRef.current = await SessionRecorder.create(store, {
        schemaVersion: 1, sessionId: sessionId(kind), kind, startedAt: new Date().toISOString(),
        sourceCommits: { remote: BUILD_INFO.remoteSource, locator: BUILD_INFO.locatorSource },
        parserVersions: BUILD_INFO.parsers,
        ...(extras.notes === undefined ? {} : { notes: extras.notes }),
        ...(extras.locatorCoordinates === undefined ? {} : { locatorCoordinates: extras.locatorCoordinates }),
      });
      setActive(true); setError(null); setDownloadProgress(null); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [kind, refresh]);
  const append = useCallback((artifact: RecordingArtifact, text: string, at = Date.now()) => {
    return recorderRef.current?.append(artifact, text, at).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  const stopAndDownload = useCallback(async () => {
    const recorder = recorderRef.current;
    const store = storeRef.current;
    if (!recorder || !store || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setError(null);
    const id = recorder.manifest.sessionId;
    setDownloadProgress({
      phase: "stopping",
      sessionId: id,
      current: 0,
      total: 0,
      percent: 0,
      label: "正在停止录制",
      detail: "等待最后一批 OPFS 写入落盘",
    });
    try {
      await recorder.stop();
      recorderRef.current = null;
      setActive(false);
      await waitForPaint();
      let lastCurrent = 0;
      let lastTotal = 0;
      for await (const volume of exportSessionVolumes(store, id, {
        onProgress: (progress) => updateExportProgress(progress, setDownloadProgress),
      })) {
        lastCurrent = volume.index;
        lastTotal = volume.total;
        setDownloadProgress({
          phase: "downloading",
          sessionId: id,
          current: volume.index,
          total: volume.total,
          percent: Math.round((volume.index / volume.total) * 100),
          label: `正在触发浏览器下载 ${volume.index}/${volume.total}`,
          detail: `${volume.filename} · ${formatBytes(volume.bytes.byteLength)}`,
        });
        await waitForPaint();
        downloadVolume(volume);
      }
      setDownloadProgress({
        phase: "complete",
        sessionId: id,
        current: lastCurrent || 1,
        total: lastTotal || 1,
        percent: 100,
        label: "下载已触发",
        detail: lastCurrent > 1 ? `${lastCurrent} 个 ZIP 包已交给浏览器` : "ZIP 包已交给浏览器",
      });
      await refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setDownloadProgress({
        phase: "error",
        sessionId: id,
        current: 0,
        total: 0,
        percent: 0,
        label: "下载失败",
        detail: message,
      });
      setError(message);
      await refresh();
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [refresh]);
  const downloadRecovered = useCallback(async (id: string) => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setError(null);
    try {
      const store = storeRef.current ??= new OpfsFileStore();
      let lastCurrent = 0;
      let lastTotal = 0;
      for await (const volume of exportSessionVolumes(store, id, {
        onProgress: (progress) => updateExportProgress(progress, setDownloadProgress),
      })) {
        lastCurrent = volume.index;
        lastTotal = volume.total;
        setDownloadProgress({
          phase: "downloading",
          sessionId: id,
          current: volume.index,
          total: volume.total,
          percent: Math.round((volume.index / volume.total) * 100),
          label: `正在触发浏览器下载 ${volume.index}/${volume.total}`,
          detail: `${volume.filename} · ${formatBytes(volume.bytes.byteLength)}`,
        });
        await waitForPaint();
        downloadVolume(volume);
      }
      setDownloadProgress({
        phase: "complete",
        sessionId: id,
        current: lastCurrent || 1,
        total: lastTotal || 1,
        percent: 100,
        label: "下载已触发",
        detail: lastCurrent > 1 ? `${lastCurrent} 个 ZIP 包已交给浏览器` : "ZIP 包已交给浏览器",
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setDownloadProgress({
        phase: "error",
        sessionId: id,
        current: 0,
        total: 0,
        percent: 0,
        label: "下载失败",
        detail: message,
      });
      setError(message);
      await refresh();
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [refresh]);
  return useMemo(() => ({ active, exporting, downloadProgress, recoverable, error, start, append, stopAndDownload, downloadRecovered }), [
    active, exporting, downloadProgress, recoverable, error, start, append, stopAndDownload, downloadRecovered,
  ]);
}
