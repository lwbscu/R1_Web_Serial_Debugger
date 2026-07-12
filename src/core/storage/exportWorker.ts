/// <reference lib="webworker" />

import { exportSessionVolumes } from "./exporter";
import { OpfsFileStore } from "./fileStore";
import type { ExportSessionProgress } from "./exporter";

interface ExportWorkerRequest {
  type: "export";
  jobId: string;
  sessionId: string;
  maxVolumeBytes?: number;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

type ExportWorkerResponse =
  | { type: "progress"; jobId: string; progress: ExportSessionProgress }
  | {
    type: "volume";
    jobId: string;
    volume: {
      filename: string;
      index: number;
      total: number;
      firstObservedAtMs: number;
      lastObservedAtMs: number;
      bytes: ArrayBuffer;
    };
  }
  | { type: "done"; jobId: string }
  | { type: "error"; jobId: string; message: string };

const worker = self as DedicatedWorkerGlobalScope;

function post(message: ExportWorkerResponse, transfer?: Transferable[]): void {
  worker.postMessage(message, transfer ?? []);
}

function transferableBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  return bytes.slice();
}

worker.onmessage = (event: MessageEvent<ExportWorkerRequest>) => {
  const request = event.data;
  if (request.type !== "export") return;
  void runExport(request);
};

async function runExport(request: ExportWorkerRequest): Promise<void> {
  try {
    const store = new OpfsFileStore();
    for await (const volume of exportSessionVolumes(store, request.sessionId, {
      maxVolumeBytes: request.maxVolumeBytes,
      compressionLevel: request.compressionLevel,
      onProgress: (progress) => post({ type: "progress", jobId: request.jobId, progress }),
    })) {
      const bytes = transferableBytes(volume.bytes);
      post({
        type: "volume",
        jobId: request.jobId,
        volume: {
          filename: volume.filename,
          index: volume.index,
          total: volume.total,
          firstObservedAtMs: volume.firstObservedAtMs,
          lastObservedAtMs: volume.lastObservedAtMs,
          bytes: bytes.buffer,
        },
      }, [bytes.buffer]);
    }
    post({ type: "done", jobId: request.jobId });
  } catch (reason) {
    post({
      type: "error",
      jobId: request.jobId,
      message: reason instanceof Error ? reason.message : String(reason),
    });
  }
}

export {};
