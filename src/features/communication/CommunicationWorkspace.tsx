import { useMemo, useRef, useState } from "react";
import type { ReceivedLine } from "../../core/serial";
import { ChassisProtocolAdapter, RemoteProtocolAdapter, type ChassisFrame, type RemoteFrame } from "../../protocols";
import { encodeCsvRow } from "../../core/storage";
import { TrendChart, type TrendPoint } from "../../shared/components/TrendChart";
import { useRecorder } from "../recording/useRecorder";
import { usePortSession } from "../serial/usePortSession";
import { DiagnosticEventDetector, type DiagnosticEvent } from "./eventDetector";

interface LogEntry { at: number; role: string; line: string; result: string }
type Trends = Record<string, TrendPoint[]>;
const WINDOW_MS = 5 * 60_000;

function pushTrend(source: Trends, name: string, value: unknown, at: number): Trends {
  if (typeof value !== "number" || !Number.isFinite(value)) return source;
  return { ...source, [name]: [...(source[name] ?? []), { at, value }].filter((point) => at - point.at <= WINDOW_MS) };
}

function PortCard({ title, port, latest, fields }: { title: string; port: ReturnType<typeof usePortSession<RemoteFrame | ChassisFrame>>; latest: RemoteFrame | ChassisFrame | null; fields: string[] }) {
  const { snapshot } = port;
  return <section className="panel port-card">
    <div className="panel-title"><div><span className={`status-dot ${snapshot.health}`} />{title}</div><span className="badge">{snapshot.lifecycle} / {snapshot.health}</span></div>
    <div className="toolbar">
      <button onClick={() => void port.select()} disabled={!port.supported || snapshot.lifecycle === "reading"}>选择串口</button>
      <button onClick={() => void port.connect()} disabled={!snapshot.selected || snapshot.lifecycle === "reading"}>连接</button>
      <button className="ghost" onClick={() => void port.close()} disabled={snapshot.lifecycle !== "reading"}>断开</button>
    </div>
    {snapshot.health === "wrong-role" && <p className="warning">该端口持续出现 {snapshot.detectedRole} 协议，请手动重选；网页不会自动交换端口。</p>}
    {snapshot.error && <p className="error">{snapshot.error}</p>}
    <dl className="stats"><div><dt>字节</dt><dd>{snapshot.stats.bytesReceived}</dd></div><div><dt>有效帧</dt><dd>{snapshot.stats.validFrames}</dd></div><div><dt>解析错误</dt><dd>{snapshot.stats.parseErrors}</dd></div></dl>
    <div className="metric-grid">{fields.map((field) => <div key={field}><span>{field}</span><strong>{latest ? String(latest[field as keyof typeof latest] ?? "—") : "—"}</strong></div>)}</div>
  </section>;
}

