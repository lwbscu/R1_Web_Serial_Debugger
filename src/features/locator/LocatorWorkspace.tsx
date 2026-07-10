import { useCallback, useMemo, useRef, useState } from "react";
import type { ReceivedLine } from "../../core/serial";
import { loadReplayFile, ReplayClock, type ReplayClockSnapshot, type ReplayRecord } from "../../core/replay";
import { LocatorProtocolAdapter, type LocatorFrame } from "../../protocols";
import { encodeCsvRow } from "../../core/storage";
import { numberText } from "../../shared/format";
import { useRecorder } from "../recording/useRecorder";
import { usePortSession } from "../serial/usePortSession";
import { FieldMap, type MapTrails } from "./FieldMap";

const EMPTY_TRAILS: MapTrails = { final: [], calib: [], lidar: [] };
const SPEEDS = [0.25, 0.5, 1, 2, 5] as const;

function appendPoint(items: LocatorFrame[], frame: LocatorFrame, x: keyof LocatorFrame, y: keyof LocatorFrame): LocatorFrame[] {
  const last = items.at(-1);
  const dx = Number(frame[x]) - Number(last?.[x] ?? Number.NaN);
  const dy = Number(frame[y]) - Number(last?.[y] ?? Number.NaN);
  if (last && Math.hypot(dx, dy) < 1) return items;
  return [...items, frame].slice(-5000);
}

