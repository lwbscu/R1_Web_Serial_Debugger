import type { PortSnapshot } from "../../core/serial";
import { InfoTip } from "./InfoTip";

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
  selectLabel?: string;
  onAdvancedSelect?: () => void;
}

export function SerialConnectionBar({ title, subtitle, supported, snapshot, onSelect, onConnect, onClose, selectLabel = "智能识别串口", onAdvancedSelect }: SerialConnectionBarProps) {
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
      <div className="serial-device-line"><span>{device}</span><InfoTip label={`${title} 设备标识说明`}>网页只能读取浏览器提供的 USB VID/PID，不能可靠读取 Windows 的 COM 号；“已授权”也不等于已识别到正确协议。COM 号请在浏览器选口窗口或设备管理器中确认。</InfoTip></div>
      <small>115200 baud · 8N1 · Receive only <InfoTip label={`${title} 串口参数与只读说明`}>以 115200 波特率、8 数据位、无校验、1 停止位接收。网页不创建 writer、不发送命令，也不主动切换 DTR/RTS；但个别驱动在打开端口时仍可能影响板卡线路状态。</InfoTip></small>
    </div>
    <div className="serial-health">
      <strong>{HEALTH_TEXT[snapshot.health]} <InfoTip label={`${title} 数据健康说明`}><strong>尚无数据</strong>表示没有收到字节；<strong>有字节</strong>表示尚未解析出有效帧；<strong>正常</strong>表示持续收到目标协议；<strong>过期</strong>表示最后有效帧超过 1.5 秒；<strong>选错端口</strong>表示连续识别到其他角色协议。</InfoTip></strong>
      <span>{LIFECYCLE_TEXT[snapshot.lifecycle]}</span>
    </div>
    <div className="serial-actions">
      <button type="button" className="secondary" onClick={onSelect} disabled={!supported || snapshot.lifecycle === "reading" || busy}>{selectLabel}</button>
      {onAdvancedSelect && <button type="button" className="ghost serial-advanced-select" onClick={onAdvancedSelect} disabled={!supported || snapshot.lifecycle === "reading" || busy}>高级手动</button>}
      {snapshot.lifecycle === "reading"
        ? <button type="button" className="danger subtle" onClick={onClose}>断开</button>
        : <button type="button" onClick={onConnect} disabled={!snapshot.selected || busy}>连接</button>}
    </div>
    <dl className="serial-counters" aria-label={`${title} 接收统计`}>
      <div><dt>RX <InfoTip label={`${title} 接收统计说明`}>RX 是本次连接读取的原始字节数；“帧”仅统计成功解析的目标协议帧；“错误”统计被协议解析器拒绝的数据行。三者不会因为暂停界面滚动而停止累计。</InfoTip></dt><dd>{snapshot.stats.bytesReceived.toLocaleString()} B</dd></div>
      <div><dt>帧</dt><dd>{snapshot.stats.validFrames.toLocaleString()}</dd></div>
      <div><dt>错误</dt><dd>{snapshot.stats.parseErrors.toLocaleString()}</dd></div>
    </dl>
    {snapshot.health === "wrong-role" && <p className="inline-alert warning">持续检测到 {snapshot.detectedRole ?? "其他"} 协议。若目标角色空闲，网页会自动迁移到对应连接；若目标已连接，请先断开冲突端口。</p>}
    {snapshot.error && <p className="inline-alert error">{snapshot.error}</p>}
  </section>;
}