export function CommunicationWorkspace() {
  const remoteAdapter = useMemo(() => new RemoteProtocolAdapter(), []);
  const chassisAdapter = useMemo(() => new ChassisProtocolAdapter(), []);
  const recorder = useRecorder("communication");
  const [remote, setRemote] = useState<RemoteFrame | null>(null);
  const [chassis, setChassis] = useState<ChassisFrame | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [trends, setTrends] = useState<Trends>({});
  const detector = useRef(new DiagnosticEventDetector());
  const handle = (role: "remote" | "chassis") => (received: ReceivedLine<RemoteFrame | ChassisFrame>) => {
    const result = received.outcome.kind;
    setLogs((old) => [...old, { at: Date.now(), role, line: received.line, result }].slice(-1000));
    void recorder.append(role === "remote" ? "remote_raw.log" : "chassis_raw.log", `${Date.now()},${received.line}\n`);
    if (received.outcome.kind === "event") {
      void recorder.append("events.csv", encodeCsvRow([Date.now(), role, received.outcome.event.eventKind, JSON.stringify(received.outcome.event.fields)]));
    }
    if (received.outcome.kind !== "frame") return;
    const frame = received.outcome.frame;
    if (role === "remote") {
      const value = frame as RemoteFrame; setRemote(value);
      const derived = detector.current.acceptRemote(value);
      setEvents((old) => [...old, ...derived].slice(-200));
      derived.forEach((event) => void recorder.append("events.csv", encodeCsvRow([event.observedAtMs, event.kind, event.severity, event.detail])));
      setTrends((old) => pushTrend(pushTrend(pushTrend(old, "signal_bars", value.signalBars, Date.now()), "no_ack_ms", value.noAckMs, Date.now()), "fail_count", value.failCount, Date.now()));
      void recorder.append("remote_rdbg.csv", encodeCsvRow([Date.now(), received.line]));
    } else {
      const value = frame as ChassisFrame; setChassis(value);
      const derived = detector.current.acceptChassis(value);
      setEvents((old) => [...old, ...derived].slice(-200));
      derived.forEach((event) => void recorder.append("events.csv", encodeCsvRow([event.observedAtMs, event.kind, event.severity, event.detail])));
      setTrends((old) => pushTrend(pushTrend(pushTrend(old, "ack_score", value.ackScore, Date.now()), "last_sig_age_ms", value.lastSigAgeMs, Date.now()), "packet_loss_rate", value.packetLossRate, Date.now()));
      void recorder.append("chassis_cdbg.csv", encodeCsvRow([Date.now(), received.line]));
    }
  };
  const remotePort = usePortSession<RemoteFrame>("remote", remoteAdapter, handle("remote"));
  const chassisPort = usePortSession<ChassisFrame>("chassis", chassisAdapter, handle("chassis"));
  return <main className="workspace" data-testid="communication-workspace">
    <header className="workspace-head"><div><p className="eyebrow">R1 LINK DIAGNOSTICS</p><h2>双串口通信诊断</h2><p>遥控器 RDBG 与底盘 CDBG 独立读取，任何一侧断开都不会影响另一侧。</p></div>
      <div className="toolbar"><button className={recorder.active ? "danger" : ""} onClick={() => void (recorder.active ? recorder.stopAndDownload() : recorder.start())}>{recorder.active ? "停止并下载" : "开始本地录制"}</button></div></header>
    {!remotePort.supported && <div className="unsupported">当前浏览器不支持 Web Serial。请在桌面版 Chrome 或 Edge 的 HTTPS 页面打开。</div>}
    <div className="two-column">
      <PortCard title="遥控器 / RDBG" port={remotePort as ReturnType<typeof usePortSession<RemoteFrame | ChassisFrame>>} latest={remote} fields={["rfCh", "signalBars", "noAckMs", "failCount", "linkOnline", "xReason"]} />
      <PortCard title="底盘 / CDBG" port={chassisPort as ReturnType<typeof usePortSession<RemoteFrame | ChassisFrame>>} latest={chassis} fields={["nrfCh", "ackScore", "lastSigAgeMs", "packetLossRate", "linkReason", "locFrameAgeMs"]} />
    </div>
    <section className="panel"><div className="panel-title"><span>最近 5 分钟趋势</span><span className="muted">显示限频，不影响完整录制</span></div><div className="trend-grid">{([
      ["signal_bars", "#41dba8"], ["no_ack_ms", "#ffbf69"], ["fail_count", "#ff667d"], ["ack_score", "#5ab0ff"], ["last_sig_age_ms", "#b494ff"], ["packet_loss_rate", "#f18fda"],
    ] satisfies ReadonlyArray<readonly [string, string]>).map(([name, color]) => <TrendChart key={name} label={name} color={color} points={trends[name] ?? []} />)}</div></section>
    <section className="panel"><div className="panel-title"><span>原始日志</span><span className="muted">{logs.length}/1000 行</span></div><div className="log-view">{logs.length === 0 ? <p className="empty">连接串口后，原始帧会显示在这里。</p> : logs.slice(-200).map((entry, index) => <div key={`${entry.at}-${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><b>{entry.role}</b><em>{entry.result}</em><code>{entry.line}</code></div>)}</div></section>
    <section className="panel"><div className="panel-title"><span>自动诊断事件</span><span className="muted">{events.length}/200 条</span></div><div className="event-list">{events.length === 0 ? <p className="empty">尚无派生诊断事件。</p> : events.slice(-100).reverse().map((event, index) => <div className={`event ${event.severity}`} key={`${event.observedAtMs}-${event.kind}-${index}`}><time>{new Date(event.observedAtMs).toLocaleTimeString()}</time><strong>{event.kind}</strong><span>{event.detail}</span></div>)}</div></section>
    {recorder.error && <p className="error">录制：{recorder.error}</p>}
    {recorder.recoverable.length > 0 && <section className="recovery"><strong>可恢复会话</strong>{recorder.recoverable.map((item) => <button className="ghost" key={item.manifest.sessionId} onClick={() => void recorder.downloadRecovered(item.manifest.sessionId)}>{item.manifest.sessionId}（{Math.round(item.totalBytes / 1024)} KiB）</button>)}</section>}
  </main>;
}