export function LocatorWorkspace() {
  const adapter = useMemo(() => new LocatorProtocolAdapter(), []);
  const recorder = useRecorder("locator");
  const [frame, setFrame] = useState<LocatorFrame | null>(null);
  const [trails, setTrails] = useState<MapTrails>(EMPTY_TRAILS);
  const [logs, setLogs] = useState<string[]>([]);
  const [replay, setReplay] = useState<ReplayClockSnapshot>({ state: "idle", index: 0, length: 0, speed: 1 });
  const [replayName, setReplayName] = useState("");
  const [replayError, setReplayError] = useState<string | null>(null);
  const clockRef = useRef<ReplayClock | null>(null);
  const consumeFrame = useCallback((next: LocatorFrame, record = true) => {
    setFrame(next);
    setTrails((old) => ({
      final: appendPoint(old.final, next, "posXcm", "posYcm"),
      calib: appendPoint(old.calib, next, "calibXcm", "calibYcm"),
      lidar: appendPoint(old.lidar, next, "lidarXcm", "lidarYcm"),
    }));
    if (record) void recorder.append("display_frames.csv", encodeCsvRow([Date.now(), next.sourceTimeMs, next.seq, next.posXcm, next.posYcm, next.posYawDeg, next.calibXcm, next.calibYcm, next.calibYawDeg, next.lidarXcm, next.lidarYcm, next.lidarYawDeg, next.dt35_1mm, next.dt35_2mm, next.status]));
  }, [recorder]);
  const onSerial = useCallback((received: ReceivedLine<LocatorFrame>) => {
    setLogs((old) => [...old, received.line].slice(-1000));
    void recorder.append("raw_serial.log", `[${Date.now() / 1000}] ${received.line}\n`);
    if (received.outcome.kind === "frame") {
      consumeFrame(received.outcome.frame);
      void recorder.append("raw_frames.csv", encodeCsvRow([Date.now(), received.line]));
    } else if (received.outcome.kind === "error") {
      void recorder.append("events.log", encodeCsvRow([Date.now(), "parse_error", received.outcome.code, received.outcome.detail]));
    }
  }, [consumeFrame, recorder]);
  const port = usePortSession<LocatorFrame>("locator", adapter, onSerial);
  const consumeReplay = useCallback((record: ReplayRecord) => {
    const payload = record.columns?.raw_line ?? record.columns?.column_2 ?? record.payload;
    const outcome = adapter.parse(payload, record.observedAtMs ?? performance.now());
    if (outcome.kind === "frame") consumeFrame(outcome.frame, false);
  }, [adapter, consumeFrame]);
  const openReplay = async (file: File) => {
    try {
      clockRef.current?.stop();
      const bundle = await loadReplayFile(file);
      const records = bundle.tracks.find((track) => /raw_serial|raw_frames|display_frames/i.test(track.name))?.records ?? bundle.tracks[0]?.records ?? [];
      const clock = new ReplayClock(records, { onRecord: consumeReplay, onStateChange: setReplay });
      clockRef.current = clock; setReplay(clock.snapshot); setReplayName(file.name); setReplayError(null); setTrails(EMPTY_TRAILS); setFrame(null);
    } catch (reason) { setReplayError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const setSpeed = (speed: number) => { clockRef.current?.setSpeed(speed); if (clockRef.current) setReplay(clockRef.current.snapshot); };
  return <main className="workspace" data-testid="locator-workspace">
    <header className="workspace-head"><div><p className="eyebrow">R1 LOCATER MAP</p><h2>定位地图</h2><p>实时串口与文件回放复用同一解析和绘图管线；Final 显示冻结基线协议提供的原始融合结果。</p></div><div className="toolbar"><button className={recorder.active ? "danger" : ""} onClick={() => void (recorder.active ? recorder.stopAndDownload() : recorder.start())}>{recorder.active ? "停止并下载" : "开始本地录制"}</button></div></header>
    {!port.supported && <div className="unsupported">当前浏览器不支持 Web Serial。仍可使用日志回放；实时采集请用桌面版 Chrome/Edge。</div>}
    <div className="locator-layout"><section className="panel locator-controls">
      <div className="panel-title"><span><span className={`status-dot ${port.snapshot.health}`} />定位板串口</span><span className="badge">{port.snapshot.lifecycle} / {port.snapshot.health}</span></div>
      <div className="toolbar"><button onClick={() => void port.select()} disabled={!port.supported || port.snapshot.lifecycle === "reading"}>选择串口</button><button onClick={() => void port.connect()} disabled={!port.snapshot.selected || port.snapshot.lifecycle === "reading"}>连接</button><button className="ghost" onClick={() => void port.close()} disabled={port.snapshot.lifecycle !== "reading"}>断开</button></div>
      {port.snapshot.health === "wrong-role" && <p className="warning">检测到 {port.snapshot.detectedRole} 数据，请重选定位板端口。</p>}
      {port.snapshot.error && <p className="error">{port.snapshot.error}</p>}
      <h3>当前定位</h3><div className="coordinate"><strong>{numberText(frame?.posXcm)}<small> cm X</small></strong><strong>{numberText(frame?.posYcm)}<small> cm Y</small></strong><strong>{numberText(frame?.posYawDeg)}<small>° Yaw</small></strong></div>
      <dl className="status-list"><div><dt>协议</dt><dd>{frame?.protocol ?? "—"}</dd></div><div><dt>序号</dt><dd>{frame?.seq ?? "—"}</dd></div><div><dt>H30</dt><dd>{frame?.h30Valid ? "有效" : "无效"}</dd></div><div><dt>LiDAR</dt><dd>{frame?.lidarValid ? "有效" : "无效"}</dd></div><div><dt>DT35-1</dt><dd>{numberText(frame?.dt35_1mm, 0)} mm</dd></div><div><dt>DT35-2</dt><dd>{numberText(frame?.dt35_2mm, 0)} mm</dd></div></dl>
      <h3>日志回放</h3><label className="file-button">打开 raw log / CSV / ZIP<input type="file" accept=".log,.txt,.csv,.zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void openReplay(file); }} /></label>
      {replayName && <p className="muted ellipsis" title={replayName}>{replayName}</p>}
      <div className="toolbar"><button onClick={() => clockRef.current?.play()} disabled={replay.length === 0}>播放</button><button className="ghost" onClick={() => clockRef.current?.pause()} disabled={replay.state !== "playing"}>暂停</button><button className="ghost" onClick={() => clockRef.current?.step()} disabled={replay.length === 0}>单步</button></div>
      <div className="speed-row">{SPEEDS.map((speed) => <button key={speed} className={replay.speed === speed ? "selected" : "ghost"} onClick={() => setSpeed(speed)}>{speed}×</button>)}</div>
      <p className="muted">{replay.state} · {replay.index}/{replay.length}</p>
      <button className="ghost wide" onClick={() => { setTrails(EMPTY_TRAILS); setFrame(null); }}>清除轨迹</button>
      {replayError && <p className="error">{replayError}</p>}
    </section>
    <section className="panel map-panel"><div className="map-legend"><span className="final">Final</span><span className="calib">Calib</span><span className="lidar">LiDAR</span><span className="dt-one">DT35-1</span><span className="dt-two">DT35-2</span></div><FieldMap frame={frame} trails={trails} /></section></div>
    <section className="panel"><div className="panel-title"><span>定位原始日志</span><span className="muted">{logs.length}/1000 行</span></div><div className="log-view compact">{logs.slice(-100).map((line, index) => <div key={`${index}-${line.slice(0, 12)}`}><code>{line}</code></div>)}</div></section>
    {recorder.error && <p className="error">录制：{recorder.error}</p>}
    {recorder.recoverable.length > 0 && <section className="recovery"><strong>可恢复会话</strong>{recorder.recoverable.map((item) => <button className="ghost" key={item.manifest.sessionId} onClick={() => void recorder.downloadRecovered(item.manifest.sessionId)}>{item.manifest.sessionId}（{Math.round(item.totalBytes / 1024)} KiB）</button>)}</section>}
  </main>;
}
