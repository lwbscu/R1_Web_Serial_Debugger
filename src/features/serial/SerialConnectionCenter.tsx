import { useCallback, useEffect, useMemo, useRef } from "react";
import type { PortSnapshot } from "../../core/serial";
import type { SourceRole } from "../../core/types";
import type { LocatorCoordinateContext } from "../../core/locator";
import { encodeCsvRow } from "../../core/storage";
import { RecordIcon } from "../../shared/components/Icons";
import { InfoTip } from "../../shared/components/InfoTip";
import type { RecorderController } from "../recording/useRecorder";
import { requestOpenSerialDiscovery } from "./discoveryDialogStore";
import { useSerialHubState } from "./serialHubStore";

const ROLE_LABELS: Record<SourceRole, string> = {
  remote: "遥控器",
  chassis: "底盘",
  locator: "码盘/定位板",
};

const ROLE_SUBTITLES: Record<SourceRole, string> = {
  remote: "RDBG · RDBG_TX",
  chassis: "CDBG · CEVT",
  locator: "CSV · $R1M",
};

const ORDER: SourceRole[] = ["remote", "chassis", "locator"];
const CONNECTION_STATUS_HEADER = "pc_time_ms,role,status,lifecycle,health,selected,detected_role,bytes_received,valid_frames,parse_errors,error\r\n";

const HEALTH_TEXT: Record<PortSnapshot["health"] | "unlinked", string> = {
  unlinked: "未链接",
  "no-data": "尚无数据",
  "bytes-only": "有字节",
  valid: "正常",
  stale: "过期",
  "wrong-role": "错口",
};

const LIFECYCLE_TEXT: Record<PortSnapshot["lifecycle"] | "unlinked", string> = {
  unlinked: "未选择",
  idle: "待机",
  requesting: "授权中",
  opening: "打开中",
  reading: "接收中",
  closing: "关闭中",
  error: "异常",
};

function hex(value: number | undefined): string {
  return value === undefined ? "----" : value.toString(16).toUpperCase().padStart(4, "0");
}

function roleStatus(snapshot: PortSnapshot | null): "not_connected" | "connected" | "stale" | "wrong_role" | "disconnected" | "error" {
  if (!snapshot || !snapshot.selected) return "not_connected";
  if (snapshot.lifecycle === "error") return "error";
  if (snapshot.lifecycle !== "reading") return "disconnected";
  if (snapshot.health === "wrong-role") return "wrong_role";
  if (snapshot.health === "stale") return "stale";
  return "connected";
}

function deviceText(snapshot: PortSnapshot | null): string {
  if (!snapshot) return "等待工作区初始化";
  if (snapshot.portInfo) return `VID ${hex(snapshot.portInfo.usbVendorId)} · PID ${hex(snapshot.portInfo.usbProductId)}`;
  return snapshot.selected ? "串口已授权" : "未授权";
}

function statusKey(role: SourceRole, snapshot: PortSnapshot | null): string {
  if (!snapshot) return `${role}:unlinked`;
  return [
    role,
    roleStatus(snapshot),
    snapshot.lifecycle,
    snapshot.health,
    snapshot.selected ? "selected" : "unselected",
    snapshot.detectedRole ?? "",
    snapshot.error ?? "",
  ].join(":");
}

function statusRow(role: SourceRole, snapshot: PortSnapshot | null, at = Date.now()): string {
  return encodeCsvRow([
    at,
    role,
    roleStatus(snapshot),
    snapshot?.lifecycle ?? "unlinked",
    snapshot?.health ?? "unlinked",
    snapshot?.selected ? 1 : 0,
    snapshot?.detectedRole ?? "",
    snapshot?.stats.bytesReceived ?? 0,
    snapshot?.stats.validFrames ?? 0,
    snapshot?.stats.parseErrors ?? 0,
    snapshot?.error ?? "",
  ]);
}

