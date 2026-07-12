import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downloadVolume,
  exportSessionVolumes,
  exportSessionVolumesInWorker,
  listRecoverableSessions,
  OpfsFileStore,
  SessionRecorder,
  type ExportedVolume,
  type ExportSessionProgress,
  type RecordingArtifact,
  type RecordingProfile,
  type RecordingKind,
  type RecoverableSession,
  type SessionManifest,
  type SessionRecorderBatchItem,
} from "../../core/storage";
import { BUILD_INFO } from "../../shared/buildInfo";
import { sessionId } from "../../shared/format";

const FLUSH_DELAY_MS = 500;
const FLUSH_MAX_BYTES = 512 * 1024;
const FLUSH_MAX_RECORDS = 5_000;
const PAINT_TIMEOUT_MS = 250;
const QUICK_SERIAL_ARTIFACTS = new Set<RecordingArtifact>([
  "remote_raw.log",
  "chassis_raw.log",
  "locator_raw.log",
  "raw_serial.log",
  "connection_status.csv",
]);

export type RecordingDownloadPhase =
  | "queued"
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

export interface RecorderController {
  kind: RecordingKind;
  active: boolean;
  starting: boolean;
  stopping: boolean;
  exporting: boolean;
  profile: RecordingProfile;
  exportQueue: string[];
  exportQueuedIds: string[];
  downloadProgress: RecordingDownloadProgress | null;
  recoverable: RecoverableSession[];
  error: string | null;
  start(extras?: RecorderManifestExtras): Promise<void>;
  append(artifact: RecordingArtifact, text: string, at?: number): Promise<void> | undefined;
  stopAndDownload(): Promise<void>;
  downloadRecovered(id: string): Promise<void>;
  setProfile(profile: RecordingProfile): void;
}

interface PendingArtifact {
  parts: Uint8Array[];
  bytes: number;
  count: number;
  lastObservedAtMs: number;
}

interface PendingStats {
  count: number;
  bytes: number;
}

interface FlushOptions {
  drain?: boolean;
}

const encoder = new TextEncoder();

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

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

function addStats(left: PendingStats, right: PendingStats): PendingStats {
  return {
    count: left.count + right.count,
    bytes: left.bytes + right.bytes,
  };
}

function progressLabel(progress: ExportSessionProgress): string {
  if (progress.phase === "reading") return `后台读取录制分片 ${progress.volumeIndex}/${progress.volumeTotal}`;
  if (progress.phase === "compressing") return `后台打包 ZIP ${progress.volumeIndex}/${progress.volumeTotal}`;
  if (progress.phase === "ready") return `ZIP 已生成 ${progress.volumeIndex}/${progress.volumeTotal}`;
  return "下载已触发";
}

function exportProgressState(progress: ExportSessionProgress, queueLength: number): RecordingDownloadProgress {
  const phase: RecordingDownloadPhase =
    progress.phase === "compressing" ? "compressing" :
    progress.phase === "done" ? "complete" :
    progress.phase === "ready" ? "downloading" :
    "reading";
  const queueText = queueLength > 0 ? ` · 队列剩余 ${queueLength}` : "";
  return {
    phase,
    sessionId: progress.sessionId,
    current: progress.volumeIndex,
    total: progress.volumeTotal,
    percent: Math.round(progress.percent),
    label: progressLabel(progress),
    detail: `${formatBytes(progress.bytesRead)} / ${formatBytes(progress.totalBytes)}${progress.filename ? ` · ${progress.filename}` : ""}${queueText}`,
  };
}

