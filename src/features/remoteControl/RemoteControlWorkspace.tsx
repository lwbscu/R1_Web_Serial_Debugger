import { useEffect, useMemo, useState } from "react";
import type { PortSnapshot } from "../../core/serial";
import { WorkspaceHeader } from "../../shared/components/WorkspaceHeader";
import { demoChassisFrame, demoRemoteFrame, demoRemoteTxEvent } from "../demo/demoData";
import { requestOpenSerialDiscovery } from "../serial/discoveryDialogStore";
import { buildRemoteCommandView, formatHexBytes, type RemoteCommandStatus } from "./model";
import { remoteDebugStore, type RemoteDebugPortState, useRemoteDebugState } from "./remoteDebugStore";

function statusLabel(status: RemoteCommandStatus): string {
  return { normal: "正常", warn: "注意", error: "异常", unknown: "未知" }[status];
}

function statusClass(status: RemoteCommandStatus): string {
  return `remote-status remote-status-${status}`;
}

function displayTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(at);
}

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
  "bytes-only": "有字节",
  valid: "数据正常",
  stale: "数据过期",
  "wrong-role": "疑似错口",
};

function hex(value: number | undefined): string {
  return value === undefined ? "----" : value.toString(16).toUpperCase().padStart(4, "0");
}

function deviceLabel(snapshot: PortSnapshot | null): string {
  if (!snapshot) return "等待通信诊断页初始化";
  if (snapshot.portInfo) return `VID ${hex(snapshot.portInfo.usbVendorId)} · PID ${hex(snapshot.portInfo.usbProductId)}`;
  return snapshot.selected ? "串口已授权" : "尚未选择串口";
}

function portLifecycleLabel(snapshot: PortSnapshot | null): string {
  return snapshot ? `${HEALTH_TEXT[snapshot.health]} · ${LIFECYCLE_TEXT[snapshot.lifecycle]}` : "等待初始化";
}

function buildRemoteSerialStatus(
  port: RemoteDebugPortState,
  latestRemoteAge: number | null,
  latestRemoteLog: { result: string } | null,
  hasTx: boolean,
): { status: RemoteCommandStatus; title: string; detail: string } {
  const snapshot = port.snapshot;
  if (!port.supported) {
    if (latestRemoteAge !== null && latestRemoteAge <= 1500) {
      return { status: "normal", title: "遥控器数据正在刷新", detail: "当前为通信诊断共享流、演示数据或回放数据；本浏览器环境未开放实时 Web Serial。" };
    }
    return { status: "unknown", title: "浏览器不支持 Web Serial", detail: "实时串口需要 HTTPS 下的桌面版 Chrome / Edge。" };
  }
  if (snapshot?.lifecycle === "reading" && snapshot.health === "valid") {
    return {
      status: "normal",
      title: "遥控器串口正在接收",
      detail: hasTx ? "RDBG 与 RDBG_TX 都在刷新，可直接看命令和协议数组。" : "RDBG 正在刷新；若要看协议数组，请烧录带 RDBG_TX 的遥控器固件。",
    };
  }
  if (snapshot?.health === "wrong-role") {
    return { status: "error", title: "遥控器串口疑似选错", detail: `检测到 ${snapshot.detectedRole ?? "其他"} 协议，请在本侧栏重新选择遥控器调试串口。` };
  }
  if (snapshot?.lifecycle === "reading") {
    return { status: "warn", title: `遥控器串口${HEALTH_TEXT[snapshot.health]}`, detail: "端口已打开但尚未形成稳定 RDBG/RDBG_TX，请看 RX、帧和解析错误计数。" };
  }
  if (snapshot?.error) {
    return { status: "error", title: "遥控器串口连接异常", detail: snapshot.error };
  }
  if (snapshot?.selected) {
    return { status: "warn", title: "遥控器串口已选择未接收", detail: "已获得浏览器授权，但当前没有开始读取；可直接点击本侧栏的连接。" };
  }
  if (latestRemoteAge !== null && latestRemoteAge <= 1500) {
    return { status: "normal", title: "遥控器数据正在刷新", detail: "当前数据来自通信诊断共享流或演示数据。" };
  }
  if (latestRemoteAge !== null) {
    return { status: "warn", title: "遥控器 RDBG 已过期", detail: `${latestRemoteAge} ms 未刷新有效遥控器帧，请检查本侧栏串口是否断开或选错。` };
  }
  if (latestRemoteLog) {
    return { status: "warn", title: "遥控器串口有输入", detail: `最近输入解析结果为 ${latestRemoteLog.result}，尚未形成有效 RDBG。请确认选到遥控器调试串口。` };
  }
  return { status: "unknown", title: "等待遥控器串口", detail: "可在本侧栏选择/连接遥控器调试串口；底层仍复用通信诊断页的同一个只读会话。" };
}

