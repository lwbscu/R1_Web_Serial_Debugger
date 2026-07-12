import type { RecordingDownloadProgress as DownloadProgress } from "./useRecorder";

export function RecordingDownloadProgress({ progress }: { progress: DownloadProgress | null }) {
  if (!progress) return null;
  const valueText = `${progress.percent}%`;
  const countText = progress.total > 0 ? `${progress.current}/${progress.total}` : "准备中";

  return <section
    className={`recording-progress recording-progress-${progress.phase}`}
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <div>
      <span>录制下载</span>
      <strong>{progress.label}</strong>
      <small>{progress.detail}</small>
    </div>
    <div className="recording-progress-meter">
      <progress aria-label="录制下载进度" max={100} value={progress.percent}>{valueText}</progress>
      <b>{valueText} · {countText}</b>
    </div>
  </section>;
}
