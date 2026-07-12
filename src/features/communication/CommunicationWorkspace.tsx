import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReceivedLine } from "../../core/serial";
import { encodeCsvRow } from "../../core/storage";
import { publishFrame, telemetryHub } from "../../core/telemetry";
import { ChassisProtocolAdapter, parseRdbgTx, RemoteProtocolAdapter, type ChassisFrame, type RemoteFrame, type RemoteTxEvent } from "../../protocols";
import { downloadText } from "../../shared/download";
import { InfoTip } from "../../shared/components/InfoTip";
import { SerialConnectionBar } from "../../shared/components/SerialConnectionBar";
import { WorkspaceHeader } from "../../shared/components/WorkspaceHeader";
import { demoChassisFrame, demoRemoteFrame, demoRemoteTxEvent } from "../demo/demoData";
import type { RecorderController } from "../recording/useRecorder";
import { usePortSession } from "../serial/usePortSession";
import { requestOpenSerialDiscovery } from "../serial/discoveryDialogStore";
import { MetricPanel } from "./components";
import { diagnoseLink, freshMetricContext } from "./diagnosis";
import { DiagnosticEventDetector, firmwareEventSeverity, type DiagnosticEvent } from "./eventDetector";
import {
  chassisNrfMetricSpecs, locationMetricSpecs, mechanismMetricSpecs, modeSyncMetricSpecs,
  panelStatus, remoteMetricSpecs, STATUS_LABELS, wirelessReceiveMetricSpecs,
  type MetricContext, type MetricSpec,
} from "./metrics";
import { generateHtmlDiagnosticReport, generateMarkdownDiagnosticReport, type DiagnosticReportMetric } from "./reports";
import { remoteDebugStore } from "../remoteControl/remoteDebugStore";

interface LogEntry { at: number; role: "remote" | "chassis"; line: string; result: string }
interface StructuredRow { at: number; role: "remote" | "chassis"; seq: number | string; summary: string }
type DataTab = "raw" | "frames" | "events";

function reportMetrics(panel: string, specs: readonly MetricSpec[], context: MetricContext): DiagnosticReportMetric[] {
  return specs.map((spec) => {
    const value = spec.getter(context);
    return { panel, title: spec.title, variable: spec.variable, value: spec.formatter(value), status: spec.evaluator?.(value, context) ?? "unknown" };
  });
}

function timestampName(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

function displayTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(at);
}