function ByteStrip({ hex }: { hex: string }) {
  if (hex === "—") return <p className="remote-empty-inline">暂无字节。</p>;
  return <div className="byte-strip" aria-label="协议字节数组">{hex.split(" ").map((byte, index) => <code key={`${byte}-${index}`}>{byte}</code>)}</div>;
}

export interface RemoteControlWorkspaceProps {
  active?: boolean;
  onOpenCommunication?: () => void;
}

export function RemoteControlWorkspace({ active = true, onOpenCommunication }: RemoteControlWorkspaceProps) {
  const state = useRemoteDebugState();
  const [nowMs, setNowMs] = useState(Date.now());
  const [demoActive, setDemoActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [frozenEvents, setFrozenEvents] = useState(state.txEvents);
  const view = useMemo(
    () => buildRemoteCommandView(state.latestRemote, state.latestChassis, state.latestTx, nowMs),
    [nowMs, state.latestChassis, state.latestRemote, state.latestTx],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!demoActive) return;
    const tick = () => {
      const at = Date.now();
      remoteDebugStore.publishRemote(demoRemoteFrame(at));
      remoteDebugStore.publishChassis(demoChassisFrame(at));
      remoteDebugStore.publishTx(demoRemoteTxEvent(at));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [demoActive]);

  useEffect(() => {
    if (!active && demoActive) setDemoActive(false);
  }, [active, demoActive]);

  const shownEvents = paused ? frozenEvents : state.txEvents;
  const latestRemoteAge = state.latestRemote ? nowMs - state.latestRemote.observedAtMs : null;
  const latestChassisAge = state.latestChassis ? nowMs - state.latestChassis.observedAtMs : null;
  const latestTxAge = state.latestTx ? nowMs - state.latestTx.observedAtMs : null;
  const remotePort = state.ports.remote;
  const remoteSnapshot = remotePort.snapshot;
  const chassisSnapshot = state.ports.chassis.snapshot;
  const latestRemoteLog = useMemo(() => {
    for (let index = state.logs.length - 1; index >= 0; index -= 1) {
      const entry = state.logs[index];
      if (entry?.role === "remote") return entry;
    }
    return null;
  }, [state.logs]);
  const remoteSerialStatus = useMemo(() => {
    return buildRemoteSerialStatus(remotePort, latestRemoteAge, latestRemoteLog, state.latestTx !== null);
  }, [latestRemoteAge, latestRemoteLog, remotePort, state.latestTx]);
  const remotePortBusy = remoteSnapshot?.lifecycle === "requesting" || remoteSnapshot?.lifecycle === "opening" || remoteSnapshot?.lifecycle === "closing";
  const remotePortReading = remoteSnapshot?.lifecycle === "reading";

  return <main className="workspace remote-control-workspace" data-testid="remote-control-workspace">
    <WorkspaceHeader
      kicker="REMOTE COMMAND OBSERVER"
      title="遥控器窗口"
      description="给操作手看的实时命令面板：把遥控器发出的命令、真实协议字节、NRF ACK、底盘接收和机构反馈放在同一条链路里。"
      meta={<><span>RDBG 兼容</span><span>RDBG_TX v1 payload</span><span>只读观察，不发送串口数据</span></>}
      actions={<><button type="button" className={demoActive ? "selected" : "secondary"} onClick={() => setDemoActive((value) => !value)}>{demoActive ? "停止演示" : "演示遥控器窗口"}</button><button type="button" className="secondary" onClick={() => remoteDebugStore.clear()}>清空窗口</button></>}
    />

    <div className="remote-workspace-layout">
      <aside className={`remote-serial-sidebar panel ${remoteSerialStatus.status}`} aria-label="遥控器串口侧栏">
        <div className="panel-title"><strong>遥控器串口</strong><small>复用通信诊断连接</small></div>
        <div className="remote-serial-primary">
          <span className={`status-orb ${remoteSerialStatus.status === "normal" ? "valid" : remoteSerialStatus.status}`} aria-hidden="true" />
          <div>
            <strong>{remoteSerialStatus.title}</strong>
            <p>{remoteSerialStatus.detail}</p>
          </div>
        </div>
        <dl className="remote-serial-stats">
          <div><dt>串口状态</dt><dd>{portLifecycleLabel(remoteSnapshot)}</dd></div>
          <div><dt>设备标识</dt><dd>{deviceLabel(remoteSnapshot)}</dd></div>
          <div><dt>RX 字节</dt><dd>{remoteSnapshot?.stats.bytesReceived.toLocaleString() ?? "—"} B</dd></div>
          <div><dt>有效帧</dt><dd>{remoteSnapshot?.stats.validFrames.toLocaleString() ?? "—"}</dd></div>
          <div><dt>解析错误</dt><dd>{remoteSnapshot?.stats.parseErrors.toLocaleString() ?? "—"}</dd></div>
          <div><dt>RDBG age</dt><dd>{latestRemoteAge === null ? "—" : `${latestRemoteAge} ms`}</dd></div>
          <div><dt>RDBG_TX age</dt><dd>{latestTxAge === null ? "—" : `${latestTxAge} ms`}</dd></div>
          <div><dt>当前频道</dt><dd>{state.latestRemote ? `CH ${state.latestRemote.rfCh}` : "—"}</dd></div>
          <div><dt>最近命令</dt><dd>{state.latestTx ? `${state.latestTx.packetType} #${state.latestTx.seq}` : "—"}</dd></div>
          <div><dt>底盘参考</dt><dd>{portLifecycleLabel(chassisSnapshot)}</dd></div>
        </dl>
        <div className="remote-serial-actions">
          <button type="button" className="secondary" disabled={!remotePort.supported || remotePortReading || remotePortBusy} onClick={requestOpenSerialDiscovery}>智能识别串口</button>
          <button type="button" className="ghost" disabled={!remotePort.supported || !remotePort.controlsReady || remotePortReading || remotePortBusy} onClick={() => void remoteDebugStore.selectPort("remote")}>高级手动</button>
          {remotePortReading
            ? <button type="button" className="danger subtle" disabled={!remotePort.controlsReady} onClick={() => void remoteDebugStore.closePort("remote")}>断开</button>
            : <button type="button" disabled={!remotePort.supported || !remotePort.controlsReady || !remoteSnapshot?.selected || remotePortBusy} onClick={() => void remoteDebugStore.connectPort("remote")}>连接</button>}
        </div>
        <p className="remote-serial-note">侧栏操作的是通信诊断页同一个只读 Web Serial 会话，不创建第二个端口、不发送任何字节。若要同时看底盘串口，可回通信诊断页。</p>
        <button type="button" className="wide secondary" onClick={onOpenCommunication}>打开通信诊断全量串口</button>
      </aside>

      <div className="remote-workspace-main">
        <section className={`remote-hero panel ${view.primaryStatus}`}>
          <div>
            <span>当前命令</span>
            <strong>{view.title}</strong>
            <p>{view.subtitle}</p>
          </div>
          <dl>
            <div><dt>发送结果</dt><dd>{view.txResult}</dd></div>
            <div><dt>ACK</dt><dd>{view.ackResult}</dd></div>
            <div><dt>命令年龄</dt><dd>{view.ageMs === null ? "—" : `${view.ageMs} ms`}</dd></div>
          </dl>
        </section>

        {view.notice && <p className="remote-notice">{view.notice}</p>}

        <div className="remote-command-grid">
          <section className="panel protocol-panel">
            <div className="panel-title"><strong>协议数组</strong><small>真实 TX / ACK payload</small></div>
            <h3>TX bytes</h3>
            <ByteStrip hex={view.txHex} />
            <h3>ACK bytes</h3>
            <ByteStrip hex={view.ackHex} />
            <div className="remote-args">
              {view.args.length === 0 ? <p className="remote-empty-inline">当前协议未提供解码参数。</p> : view.args.map((arg) => <div key={arg.label}><span>{arg.label}</span><strong>{arg.value}</strong></div>)}
            </div>
          </section>

          <section className="panel effect-panel">
            <div className="panel-title"><strong>效果链路</strong><small>Remote TX → NRF ACK → Chassis → Mechanism</small></div>
            <div className="effect-chain">
              {view.steps.map((step) => <article key={step.key} className={step.status}>
                <span className={statusClass(step.status)}>{statusLabel(step.status)}</span>
                <div><strong>{step.label}</strong><p>{step.detail}</p></div>
              </article>)}
            </div>
          </section>
        </div>

        <section className="panel remote-live-panel">
          <div className="panel-title"><strong>实时上下文</strong><small>来自通信诊断页的同一批串口数据</small></div>
          <div className="remote-context-grid">
            <div><span>遥控器 RDBG</span><strong>{state.latestRemote ? `${state.latestRemote.packetType} · CH ${state.latestRemote.rfCh}` : "未连接"}</strong><small>{latestRemoteAge === null ? "—" : `${latestRemoteAge} ms 前`}</small></div>
            <div><span>链路质量</span><strong>{state.latestRemote ? `${state.latestRemote.signalBars} 格 · score ${state.latestRemote.rxScore}` : "—"}</strong><small>{state.latestRemote ? `noACK ${state.latestRemote.noAckMs} ms · ${state.latestRemote.xReason}` : "等待 RDBG"}</small></div>
            <div><span>底盘 CDBG</span><strong>{state.latestChassis ? `v${state.latestChassis.protocolVersion}/${state.latestChassis.fieldCount}` : "未连接"}</strong><small>{latestChassisAge === null ? "—" : `${latestChassisAge} ms 前`}</small></div>
            <div><span>最近 RDBG_TX</span><strong>{state.latestTx ? `${state.latestTx.packetType} #${state.latestTx.seq}` : "未见"}</strong><small>{state.latestTx ? formatHexBytes(state.latestTx.txBytes) : "需要新遥控器固件"}</small></div>
          </div>
        </section>

        <section className="panel remote-events-panel">
          <div className="console-toolbar">
            <div className="panel-title"><strong>最近遥控器发包</strong><small>{shownEvents.length} 条</small></div>
            <div className="toolbar"><button className={paused ? "selected" : "secondary"} onClick={() => { if (!paused) setFrozenEvents([...state.txEvents]); setPaused((value) => !value); }}>{paused ? "继续滚动" : "暂停滚动"}</button></div>
          </div>
          {shownEvents.length === 0 ? <p className="empty">尚无 RDBG_TX。烧录新遥控器固件，或点击“演示遥控器窗口”。</p> : <div className="remote-tx-table">
            <div className="remote-tx-head"><span>PC time</span><span>type</span><span>tx</span><span>ack</span><span>args</span></div>
            {shownEvents.slice(-120).reverse().map((event) => <div className="remote-tx-row" key={`${event.observedAtMs}-${event.seq}`}>
              <time>{displayTime(event.observedAtMs)}</time>
              <strong>{event.packetType}</strong>
              <code>{formatHexBytes(event.txBytes)}</code>
              <code>{formatHexBytes(event.ackBytes)}</code>
              <span>{event.args.join(", ")}</span>
            </div>)}
          </div>}
          {state.parseErrors.length > 0 && <p className="warning">最近解析错误：{state.parseErrors.at(-1)?.detail}</p>}
        </section>
      </div>
    </div>
  </main>;
}
