import { useEffect, useMemo, useState } from "react";
import { WorkspaceHeader } from "../../shared/components/WorkspaceHeader";
import { demoChassisFrame, demoRemoteFrame, demoRemoteTxEvent } from "../demo/demoData";
import { buildRemoteCommandView, formatHexBytes, type RemoteCommandStatus } from "./model";
import { remoteDebugStore, useRemoteDebugState } from "./remoteDebugStore";

function statusLabel(status: RemoteCommandStatus): string {
  return { normal: "正常", warn: "注意", error: "异常", unknown: "未知" }[status];
}

function statusClass(status: RemoteCommandStatus): string {
  return `remote-status remote-status-${status}`;
}

function displayTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(at);
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
  const latestRemoteLog = useMemo(() => {
    for (let index = state.logs.length - 1; index >= 0; index -= 1) {
      const entry = state.logs[index];
      if (entry?.role === "remote") return entry;
    }
    return null;
  }, [state.logs]);
  const remoteSerialStatus = useMemo(() => {
    if (latestRemoteAge !== null && latestRemoteAge <= 1500) {
      return {
        status: "normal" as const,
        title: "遥控器串口正在接收",
        detail: state.latestTx ? "RDBG 与 RDBG_TX 都在刷新，可直接看命令和协议数组。" : "RDBG 正在刷新；若要看协议数组，请烧录带 RDBG_TX 的遥控器固件。",
      };
    }
    if (latestRemoteAge !== null) {
      return {
        status: "warn" as const,
        title: "遥控器 RDBG 已过期",
        detail: `${latestRemoteAge} ms 未刷新有效遥控器帧，请回通信诊断页检查端口是否断开或选错。`,
      };
    }
    if (latestRemoteLog) {
      return {
        status: "warn" as const,
        title: "遥控器串口有输入",
        detail: `最近输入解析结果为 ${latestRemoteLog.result}，尚未形成有效 RDBG。请确认选到遥控器调试串口。`,
      };
    }
    return {
      status: "unknown" as const,
      title: "等待遥控器串口",
      detail: "串口连接由通信诊断页统一持有；本窗口只复用已采集的 remote 数据，不会重复打开端口。",
    };
  }, [latestRemoteAge, latestRemoteLog, state.latestTx]);

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
          <div><dt>RDBG age</dt><dd>{latestRemoteAge === null ? "—" : `${latestRemoteAge} ms`}</dd></div>
          <div><dt>RDBG_TX age</dt><dd>{latestTxAge === null ? "—" : `${latestTxAge} ms`}</dd></div>
          <div><dt>当前频道</dt><dd>{state.latestRemote ? `CH ${state.latestRemote.rfCh}` : "—"}</dd></div>
          <div><dt>最近命令</dt><dd>{state.latestTx ? `${state.latestTx.packetType} #${state.latestTx.seq}` : "—"}</dd></div>
        </dl>
        <p className="remote-serial-note">这里不提供第二套“选择串口”，避免同一个浏览器端口被重复占用。需要连接/断开时回到通信诊断页操作。</p>
        <button type="button" className="wide secondary" onClick={onOpenCommunication}>去通信诊断连接串口</button>
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