export function CommunicationWorkspace({ active = true, recorder }: { active?: boolean; recorder: RecorderController }) {
  const remoteAdapter = useMemo(() => new RemoteProtocolAdapter(), []);
  const chassisAdapter = useMemo(() => new ChassisProtocolAdapter(), []);
  const [remote, setRemote] = useState<RemoteFrame | null>(null);
  const [chassis, setChassis] = useState<ChassisFrame | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [frames, setFrames] = useState<StructuredRow[]>([]);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [activeTab, setActiveTab] = useState<DataTab>("raw");
  const [streamPaused, setStreamPaused] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const detector = useRef(new DiagnosticEventDetector());
  const frozenConsole = useRef<{ logs: LogEntry[]; frames: StructuredRow[]; events: DiagnosticEvent[] } | null>(null);

  const appendEvents = useCallback((items: DiagnosticEvent[]) => {
    if (items.length === 0) return;
    setEvents((old) => [...old, ...items].slice(-500));
    items.forEach((event) => void recorder.append("events.csv", encodeCsvRow([event.observedAtMs, event.kind, event.severity, event.detail])));
  }, [recorder]);

  const acceptRemote = useCallback((input: RemoteFrame, origin: "serial" | "demo" = "serial") => {
    const at = Date.now();
    const value: RemoteFrame = { ...input, observedAtMs: at };
    setRemote(value);
    remoteDebugStore.publishRemote(value);
    publishFrame("remote", value, origin, at);
    appendEvents(detector.current.acceptRemote(value));
    if (origin === "demo") {
      const log: LogEntry = { at, role: "remote", line: value.rawLine, result: "demo" };
      setLogs((old) => [...old, log].slice(-2000));
    }
    const row: StructuredRow = { at, role: "remote", seq: value.seq, summary: `${value.packetType} · CH ${value.rfCh} · ${value.signalBars} 格 · noACK ${value.noAckMs} ms` };
    setFrames((old) => [...old, row].slice(-2000));
    if (origin !== "demo") void recorder.append("remote_rdbg.csv", encodeCsvRow([at, value.rawLine]));
  }, [appendEvents, recorder]);

  const acceptRemoteTx = useCallback((input: RemoteTxEvent, origin: "serial" | "demo" = "serial") => {
    const at = Date.now();
    const value: RemoteTxEvent = { ...input, observedAtMs: at };
    remoteDebugStore.publishTx(value);
    const row: StructuredRow = { at, role: "remote", seq: value.seq, summary: `RDBG_TX ${value.packetType} · ${value.txLen}B · ret ${value.txRet} · ACK ${value.ackLen}B` };
    setFrames((old) => [...old, row].slice(-2000));
    if (origin !== "demo") void recorder.append("remote_rdbg_tx.csv", encodeCsvRow([at, value.rawLine]));
  }, [recorder]);

  const acceptChassis = useCallback((input: ChassisFrame, origin: "serial" | "demo" = "serial") => {
    const at = Date.now();
    const value: ChassisFrame = { ...input, observedAtMs: at };
    setChassis(value);
    remoteDebugStore.publishChassis(value);
    publishFrame("chassis", value, origin, at);
    appendEvents(detector.current.acceptChassis(value));
    if (origin === "demo") {
      const log: LogEntry = { at, role: "chassis", line: value.rawLine, result: "demo" };
      setLogs((old) => [...old, log].slice(-2000));
    }
    const row: StructuredRow = { at, role: "chassis", seq: String(value.seq ?? "—"), summary: `CDBG v${value.protocolVersion}/${value.fieldCount} · CH ${String(value.nrfCh ?? "—")} · ACK ${String(value.ackScore ?? "—")} · pose ${Number(value.posX ?? 0).toFixed(1)}, ${Number(value.posY ?? 0).toFixed(1)}` };
    setFrames((old) => [...old, row].slice(-2000));
    if (origin !== "demo") void recorder.append("chassis_cdbg.csv", encodeCsvRow([at, value.rawLine]));
  }, [appendEvents, recorder]);

  const handle = (role: "remote" | "chassis") => (received: ReceivedLine<RemoteFrame | ChassisFrame>) => {
    const at = Date.now();
    setLogs((old) => [...old, { at, role, line: received.line, result: received.outcome.kind }].slice(-2000));
    remoteDebugStore.publishLog({ at, role, line: received.line, result: received.outcome.kind });
    void recorder.append(role === "remote" ? "remote_raw.log" : "chassis_raw.log", `${at},${received.line}\n`);
    if (received.outcome.kind === "frame") {
      if (role === "remote") acceptRemote(received.outcome.frame as RemoteFrame);
      else acceptChassis(received.outcome.frame as ChassisFrame);
      return;
    }
    if (received.outcome.kind === "event") {
      const firmwareKind = received.outcome.event.eventKind;
      if (role === "remote" && firmwareKind === "RDBG_TX") {
        const parsed = parseRdbgTx(received.outcome.event.rawLine, at);
        if (parsed.kind === "frame") acceptRemoteTx(parsed.frame);
        else if (parsed.kind === "error") {
          const event: DiagnosticEvent = { observedAtMs: at, kind: "PARSE_ERROR", severity: "warn", detail: `remote: ${parsed.code} — ${parsed.detail}` };
          remoteDebugStore.publishParseError(event);
          appendEvents([event]);
        }
        return;
      }
      const displayKind = received.outcome.event.rawLine.startsWith("CEVT,") ? `CEVT_${firmwareKind}` : firmwareKind;
      const event: DiagnosticEvent = { observedAtMs: at, kind: displayKind, severity: firmwareEventSeverity(firmwareKind), detail: received.outcome.event.fields.map(String).join(", ") || received.outcome.event.rawLine };
      remoteDebugStore.publishFirmwareEvent(event);
      appendEvents([event]);
      return;
    }
    if (received.outcome.kind === "error") {
      const event: DiagnosticEvent = { observedAtMs: at, kind: "PARSE_ERROR", severity: "warn", detail: `${role}: ${received.outcome.code} — ${received.outcome.detail}` };
      remoteDebugStore.publishParseError(event);
      appendEvents([event]);
    }
  };

  const stopDemo = useCallback(() => {
    if (!demoActive) return;
    setDemoActive(false);
    detector.current.reset();
    setRemote(null); setChassis(null);
    remoteDebugStore.clear();
    telemetryHub.releaseSource("remote", "demo");
    telemetryHub.releaseSource("chassis", "demo");
  }, [demoActive]);

  const resetRemote = useCallback(() => {
    detector.current.resetSource("remote");
    setRemote(null);
    remoteDebugStore.clearRemote();
    telemetryHub.releaseSource("remote", "serial");
  }, []);

  const resetChassis = useCallback(() => {
    detector.current.resetSource("chassis");
    setChassis(null);
    remoteDebugStore.clearChassis();
    telemetryHub.releaseSource("chassis", "serial");
  }, []);

  const remotePort = usePortSession<RemoteFrame>("remote", remoteAdapter, handle("remote"), () => {
    stopDemo();
    resetRemote();
  });
  const chassisPort = usePortSession<ChassisFrame>("chassis", chassisAdapter, handle("chassis"), () => {
    stopDemo();
    resetChassis();
  });
  const { supported: remoteSupported, snapshot: remoteSnapshot } = remotePort;
  const { supported: chassisSupported, snapshot: chassisSnapshot } = chassisPort;
  const { connect: connectRemotePort, close: closeRemotePort } = remotePort;
  const { connect: connectChassisPort, close: closeChassisPort } = chassisPort;
  const remoteWasReading = useRef(false);
  const chassisWasReading = useRef(false);

  useEffect(() => {
    remoteDebugStore.publishPort("remote", remoteSupported, remoteSnapshot);
  }, [remoteSnapshot, remoteSupported]);

  useEffect(() => {
    remoteDebugStore.publishPort("chassis", chassisSupported, chassisSnapshot);
  }, [chassisSnapshot, chassisSupported]);

  useEffect(() => remoteDebugStore.registerPortActions("remote", {
    select: async () => { stopDemo(); resetRemote(); requestOpenSerialDiscovery(); },
    connect: async () => { stopDemo(); await connectRemotePort(); },
    close: async () => { resetRemote(); await closeRemotePort(); },
  }), [connectRemotePort, closeRemotePort, resetRemote, stopDemo]);

  useEffect(() => remoteDebugStore.registerPortActions("chassis", {
    select: async () => { stopDemo(); resetChassis(); requestOpenSerialDiscovery(); },
    connect: async () => { stopDemo(); await connectChassisPort(); },
    close: async () => { resetChassis(); await closeChassisPort(); },
  }), [connectChassisPort, closeChassisPort, resetChassis, stopDemo]);

  useEffect(() => {
    if (remoteWasReading.current && remotePort.snapshot.lifecycle !== "reading") {
      detector.current.resetSource("remote"); setRemote(null); telemetryHub.releaseSource("remote", "serial");
      remoteDebugStore.clearRemote();
    }
    remoteWasReading.current = remotePort.snapshot.lifecycle === "reading";
  }, [remotePort.snapshot.lifecycle]);
  useEffect(() => {
    if (chassisWasReading.current && chassisPort.snapshot.lifecycle !== "reading") {
      detector.current.resetSource("chassis"); setChassis(null); telemetryHub.releaseSource("chassis", "serial");
      remoteDebugStore.clearChassis();
    }
    chassisWasReading.current = chassisPort.snapshot.lifecycle === "reading";
  }, [chassisPort.snapshot.lifecycle]);

  useEffect(() => {
    if (!demoActive) return;
    const tick = () => { const at = Date.now(); acceptRemote(demoRemoteFrame(at), "demo"); acceptRemoteTx(demoRemoteTxEvent(at), "demo"); acceptChassis(demoChassisFrame(at), "demo"); };
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [acceptChassis, acceptRemote, acceptRemoteTx, demoActive]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => { if (!active) stopDemo(); }, [active, stopDemo]);

  const context: MetricContext = freshMetricContext({ remote, chassis }, clockNow);
  const diagnosis = diagnoseLink(context);
  const exportReport = (format: "md" | "html") => {
    const input = {
      title: "R1 双串口通信诊断报告", generatedAtMs: Date.now(), diagnosis,
      metrics: [
        ...reportMetrics("遥控器链路", remoteMetricSpecs, context),
        ...reportMetrics("底盘 NRF 概览", chassisNrfMetricSpecs, context),
        ...reportMetrics("无线接收", wirelessReceiveMetricSpecs, context),
        ...reportMetrics("模式同步", modeSyncMetricSpecs, context),
        ...reportMetrics("机构链路", mechanismMetricSpecs, context),
        ...reportMetrics("定位输入", locationMetricSpecs, context),
      ],
      events,
    };
    const name = `r1-link-report-${timestampName()}.${format}`;
    if (format === "md") downloadText(name, generateMarkdownDiagnosticReport(input), "text/markdown;charset=utf-8");
    else downloadText(name, generateHtmlDiagnosticReport(input), "text/html;charset=utf-8");
  };
  const serialBusy = remotePort.snapshot.lifecycle === "reading" || chassisPort.snapshot.lifecycle === "reading";
  const shownLogs = streamPaused ? frozenConsole.current?.logs ?? logs : logs;
  const shownFrames = streamPaused ? frozenConsole.current?.frames ?? frames : frames;
  const shownEvents = streamPaused ? frozenConsole.current?.events ?? events : events;
  const toggleConsolePause = () => {
    if (streamPaused) frozenConsole.current = null;
    else frozenConsole.current = { logs: [...logs], frames: [...frames], events: [...events] };
    setStreamPaused((value) => !value);
  };

  return <main className="workspace communication-workspace" data-testid="communication-workspace">
    <WorkspaceHeader kicker="R1 LINK DIAGNOSTICS" title="双串口通信诊断" description="严格对拍本地 Python 上位机：端口健康与业务诊断分层显示，悬停任一指标可查看阈值、异常判断和排查路径。"
      meta={<><span>RDBG 18 fields</span><span>CDBG 30 / 35 / 72 / 90 / v3-151 fields</span><span>stale 1.5 s</span></>}
      actions={<><button type="button" className={demoActive ? "selected" : "secondary"} disabled={!demoActive && serialBusy} onClick={() => demoActive ? stopDemo() : setDemoActive(true)}>{demoActive ? "停止演示" : "演示数据"}</button><button type="button" className="secondary" onClick={requestOpenSerialDiscovery}>智能连接串口</button><InfoTip label="统一录制说明">三串口统一录制按钮在左侧“三串口连接中心”。录制会同时包含遥控器、底盘和码盘/定位板；未连接角色写入 not_connected，后续接入会自动续录。</InfoTip></>} />

    {!remotePort.supported && <div className="unsupported">实时串口需要桌面版 Chrome/Edge 和 HTTPS。当前仍可使用演示数据查看完整诊断界面。</div>}

    <div className="connection-stack">
      <SerialConnectionBar title="遥控器 / RDBG" subtitle="Remote USART1" supported={remotePort.supported} snapshot={remotePort.snapshot}
        selectLabel="智能识别" onSelect={requestOpenSerialDiscovery} onAdvancedSelect={() => { stopDemo(); resetRemote(); void remotePort.select(); }} onConnect={() => { stopDemo(); void remotePort.connect(); }} onClose={() => { resetRemote(); void remotePort.close(); }} />
      <SerialConnectionBar title="底盘 / CDBG" subtitle="Chassis USART2" supported={chassisPort.supported} snapshot={chassisPort.snapshot}
        selectLabel="智能识别" onSelect={requestOpenSerialDiscovery} onAdvancedSelect={() => { stopDemo(); resetChassis(); void chassisPort.select(); }} onConnect={() => { stopDemo(); void chassisPort.connect(); }} onClose={() => { resetChassis(); void chassisPort.close(); }} />
    </div>

    <section className={`diagnosis-banner diagnosis-${diagnosis.status}`}>
      <div><span>综合诊断</span><strong>{STATUS_LABELS[diagnosis.status]}</strong></div>
      <p>{diagnosis.text}</p>
    </section>

    <div className="diagnostic-grid">
      <MetricPanel title="遥控器链路" subtitle="发包、ACK、信号格与 X 原因" specs={remoteMetricSpecs} context={context} status={panelStatus.remote(context)} initiallyVisible={6} />
      <MetricPanel title="底盘 NRF 概览" subtitle="锁频、收包、摇杆与控制来源" specs={chassisNrfMetricSpecs} context={context} status={panelStatus.chassis(context)} initiallyVisible={8} />
      <MetricPanel title="无线接收" subtitle="帧分类、任务 heartbeat、SPI 与寄存器" specs={wirelessReceiveMetricSpecs} context={context} status={panelStatus.wireless(context)} initiallyVisible={8} />
      <MetricPanel title="模式同步" subtitle="遥控模式、实际状态与状态队列" specs={modeSyncMetricSpecs} context={context} status={panelStatus.mode(context)} initiallyVisible={4} />
      <MetricPanel title="机构链路" subtitle="ACT 队列、USART1 发送与机构反馈" specs={mechanismMetricSpecs} context={context} status={panelStatus.mechanism(context)} initiallyVisible={5} />
      <MetricPanel title="定位输入" subtitle="定位板、传感器、电机与 CAN" specs={locationMetricSpecs} context={context} status={panelStatus.location(context)} initiallyVisible={8} />
    </div>

    <section className="panel data-console">
      <div className="console-toolbar">
        <div className="data-tabs" role="tablist" aria-label="诊断数据">
          <button role="tab" aria-selected={activeTab === "raw"} className={activeTab === "raw" ? "active" : ""} onClick={() => setActiveTab("raw")}>原始日志 <small>{shownLogs.length}</small></button>
          <button role="tab" aria-selected={activeTab === "frames"} className={activeTab === "frames" ? "active" : ""} onClick={() => setActiveTab("frames")}>结构化帧 <small>{shownFrames.length}</small></button>
          <button role="tab" aria-selected={activeTab === "events"} className={activeTab === "events" ? "active" : ""} onClick={() => setActiveTab("events")}>事件 <small>{shownEvents.length}</small></button>
        </div>
        <InfoTip label="通信事件说明">事件包含网页诊断事件与固件上报事件。v3 固件边沿为 NRF_LINK、NRF_REG、MODE_SYNC、MECH_CMD、MECH_TX、MECH_FB、UART1_ERR；COUNTER_GROWTH 表示累计错误刚刚增长，MODE_MISMATCH 表示遥控实时模式与底盘实际模式当前不一致。PARSE_ERROR 表示收到但未通过严格协议解析。warn/error 应结合时间邻近的原始帧和指标排查。</InfoTip>
        <div className="toolbar"><button className={streamPaused ? "selected" : "secondary"} onClick={toggleConsolePause}>{streamPaused ? "继续滚动" : "暂停滚动"}</button><button className="secondary" onClick={() => { frozenConsole.current = null; setStreamPaused(false); setLogs([]); setFrames([]); setEvents([]); }}>清空界面</button><button className="secondary" onClick={() => exportReport("md")}>导出 MD</button><button className="secondary" onClick={() => exportReport("html")}>导出 HTML</button><InfoTip label="暂停、清空与报告说明">暂停只冻结当前控制台快照，串口接收、指标更新和本地录制继续运行；清空只删除页面内存中的日志、帧和事件。MD/HTML 报告导出的是当前诊断指标与事件摘要，不等同于包含完整原始数据的录制包。</InfoTip></div>
      </div>

      {activeTab === "raw" && <div className="console-table raw-console" role="tabpanel">{shownLogs.length === 0 ? <p className="empty">选择串口或启用演示数据后，完整原始帧会显示在这里。</p> : shownLogs.slice(-500).map((entry, index) => <div className="raw-row" key={`${entry.at}-${index}`}><time>{displayTime(entry.at)}</time><b data-role={entry.role}>{entry.role}</b><em>{entry.result}</em><code title={entry.line}>{entry.line}</code></div>)}</div>}
      {activeTab === "frames" && <div className="structured-table" role="tabpanel"><div className="table-head"><span>PC time</span><span>source</span><span>seq</span><span>summary</span></div>{shownFrames.length === 0 ? <p className="empty">尚无结构化帧。</p> : shownFrames.slice(-500).reverse().map((row, index) => <div className="table-row" key={`${row.at}-${index}`}><time>{displayTime(row.at)}</time><b>{row.role}</b><code>{row.seq}</code><span>{row.summary}</span></div>)}</div>}
      {activeTab === "events" && <div className="event-list console-events" role="tabpanel">{shownEvents.length === 0 ? <p className="empty">尚无诊断或固件事件。</p> : shownEvents.slice(-300).reverse().map((event, index) => <div className={`event ${event.severity}`} key={`${event.observedAtMs}-${event.kind}-${index}`}><time>{new Date(event.observedAtMs).toLocaleTimeString()}</time><strong>{event.kind}</strong><span>{event.detail}</span></div>)}</div>}
    </section>

  </main>;
}