export function SerialConnectionCenter({ recorder, locatorCoordinates }: {
  recorder: RecorderController;
  locatorCoordinates: LocatorCoordinateContext;
}) {
  const state = useSerialHubState();
  const snapshots = useMemo(() => ({
    remote: state.roles.remote.snapshot,
    chassis: state.roles.chassis.snapshot,
    locator: state.roles.locator.snapshot,
  }), [state.roles.chassis.snapshot, state.roles.locator.snapshot, state.roles.remote.snapshot]);
  const lastKeys = useRef<Record<SourceRole, string | null>>({ remote: null, chassis: null, locator: null });
  const wasActive = useRef(false);

  useEffect(() => {
    if (!recorder.active) {
      wasActive.current = false;
      return;
    }
    if (!wasActive.current) {
      lastKeys.current = { remote: null, chassis: null, locator: null };
      wasActive.current = true;
      void recorder.append("connection_status.csv", CONNECTION_STATUS_HEADER);
    }
    for (const role of ORDER) {
      const snapshot = snapshots[role];
      const key = statusKey(role, snapshot);
      if (lastKeys.current[role] === key) continue;
      lastKeys.current[role] = key;
      void recorder.append("connection_status.csv", statusRow(role, snapshot));
    }
  }, [recorder, snapshots]);

  const startRecording = useCallback(async () => {
    await recorder.start({ locatorCoordinates });
  }, [locatorCoordinates, recorder]);

  const recordingLabel = recorder.starting ? "正在开始录制" : recorder.stopping ? "正在停止录制" : recorder.active ? "停止并后台下载" : "开始三串口录制";
  const modeLocked = recorder.active || recorder.starting || recorder.stopping;

  return <section className="serial-center" aria-label="三串口连接中心">
    <div className="sidebar-section-label">三串口连接中心</div>
    <div className="serial-center-card">
      <div className="serial-center-head">
        <div><strong>智能连接与统一录制</strong><small>自动识别遥控器 / 底盘 / 码盘</small></div>
        <InfoTip label="三串口连接中心说明">点击智能连接后，网页先只读采样判断角色，再自动绑定到对应工作区。Web Serial 仍要求你在浏览器弹窗中授权新串口；已授权串口可批量探测。统一录制会把未连接角色写为 not_connected，后续接入后自动续录。</InfoTip>
      </div>
      <div className="serial-center-actions">
        <button type="button" onClick={requestOpenSerialDiscovery}>智能连接串口</button>
        <button type="button" className={recorder.active && !recorder.starting ? "danger" : "secondary"} disabled={recorder.starting || recorder.stopping} onClick={() => void (recorder.active ? recorder.stopAndDownload() : startRecording())}><RecordIcon />{recordingLabel}</button>
      </div>
      <div className="recording-profile-toggle" aria-label="录制包模式">
        <button type="button" className={recorder.profile === "quickSerial" ? "selected" : "secondary"} disabled={modeLocked} aria-pressed={recorder.profile === "quickSerial"} onClick={() => recorder.setProfile("quickSerial")}>快速串口包</button>
        <button type="button" className={recorder.profile === "full" ? "selected" : "secondary"} disabled={modeLocked} aria-pressed={recorder.profile === "full"} onClick={() => recorder.setProfile("full")}>完整诊断包</button>
      </div>
      <p className="recording-profile-hint">{recorder.profile === "quickSerial" ? "录制期间预生成快速 ZIP，仅保存三路原始串口和连接状态。" : "保存原始串口、解析 CSV、事件和诊断派生数据。"}</p>
      <div className="serial-role-list">
        {ORDER.map((role) => {
          const roleState = state.roles[role];
          const snapshot = snapshots[role];
          const health = snapshot?.selected ? snapshot.health : "unlinked";
          const lifecycle = snapshot?.selected ? snapshot.lifecycle : "unlinked";
          return <article key={role} className="serial-role-card" data-health={health}>
            <div><span className={`status-orb ${health}`} aria-hidden="true" /><strong>{ROLE_LABELS[role]}</strong><small>{ROLE_SUBTITLES[role]}</small></div>
            <dl>
              <div><dt>状态</dt><dd>{HEALTH_TEXT[health]} · {LIFECYCLE_TEXT[lifecycle]}</dd></div>
              <div><dt>设备</dt><dd>{deviceText(snapshot)}</dd></div>
              <div><dt>RX</dt><dd>{snapshot?.stats.bytesReceived.toLocaleString() ?? "0"} B · {snapshot?.stats.validFrames.toLocaleString() ?? "0"} 帧</dd></div>
            </dl>
            {roleState.lastAutoMessage && <p className="serial-role-message">{roleState.lastAutoMessage}</p>}
          </article>;
        })}
      </div>
      {recorder.error && <p className="error serial-center-error">录制：{recorder.error}</p>}
      {recorder.recoverable.length > 0 && <div className="serial-center-recovery"><strong>可恢复</strong>{recorder.recoverable.slice(0, 3).map((item) => {
        const queued = recorder.exportQueuedIds.includes(item.manifest.sessionId);
        return <button type="button" className="secondary" key={item.manifest.sessionId} disabled={queued} onClick={() => void recorder.downloadRecovered(item.manifest.sessionId)}>{queued ? "导出中" : item.manifest.sessionId}</button>;
      })}</div>}
    </div>
  </section>;
}
