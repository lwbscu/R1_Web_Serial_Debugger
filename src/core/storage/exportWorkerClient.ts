import type { ExportedVolume, ExportSessionOptions, ExportSessionProgress } from "./exporter";

interface WorkerProgressMessage {
  type: "progress";
  jobId: string;
  progress: ExportSessionProgress;
}

interface WorkerVolumeMessage {
  type: "volume";
  jobId: string;
  volume: Omit<ExportedVolume, "bytes"> & { bytes: ArrayBuffer };
}

interface WorkerDoneMessage {
  type: "done";
  jobId: string;
}

interface WorkerErrorMessage {
  type: "error";
  jobId: string;
  message: string;
}

type WorkerMessage = WorkerProgressMessage | WorkerVolumeMessage | WorkerDoneMessage | WorkerErrorMessage;

function nextJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function* exportSessionVolumesInWorker(
  sessionId: string,
  options: ExportSessionOptions = {},
): AsyncGenerator<ExportedVolume, void, void> {
  if (typeof Worker === "undefined") throw new Error("Web Worker is unavailable in this browser context");

  const jobId = nextJobId();
  const worker = new Worker(new URL("./exportWorker.ts", import.meta.url), { type: "module" });
  const queue: Array<ExportedVolume | null> = [];
  const waiters: Array<{
    resolve: (value: ExportedVolume | null) => void;
    reject: (reason: unknown) => void;
  }> = [];
  let terminalError: Error | null = null;

  const push = (value: ExportedVolume | null): void => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queue.push(value);
  };
  const fail = (error: Error): void => {
    terminalError = error;
    const pending = waiters.splice(0);
    pending.forEach((waiter) => waiter.reject(error));
  };
  const take = (): Promise<ExportedVolume | null> => {
    if (terminalError) return Promise.reject(terminalError);
    const next = queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;
    if (message.jobId !== jobId) return;
    if (message.type === "progress") {
      void options.onProgress?.(message.progress);
      return;
    }
    if (message.type === "volume") {
      push({
        ...message.volume,
        bytes: new Uint8Array(message.volume.bytes),
      });
      return;
    }
    if (message.type === "done") {
      push(null);
      return;
    }
    fail(new Error(message.message));
  };
  worker.onerror = (event) => {
    fail(new Error(event.message || "Recording export worker failed"));
  };

  worker.postMessage({
    type: "export",
    jobId,
    sessionId,
    maxVolumeBytes: options.maxVolumeBytes,
    compressionLevel: options.compressionLevel,
  });

  try {
    while (true) {
      const item = await take();
      if (item === null) break;
      yield item;
    }
  } finally {
    worker.terminate();
  }
}