function waitForPaint(): Promise<void> {
  let timer = 0;
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        resolve();
      };
      timer = window.setTimeout(finish, PAINT_TIMEOUT_MS);
      requestAnimationFrame(finish);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function useRecorder(kind: RecordingKind): RecorderController {
  const storeRef = useRef<OpfsFileStore | null>(null);
  const recorderRef = useRef<SessionRecorder | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const profileRef = useRef<RecordingProfile>("quickSerial");
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const pendingRef = useRef(new Map<RecordingArtifact, PendingArtifact>());
  const pendingTotalsRef = useRef<PendingStats>({ count: 0, bytes: 0 });
  const flushTimerRef = useRef<number | null>(null);
  const flushInFlightRef = useRef<Promise<PendingStats> | null>(null);
  const flushPendingRef = useRef<((target?: SessionRecorder | null, options?: FlushOptions) => Promise<PendingStats>) | null>(null);
  const closingSessionIdsRef = useRef(new Set<string>());
  const exportQueueRef = useRef<string[]>([]);
  const runningExportRef = useRef<string | null>(null);

  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [profile, setProfileState] = useState<RecordingProfile>("quickSerial");
  const [exporting, setExporting] = useState(false);
  const [exportQueue, setExportQueue] = useState<string[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<RecordingDownloadProgress | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  const syncExportState = useCallback(() => {
    const ids = [
      ...closingSessionIdsRef.current,
      ...(runningExportRef.current ? [runningExportRef.current] : []),
      ...exportQueueRef.current,
    ];
    setExporting(ids.length > 0);
    setExportQueue(ids);
  }, []);

  const setProfile = useCallback((next: RecordingProfile) => {
    if (startingRef.current || stoppingRef.current || activeSessionIdRef.current) return;
    profileRef.current = next;
    setProfileState(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const store = storeRef.current ??= new OpfsFileStore();
      const blocked = new Set([
        ...closingSessionIdsRef.current,
        ...(runningExportRef.current ? [runningExportRef.current] : []),
        ...exportQueueRef.current,
        ...(activeSessionIdRef.current ? [activeSessionIdRef.current] : []),
      ]);
      const sessions = await listRecoverableSessions(store);
      setRecoverable(sessions
        .filter((item) => kind === "global" || item.manifest.kind === kind)
        .filter((item) => !blocked.has(item.manifest.sessionId)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [kind]);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current === null) return;
    window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
  }, []);

  const takePending = useCallback((): { items: SessionRecorderBatchItem[]; stats: PendingStats } => {
    const items: SessionRecorderBatchItem[] = [];
    for (const [artifact, pending] of pendingRef.current) {
      items.push({
        artifact,
        data: concatenate(pending.parts),
        observedAtMs: pending.lastObservedAtMs,
      });
    }
    const stats = pendingTotalsRef.current;
    pendingRef.current = new Map();
    pendingTotalsRef.current = { count: 0, bytes: 0 };
    return { items, stats };
  }, []);

  const armFlushTimer = useCallback((target: SessionRecorder) => {
    clearFlushTimer();
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      void flushPendingRef.current?.(target).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, FLUSH_DELAY_MS);
  }, [clearFlushTimer]);

  const flushOnce = useCallback(async (target: SessionRecorder | null): Promise<PendingStats> => {
    const { items, stats } = takePending();
    if (!target || items.length === 0) return stats;
    await target.appendBatch(items);
    return stats;
  }, [takePending]);

  const flushPending = useCallback((target = recorderRef.current, options: FlushOptions = {}): Promise<PendingStats> => {
    clearFlushTimer();
    const drain = options.drain ?? false;
    const running = flushInFlightRef.current;
    if (running) {
      if (!drain) return running;
      return running.then(async (stats) => addStats(stats, await flushPending(target, { drain: true })));
    }

    const flush = flushOnce(target);
    flushInFlightRef.current = flush;
    void flush.then(
      () => {
        if (flushInFlightRef.current === flush) flushInFlightRef.current = null;
        if (
          !drain &&
          target !== null &&
          recorderRef.current === target &&
          !stoppingRef.current &&
          pendingTotalsRef.current.count > 0
        ) {
          armFlushTimer(target);
        }
      },
      () => {
        if (flushInFlightRef.current === flush) flushInFlightRef.current = null;
      },
    );
    if (!drain) return flush;
    return flush.then(async (stats) => {
      if (pendingTotalsRef.current.count === 0) return stats;
      return addStats(stats, await flushPending(target, { drain: true }));
    });
  }, [armFlushTimer, clearFlushTimer, flushOnce]);
  flushPendingRef.current = flushPending;

  const scheduleFlush = useCallback((target: SessionRecorder) => {
    armFlushTimer(target);
  }, [armFlushTimer]);

  const exportVolumes = useCallback((store: OpfsFileStore, id: string, onProgress: (progress: ExportSessionProgress) => void | Promise<void>): AsyncGenerator<ExportedVolume, void, void> => {
    if (typeof Worker === "undefined") {
      return exportSessionVolumes(store, id, { onProgress });
    }
    return exportSessionVolumesInWorker(id, { onProgress });
  }, []);

  const runExportJob = useCallback(async (id: string) => {
    const store = storeRef.current ??= new OpfsFileStore();
    let lastCurrent = 0;
    let lastTotal = 0;
    setDownloadProgress({
      phase: "queued",
      sessionId: id,
      current: 0,
      total: 0,
      percent: 0,
      label: "后台导出已入队",
      detail: exportQueueRef.current.length > 0 ? `队列剩余 ${exportQueueRef.current.length}` : "准备读取 OPFS 录制分片",
    });

    for await (const volume of exportVolumes(store, id, (progress) => {
      setDownloadProgress(exportProgressState(progress, exportQueueRef.current.length));
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
        detail: `${volume.filename} · ${formatBytes(volume.bytes.byteLength)}${exportQueueRef.current.length > 0 ? ` · 队列剩余 ${exportQueueRef.current.length}` : ""}`,
      });
      await waitForPaint();
      downloadVolume(volume);
    }

    try {
      const exported = await SessionRecorder.resume(store, id);
      await exported.markExported();
    } catch {
      // The ZIP has already been handed to the browser; a stale recoverable item
      // is safer than hiding a package the browser may still ask the user to save.
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
  }, [exportVolumes]);

  const processExportQueue = useCallback(async () => {
    if (runningExportRef.current) return;
    while (exportQueueRef.current.length > 0) {
      const next = exportQueueRef.current.shift()!;
      runningExportRef.current = next;
      syncExportState();
      try {
        await runExportJob(next);
        setError(null);
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        setDownloadProgress({
          phase: "error",
          sessionId: next,
          current: 0,
          total: 0,
          percent: 0,
          label: "后台导出失败",
          detail: message,
        });
        setError(message);
      } finally {
        runningExportRef.current = null;
        syncExportState();
        await refresh();
      }
    }
  }, [refresh, runExportJob, syncExportState]);

  const enqueueExport = useCallback((id: string) => {
    if (id === activeSessionIdRef.current) {
      setError("当前录制仍在进行，不能导出未停止的 session。");
      return;
    }
    if (runningExportRef.current === id || exportQueueRef.current.includes(id)) return;
    exportQueueRef.current.push(id);
    syncExportState();
    void refresh();
    void processExportQueue();
  }, [processExportQueue, refresh, syncExportState]);

  const closeStoppedSessionInBackground = useCallback((
    recorder: SessionRecorder,
    id: string,
    items: SessionRecorderBatchItem[],
    stats: PendingStats,
    previousFlush: Promise<PendingStats> | null,
  ) => {
    closingSessionIdsRef.current.add(id);
    syncExportState();
    void (async () => {
      try {
        setDownloadProgress({
          phase: "stopping",
          sessionId: id,
          current: 1,
          total: 4,
          percent: 5,
          label: "后台落盘旧录制",
          detail: previousFlush
            ? `等待已排队写入完成；最后 ${stats.count} 条 / ${formatBytes(stats.bytes)} 已转入后台`
            : `最后 ${stats.count} 条 / ${formatBytes(stats.bytes)} 已转入后台`,
        });
        if (previousFlush) await previousFlush;
        if (items.length > 0) {
          for (const [index, item] of items.entries()) {
            setDownloadProgress({
              phase: "stopping",
              sessionId: id,
              current: 2,
              total: 4,
              percent: 10 + Math.round(((index + 1) / items.length) * 15),
              label: "后台落盘旧录制",
              detail: `正在写入 ${item.artifact} (${index + 1}/${items.length}) · 最后 ${stats.count} 条 / ${formatBytes(stats.bytes)}`,
            });
            await recorder.appendBatch([item]);
            await yieldToBrowser();
          }
        }
        setDownloadProgress({
          phase: "stopping",
          sessionId: id,
          current: 3,
          total: 4,
          percent: 25,
          label: "后台写入关闭检查点",
          detail: "录制数据已落盘，正在封存 session",
        });
        await recorder.stop();
        closingSessionIdsRef.current.delete(id);
        syncExportState();
        enqueueExport(id);
        await refresh();
      } catch (reason) {
        closingSessionIdsRef.current.delete(id);
        syncExportState();
        const message = reason instanceof Error ? reason.message : String(reason);
        setDownloadProgress({
          phase: "error",
          sessionId: id,
          current: 0,
          total: 0,
          percent: 0,
          label: "后台封存录制失败",
          detail: message,
        });
        setError(message);
        await refresh();
      }
    })();
  }, [enqueueExport, refresh, syncExportState]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const flushOnHidden = () => {
      if (document.visibilityState === "hidden") {
        void flushPending(recorderRef.current, { drain: true }).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      }
    };
    const flushOnPageHide = () => {
      void flushPending(recorderRef.current, { drain: true }).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    };
    document.addEventListener("visibilitychange", flushOnHidden);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushOnHidden);
      window.removeEventListener("pagehide", flushOnPageHide);
      clearFlushTimer();
    };
  }, [clearFlushTimer, flushPending]);

  const start = useCallback(async (extras: RecorderManifestExtras = {}) => {
    if (startingRef.current || recorderRef.current || activeSessionIdRef.current || stoppingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    const id = sessionId(kind);
    pendingRef.current = new Map();
    pendingTotalsRef.current = { count: 0, bytes: 0 };
    activeSessionIdRef.current = id;
    setActive(true);
    setError(null);
    try {
      if (kind === "communication" && extras.locatorCoordinates !== undefined) {
        throw new Error("locatorCoordinates may only be recorded in a locator/global session");
      }
      const store = storeRef.current ??= new OpfsFileStore();
      recorderRef.current = await SessionRecorder.create(store, {
        schemaVersion: 1,
        sessionId: id,
        kind,
        recordingProfile: profileRef.current,
        startedAt: new Date().toISOString(),
        sourceCommits: { remote: BUILD_INFO.remoteSource, locator: BUILD_INFO.locatorSource },
        parserVersions: BUILD_INFO.parsers,
        ...(extras.notes === undefined ? {} : { notes: extras.notes }),
        ...(extras.locatorCoordinates === undefined ? {} : { locatorCoordinates: extras.locatorCoordinates }),
      });
      await flushPending(recorderRef.current);
      await refresh();
    } catch (reason) {
      recorderRef.current = null;
      activeSessionIdRef.current = null;
      pendingRef.current = new Map();
      pendingTotalsRef.current = { count: 0, bytes: 0 };
      setActive(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [flushPending, kind, refresh]);

  const append = useCallback((artifact: RecordingArtifact, text: string, at = Date.now()) => {
    const recorder = recorderRef.current;
    if ((!recorder && !activeSessionIdRef.current) || stoppingRef.current) return undefined;
    if (profileRef.current === "quickSerial" && !QUICK_SERIAL_ARTIFACTS.has(artifact)) return undefined;
    const bytes = encoder.encode(text);
    if (bytes.byteLength === 0) return undefined;
    const pending = pendingRef.current.get(artifact) ?? {
      parts: [],
      bytes: 0,
      count: 0,
      lastObservedAtMs: at,
    };
    pending.parts.push(bytes);
    pending.bytes += bytes.byteLength;
    pending.count += 1;
    pending.lastObservedAtMs = Math.max(pending.lastObservedAtMs, at);
    pendingRef.current.set(artifact, pending);
    pendingTotalsRef.current = {
      count: pendingTotalsRef.current.count + 1,
      bytes: pendingTotalsRef.current.bytes + bytes.byteLength,
    };
    if (!recorder) return undefined;

    if (
      pendingTotalsRef.current.bytes >= FLUSH_MAX_BYTES ||
      pendingTotalsRef.current.count >= FLUSH_MAX_RECORDS
    ) {
      return flushPending(recorder).then(() => undefined).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }
    scheduleFlush(recorder);
    return undefined;
  }, [flushPending, scheduleFlush]);

  const stopAndDownload = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || stoppingRef.current) return;
    const id = recorder.manifest.sessionId;
    stoppingRef.current = true;
    const previousFlush = flushInFlightRef.current;
    flushInFlightRef.current = null;
    recorderRef.current = null;
    activeSessionIdRef.current = null;
    setStopping(true);
    setActive(false);
    setError(null);
    const pending = pendingTotalsRef.current;
    setDownloadProgress({
      phase: "stopping",
      sessionId: id,
      current: 0,
      total: 0,
      percent: 0,
      label: "正在停止录制",
      detail: pending.count > 0
        ? `正在落盘最后 ${pending.count} 条 / ${formatBytes(pending.bytes)}`
        : "正在等待已排队写入完成",
    });
    try {
      clearFlushTimer();
      const { items, stats } = takePending();
      setDownloadProgress({
        phase: "stopping",
        sessionId: id,
        current: 1,
        total: 4,
        percent: 5,
        label: "旧录制已转入后台",
        detail: stats.count > 0
          ? `最后 ${stats.count} 条 / ${formatBytes(stats.bytes)} 将在后台落盘`
          : "剩余缓冲已转入后台封存",
      });
      closeStoppedSessionInBackground(recorder, id, items, stats, previousFlush);
      await waitForPaint();
      void refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setDownloadProgress({
        phase: "error",
        sessionId: id,
        current: 0,
        total: 0,
        percent: 0,
        label: "停止录制失败",
        detail: message,
      });
      setError(message);
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [clearFlushTimer, closeStoppedSessionInBackground, refresh, takePending]);

  const downloadRecovered = useCallback(async (id: string) => {
    enqueueExport(id);
  }, [enqueueExport]);

  return useMemo(() => ({
    kind,
    active,
    starting,
    stopping,
    exporting,
    profile,
    exportQueue,
    exportQueuedIds: exportQueue,
    downloadProgress,
    recoverable,
    error,
    start,
    append,
    stopAndDownload,
    downloadRecovered,
    setProfile,
  }), [
    kind,
    active,
    starting,
    stopping,
    exporting,
    profile,
    exportQueue,
    downloadProgress,
    recoverable,
    error,
    start,
    append,
    stopAndDownload,
    downloadRecovered,
    setProfile,
  ]);
}
