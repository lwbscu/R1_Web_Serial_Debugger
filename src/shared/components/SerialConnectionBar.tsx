import type { PortSnapshot } from "../../core/serial";

const LIFECYCLE_TEXT: Record<PortSnapshot["lifecycle"], string> = {
  idle: "待机",
  requesting: "等待授权",
  opening: "正在打开",
  reading: "正在接收",
  closing: "正在关闭",
  error: "连接异常",
};

const HEALTH_TEXT: Record<PortSnapshot["health"], string> = {
  "no-data": "尚无数据",
  "bytes-only": "有字节，等待有效帧",
  valid: "数据正常",
  stale: "数据已过期",
  "wrong-role": "疑似选错端口",
};

function hex(value: number | undefined): string {
  return value === undefined ? "----" : value.toString(16).toUpperCase().padStart(4, "0");
}

export interface SerialConnectionBarProps {
  title: string;
  subtitle: string;
  supported: boolean;
  snapshot: PortSnapshot;
  onSelect(): void;
  onConnect(): void;
  onClose(): void;
}

export function SerialConnectionBar({ title, subtitle, supported, snapshot, onSelect, onConnect, onClose }: SerialConnectionBarProps) {
  const busy = snapshot.lifecycle === "requesting" || snapshot.lifecycle === "opening" || snapshot.lifecycle === "closing";
  const device = snapshot.portInfo
    ? `USB VID ${hex(snapshot.portInfo.usbVendorId)} · PID ${hex(snapshot.portInfo.usbProductId)}`
    : snapshot.selected ? "串口已授权" : "尚未选择本机串口";

  return <section className="serial-connection" data-health={snapshot.health}>
    <div className="serial-identity">
      <span className={`status-orb ${snapshot.health}`} aria-hidden="true" />
      <div><strong>{title}</strong><span>{subtitle}</span></div>
    </div>
    <div className="serial-device">
      <span>{device}</span>
      <small>115200 baud · 8N1 · Receive only</small>
    </div>
    <div className="serial-health">
      <strong>{HEALTH_TEXT[snapshot.health]}</strong>
      <span>{LIFECYCLE_TEXT[snapshot.lifecycle]}</span>
    </div>
    <div className="serial-actions">
      <button type="button" className="secondary" onClick={onSelect} disabled={!supported || snapshot.lifecycle === "reading" || busy}>选择串口</button>
      {snapshot.lifecycle === "reading"
        ? <button type="button" className="danger subtle" onClick={onClose}>断开</button>
        : <button type="button" onClick={onConnect} disabled={!snapshot.selected || busy}>连接</button>}
    </div>
    <dl className="serial-counters" aria-label={`${title} 接收统计`}>
      <div><dt>RX</dt><dd>{snapshot.stats.bytesReceived.toLocaleString()} B</dd></div>
      <div><dt>帧</dt><dd>{snapshot.stats.validFrames.toLocaleString()}</dd></div>
      <div><dt>错误</dt><dd>{snapshot.stats.parseErrors.toLocaleString()}</dd></div>
    </dl>
    {snapshot.health === "wrong-role" && <p className="inline-alert warning">持续检测到 {snapshot.detectedRole ?? "其他"} 协议。请重新选择正确设备，网页不会自动交换端口。</p>}
    {snapshot.error && <p className="inline-alert error">{snapshot.error}</p>}
  </section>;
}
