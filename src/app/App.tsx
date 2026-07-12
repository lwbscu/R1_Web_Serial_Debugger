import { useCallback, useEffect, useState } from "react";
import { contextForSide, type LocatorCoordinateContext } from "../core/locator";
import { CommunicationWorkspace } from "../features/communication/CommunicationWorkspace";
import { LocatorWorkspace } from "../features/locator/LocatorWorkspace";
import { RecordingDownloadProgress } from "../features/recording/RecordingDownloadProgress";
import { useRecorder } from "../features/recording/useRecorder";
import { RemoteControlWorkspace } from "../features/remoteControl/RemoteControlWorkspace";
import { AutoSerialDiscovery } from "../features/serial/AutoSerialDiscovery";
import { SerialConnectionCenter } from "../features/serial/SerialConnectionCenter";
import { serialSessionRegistry } from "../features/serial/serialSessionRegistry";
import { WaveformWorkspace } from "../features/waveform/WaveformWorkspace";
import { BUILD_INFO } from "../shared/buildInfo";
import { LinkIcon, MapIcon, ShieldIcon, WaveIcon } from "../shared/components/Icons";
import type { SourceRole } from "../core/types";

type Workspace = "communication" | "remote-control" | "locator" | "waveform";

const WORKSPACES = [
  { id: "communication", label: "通信诊断", detail: "RDBG · CDBG", icon: LinkIcon },
  { id: "remote-control", label: "遥控器窗口", detail: "命令 · ACK", icon: LinkIcon },
  { id: "locator", label: "定位地图", detail: "轨迹 · DT35", icon: MapIcon },
  { id: "waveform", label: "数据示波器", detail: "多变量 · 时间轴", icon: WaveIcon },
] as const;

export function App() {
  const [active, setActive] = useState<Workspace>("communication");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const recorder = useRecorder("global");
  const [locatorCoordinates, setLocatorCoordinates] = useState<LocatorCoordinateContext>(() => contextForSide("red", "official"));

  const focusRole = useCallback((role: SourceRole, mode: "single" | "batch" = "single") => {
    if (mode === "batch") return;
    if (role === "remote") setActive("remote-control");
    else if (role === "locator") setActive("locator");
    else setActive("communication");
  }, []);

  useEffect(() => {
    const check = async () => {
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        const value = await response.json() as { commit?: string };
        if (value.commit && value.commit !== BUILD_INFO.commit && BUILD_INFO.commit !== "development") setUpdateAvailable(true);
      } catch { /* Acquisition remains available offline. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 10 * 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => serialSessionRegistry.subscribe((event) => {
    if (event.type === "migrated") focusRole(event.role, "single");
  }), [focusRole]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><span>R1</span><i /></span>
        <div><strong>R1 Telemetry</strong><small>WEB SERIAL WORKBENCH</small></div>
      </div>

      <div className="sidebar-section-label">工作区</div>
      <nav aria-label="工作区">
        {WORKSPACES.map(({ id, label, detail, icon: Icon }) => <button type="button" key={id} className={active === id ? "active" : ""} onClick={() => setActive(id)} aria-label={`${label} · ${detail}`} title={`${label} · ${detail}`} aria-current={active === id ? "page" : undefined}>
          <Icon />
          <span><strong>{label}</strong><small>{detail}</small></span>
          <i className="nav-indicator" />
        </button>)}
      </nav>

      <SerialConnectionCenter recorder={recorder} locatorCoordinates={locatorCoordinates} />
      <AutoSerialDiscovery
        showLaunch={false}
        onRoleBound={focusRole}
        onBatchComplete={(roles) => { if (roles.length > 1) setActive("communication"); }}
        onProbeRawLine={(deviceId, line) => { void recorder.append("raw_serial.log", `${Date.now()},probe,${deviceId},${line}\n`); }}
      />

      <div className="sidebar-spacer" />
      <section className="trust-card">
        <ShieldIcon />
        <div><strong>严格接收模式</strong><p>不创建 writer、不发送字节、不主动调用 setSignals；打开端口时线路行为仍由具体驱动决定。</p></div>
      </section>
      <footer>
        <div><span>BUILD</span><strong>{BUILD_INFO.commit.slice(0, 8)}</strong></div>
        <div><span>PARSERS</span><strong>R{BUILD_INFO.parsers.remote} · C{BUILD_INFO.parsers.chassis} · L{BUILD_INFO.parsers.locator}</strong></div>
        <time>{new Date(BUILD_INFO.builtAt).toLocaleString()}</time>
      </footer>
    </aside>

    <div className="content">
      {updateAvailable && <div className="update-banner"><strong>检测到新版本</strong><span>请停止录制后刷新页面，串口不会被网站自动重连。</span></div>}
      <div className="global-progress-host"><RecordingDownloadProgress progress={recorder.downloadProgress} /></div>
      <div className={active === "communication" ? "workspace-host active" : "workspace-host"} aria-hidden={active !== "communication"}><CommunicationWorkspace active={active === "communication" || active === "remote-control"} recorder={recorder} /></div>
      <div className={active === "remote-control" ? "workspace-host active" : "workspace-host"} aria-hidden={active !== "remote-control"}><RemoteControlWorkspace active={active === "remote-control"} onOpenCommunication={() => setActive("communication")} /></div>
      <div className={active === "locator" ? "workspace-host active" : "workspace-host"} aria-hidden={active !== "locator"}><LocatorWorkspace active={active === "locator"} recorder={recorder} onCoordinateContextChange={setLocatorCoordinates} /></div>
      <div className={active === "waveform" ? "workspace-host active" : "workspace-host"} aria-hidden={active !== "waveform"}><WaveformWorkspace active={active === "waveform"} /></div>
    </div>
  </div>;
}
