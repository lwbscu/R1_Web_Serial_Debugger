import { useEffect, useState } from "react";
import { CommunicationWorkspace } from "../features/communication/CommunicationWorkspace";
import { LocatorWorkspace } from "../features/locator/LocatorWorkspace";
import { BUILD_INFO } from "../shared/buildInfo";

type Workspace = "communication" | "locator";

export function App() {
  const [active, setActive] = useState<Workspace>("communication");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    const check = async () => {
      try {
        const response = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        const value = await response.json() as { commit?: string };
        if (value.commit && value.commit !== BUILD_INFO.commit && BUILD_INFO.commit !== "development") setUpdateAvailable(true);
      } catch { /* Offline acquisition must keep working. */ }
    };
    void check();
    const timer = window.setInterval(() => void check(), 10 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">R1</span><div><strong>Serial Lab</strong><small>receive-only</small></div></div>
      <nav aria-label="工作区"><button className={active === "communication" ? "active" : ""} onClick={() => setActive("communication")}><span>⌁</span>通信诊断</button><button className={active === "locator" ? "active" : ""} onClick={() => setActive("locator")}><span>⌖</span>定位地图</button></nav>
      <div className="safety-note"><strong>严格接收模式</strong><p>网页不会创建串口 writer，也不会改变 DTR/RTS。</p></div>
      <footer><span>build {BUILD_INFO.commit.slice(0, 8)}</span><span>{new Date(BUILD_INFO.builtAt).toLocaleString()}</span><span>R {BUILD_INFO.parsers.remote} · C {BUILD_INFO.parsers.chassis} · L {BUILD_INFO.parsers.locator}</span></footer>
    </aside>
    <div className="content">
      {updateAvailable && <div className="update-banner">网站有新版本。请停止录制后刷新页面。</div>}
      <div className={active === "communication" ? "workspace-host active" : "workspace-host"}><CommunicationWorkspace /></div>
      <div className={active === "locator" ? "workspace-host active" : "workspace-host"}><LocatorWorkspace /></div>
    </div>
  </div>;
}
