import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReceivedLine } from "../../core/serial";
import { loadReplayFile, ReplayClock, type ReplayClockSnapshot, type ReplayCoordinateSpace, type ReplayRecord } from "../../core/replay";
import {
  contextForSide,
  restoreLocatorFrameFromField,
  type LocatorCoordinateContext,
  type LocatorSide,
} from "../../core/locator";
import { encodeCsvRow } from "../../core/storage";
import { publishFrame, telemetryHub } from "../../core/telemetry";
import { LocatorProtocolAdapter, type LocatorFrame } from "../../protocols";
import { downloadText } from "../../shared/download";
import { RecordIcon } from "../../shared/components/Icons";
import { InfoTip } from "../../shared/components/InfoTip";
import { SerialConnectionBar } from "../../shared/components/SerialConnectionBar";
import { WorkspaceHeader } from "../../shared/components/WorkspaceHeader";
import { numberText } from "../../shared/format";
import { demoLocatorFrame } from "../demo/demoData";
import { RecordingDownloadProgress } from "../recording/RecordingDownloadProgress";
import { useRecorder } from "../recording/useRecorder";
import { usePortSession } from "../serial/usePortSession";
import { FieldMap, type MapTrails } from "./FieldMap";
import type { Point } from "./geometry";
import { displayReplayFrame, replayCoordinateContext } from "./replayDisplay";

const EMPTY_TRAILS: MapTrails = { final: [], calib: [], lidar: [] };
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 5] as const;

function appendPoint(items: LocatorFrame[], frame: LocatorFrame, x: keyof LocatorFrame, y: keyof LocatorFrame, valid = true): LocatorFrame[] {
  if (!valid) return items;
  const last = items.at(-1);
  const dx = Math.abs(Number(frame[x]) - Number(last?.[x] ?? Number.NaN));
  const dy = Math.abs(Number(frame[y]) - Number(last?.[y] ?? Number.NaN));
  if (last && dx + dy < 1) return items;
  return [...items, frame].slice(-5000);
}

function sensorClass(ok: boolean | undefined): string { return ok ? "online" : "offline"; }

export function LocatorWorkspace({ active = true }: { active?: boolean }) {
  const adapter = useMemo(() => new LocatorProtocolAdapter(), []);
  const recorder = useRecorder("locator");
  const [recordingStarting, setRecordingStarting] = useState(false);
  const [side, setSide] = useState<LocatorSide>("red");
  const coordinateContext = useMemo(() => contextForSide(side), [side]);
  const [frame, setFrame] = useState<LocatorFrame | null>(null);
  const [trails, setTrails] = useState<MapTrails>(EMPTY_TRAILS);
  const [logs, setLogs] = useState<string[]>([]);
  const [rawPaused, setRawPaused] = useState(false);
  const [demoActive, setDemoActive] = useState(false);
  const [mouse, setMouse] = useState<Point | null>(null);
  const [replay, setReplay] = useState<ReplayClockSnapshot>({ state: "idle", index: 0, length: 0, speed: 1 });
  const [replayName, setReplayName] = useState("");
  const [replayError, setReplayError] = useState<string | null>(null);
  const clockRef = useRef<ReplayClock | null>(null);
  const replayCoordinateSpaceRef = useRef<ReplayCoordinateSpace>("start-relative");
  const replayContextRef = useRef<LocatorCoordinateContext | null>(null);
  const replayTrackNameRef = useRef("");
  const demoStartedAtRef = useRef(0);
  const frozenLogs = useRef<string[] | null>(null);

  const consumeFrame = useCallback((input: LocatorFrame, record = true, origin: "serial" | "replay" | "demo" = "serial") => {
    const at = Date.now();
    const next = { ...input, observedAtMs: at };
    setFrame(next);
    setTrails((old) => ({
      final: appendPoint(old.final, next, "posXcm", "posYcm"),
      calib: appendPoint(old.calib, next, "calibXcm", "calibYcm"),
      lidar: appendPoint(old.lidar, next, "lidarXcm", "lidarYcm", next.lidarValid),
    }));
    publishFrame("locator", next, origin, at);
    if (origin === "demo") {
      const line = [next.posXcm, next.posYcm, next.posYawDeg, next.lidarXcm, next.lidarYcm, next.lidarYawDeg, next.encoderXcm, next.encoderYcm, next.h30YawDeg, next.dt35_1mm, next.dt35_2mm, next.status].map((value) => Number(value).toFixed(3)).join(",");
      setLogs((old) => [...old, line].slice(-2000));
    }
    if (record && origin !== "demo") void recorder.append("display_frames.csv", encodeCsvRow([at, next.sourceTimeMs, next.seq, next.posXcm, next.posYcm, next.posYawDeg, next.calibXcm, next.calibYcm, next.calibYawDeg, next.lidarXcm, next.lidarYcm, next.lidarYawDeg, next.dt35_1mm, next.dt35_2mm, next.status]));
  }, [recorder]);

  const onSerial = useCallback((received: ReceivedLine<LocatorFrame>) => {
    setLogs((old) => [...old, received.line].slice(-2000));
    void recorder.append("raw_serial.log", `[${Date.now() / 1000}] ${received.line}\n`);
    if (received.outcome.kind === "frame") {
      consumeFrame(received.outcome.frame);
      void recorder.append("raw_frames.csv", encodeCsvRow([Date.now(), received.line]));
    } else if (received.outcome.kind === "error") {
      void recorder.append("events.log", encodeCsvRow([Date.now(), "parse_error", received.outcome.code, received.outcome.detail]));
    }
  }, [consumeFrame, recorder]);

  const stopDemo = useCallback(() => {
    if (!demoActive) return;
    setDemoActive(false);
    if (telemetryHub.activeOrigin("locator") === "demo") {
      telemetryHub.releaseSource("locator", "demo");
      setFrame(null); setTrails(EMPTY_TRAILS);
    }
  }, [demoActive]);
  const stopReplay = useCallback(() => {
    clockRef.current?.stop();
    if (clockRef.current) setReplay(clockRef.current.snapshot);
    telemetryHub.releaseSource("locator", "replay");
  }, []);

  const port = usePortSession<LocatorFrame>("locator", adapter, onSerial, () => {
    stopDemo();
    stopReplay();
    setFrame(null);
    setTrails(EMPTY_TRAILS);
  });
  const wasReading = useRef(false);
  useEffect(() => {
    if (wasReading.current && port.snapshot.lifecycle !== "reading") { setFrame(null); telemetryHub.releaseSource("locator", "serial"); }
    wasReading.current = port.snapshot.lifecycle === "reading";
  }, [port.snapshot.lifecycle]);

  useEffect(() => {
    if (!demoActive) return;
    const tick = () => { const now = Date.now(); consumeFrame(demoLocatorFrame(now, now - demoStartedAtRef.current), false, "demo"); };
    tick();
    const timer = window.setInterval(tick, 50);
    return () => window.clearInterval(timer);
  }, [consumeFrame, demoActive]);

  useEffect(() => {
    if (active) return;
    stopDemo();
    clockRef.current?.pause();
  }, [active, stopDemo]);

  const consumeReplay = useCallback((record: ReplayRecord) => {
    const displayFrame = /display_frames/i.test(replayTrackNameRef.current) ? displayReplayFrame(record, adapter) : null;
    const payload = record.columns?.raw_line ?? record.columns?.column_2 ?? record.payload;
    const outcome = displayFrame ? { kind: "frame" as const, frame: displayFrame } : adapter.parse(payload, record.observedAtMs ?? performance.now());
    if (outcome.kind === "frame") {
      const next = replayCoordinateSpaceRef.current === "field"
        ? restoreLocatorFrameFromField(outcome.frame, replayContextRef.current ?? coordinateContext)
        : outcome.frame;
      consumeFrame(next, false, "replay");
    }
  }, [adapter, consumeFrame, coordinateContext]);

  const openReplay = async (file: File) => {
    try {
      if (recordingStarting || recorder.active || recorder.exporting) throw new Error("录制期间不能加载回放或改变阵营，请先停止并下载当前录制。");
      if (port.snapshot.lifecycle === "reading") throw new Error("请先断开定位串口，再加载回放文件。");
      stopDemo();
      clockRef.current?.stop();
      const bundle = await loadReplayFile(file);
      const selectedTrack = bundle.tracks.find((track) => /raw_serial/i.test(track.name))
        ?? bundle.tracks.find((track) => /raw_frames/i.test(track.name))
        ?? bundle.tracks.find((track) => /display_frames/i.test(track.name))
        ?? bundle.tracks[0];
      if (!selectedTrack) throw new Error("回放包中没有可用的定位数据轨道。");
      if (selectedTrack.coordinateSpace === "unknown") throw new Error("该回放无法确认坐标空间，已拒绝静默猜测。请使用包含 metadata.json 的新会话包或原始串口日志。");
      const metadataRoot = bundle.metadata && typeof bundle.metadata === "object" ? bundle.metadata as Record<string, unknown> : null;
      const recordedContext = replayCoordinateContext(metadataRoot?.locatorCoordinates ?? bundle.metadata)
        ?? replayCoordinateContext(bundle.metadata);
      replayCoordinateSpaceRef.current = selectedTrack.coordinateSpace;
      replayContextRef.current = recordedContext;
      replayTrackNameRef.current = selectedTrack.name;
      if (recordedContext) setSide(recordedContext.side);
      if (selectedTrack.coordinateSpace === "field" && !recordedContext) throw new Error("旧 display_frames.csv 已烘焙场地坐标，但缺少阵营元数据，无法安全反算相对坐标。");
      const records = selectedTrack.records;
      const clock = new ReplayClock(records, { onRecord: consumeReplay, onStateChange: setReplay });
      clockRef.current = clock;
      setReplay(clock.snapshot); setReplayName(file.name); setReplayError(null); setTrails(EMPTY_TRAILS); setFrame(null);
    } catch (reason) { setReplayError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const setSpeed = (speed: number) => { clockRef.current?.setSpeed(speed); if (clockRef.current) setReplay(clockRef.current.snapshot); };
  const playReplay = () => {
    if (port.snapshot.lifecycle === "reading") { setReplayError("请先断开定位串口，再开始回放。"); return; }
    stopDemo(); setReplayError(null); clockRef.current?.play();
  };
  const toggleDemo = () => {
    if (demoActive) { stopDemo(); return; }
    stopReplay(); setFrame(null); setTrails(EMPTY_TRAILS); demoStartedAtRef.current = Date.now(); setDemoActive(true);
  };
  const seek = (index: number) => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.seek(Math.min(index, Math.max(0, replay.length - 1)));
    clock.step();
    setReplay(clock.snapshot);
  };
  const saveMap = () => {
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid='locator-workspace'] .field-canvas");
    canvas?.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `r1-map-${side}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.png`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };
  const exportSnapshot = () => downloadText(`r1-locator-state-${Date.now()}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), frame, mouse, renderContext: coordinateContext, replay }, null, 2), "application/json;charset=utf-8");
  const resetViewData = () => { setTrails(EMPTY_TRAILS); setFrame(null); };
  const serialBusy = port.snapshot.lifecycle === "reading";
  const recordingButtonLabel = recorder.exporting ? "正在生成下载" : recorder.active ? "停止并下载" : "开始本地录制";
  const sideLocked = recordingStarting || recorder.active || recorder.exporting;
  const startRecording = async () => {
    if (sideLocked) return;
    setRecordingStarting(true);
    try { await recorder.start({ locatorCoordinates: coordinateContext }); }
    finally { setRecordingStarting(false); }
  };
  const visibleLogs = rawPaused ? frozenLogs.current ?? logs : logs;
  const toggleRawPause = () => {
    if (rawPaused) frozenLogs.current = null;
    else frozenLogs.current = [...logs];
    setRawPaused((value) => !value);
  };

  return <main className="workspace locator-workspace" data-testid="locator-workspace">
    <WorkspaceHeader kicker="R1 LOCATER MAP" title="定位地图" description="直接使用冻结 Python 上位机的原始场地图与 R1 机器人贴图；支持鼠标锚点缩放、拖拽平移、图层控制、轨迹及 DT35 场地残差悬停。"
      meta={<><span>1215 × 1210 cm</span><span>起点相对坐标</span><span>+Y forward</span><span>30 FPS UI</span></>}
      actions={<><button type="button" className={demoActive ? "selected" : "secondary"} disabled={!demoActive && serialBusy} onClick={toggleDemo}>{demoActive ? "停止演示" : "演示轨迹"}</button><button className="secondary" onClick={saveMap}>导出地图画布</button><button type="button" className={recorder.active ? "danger" : ""} disabled={recorder.exporting || recordingStarting} onClick={() => void (recorder.active ? recorder.stopAndDownload() : startRecording())}><RecordIcon />{recordingStarting ? "正在启动录制" : recordingButtonLabel}</button></>} />

    {!port.supported && <div className="unsupported">当前浏览器不支持 Web Serial。日志回放、地图交互和演示轨迹仍可使用；实时采集请使用桌面版 Chrome/Edge。</div>}
    <RecordingDownloadProgress progress={recorder.downloadProgress} />

    <SerialConnectionBar title="定位板 / Locator" subtitle="USART1 CSV · $R1M" supported={port.supported} snapshot={port.snapshot}
      onSelect={() => { stopDemo(); stopReplay(); setFrame(null); setTrails(EMPTY_TRAILS); void port.select(); }} onConnect={() => { stopDemo(); stopReplay(); setFrame(null); setTrails(EMPTY_TRAILS); void port.connect(); }} onClose={() => { setFrame(null); telemetryHub.releaseSource("locator", "serial"); void port.close(); }} />

    <div className="locator-studio">
      <aside className="locator-side locator-replay-panel">
        <section className="studio-card">
          <header><span>REPLAY</span><strong>日志回放</strong><InfoTip label="定位日志回放说明">支持 raw log、CSV 和本站导出的 ZIP 会话包。播放按日志时间推进，单步只前进一帧，0.25× 至 5× 调整回放时间倍率。实时串口连接期间禁用回放，拖动进度会立即重建当前位置。</InfoTip></header>
          <label className={`file-drop${serialBusy || sideLocked ? " disabled" : ""}`}>选择 raw log / CSV / ZIP<input type="file" accept=".log,.txt,.csv,.zip" disabled={serialBusy || sideLocked} onChange={(event) => { const file = event.target.files?.[0]; if (file) void openReplay(file); }} /></label>
          <p className="file-name" title={replayName}>{replayName || "尚未加载文件"}</p>
          <div className="replay-primary"><button onClick={playReplay} disabled={replay.length === 0 || serialBusy}>播放</button><button className="secondary" onClick={() => clockRef.current?.pause()} disabled={replay.state !== "playing"}>暂停</button><button className="secondary" onClick={() => { stopDemo(); clockRef.current?.step(); }} disabled={replay.length === 0 || serialBusy}>单步</button></div>
          <input className="replay-slider" aria-label="回放进度" type="range" min={0} max={Math.max(0, replay.length - 1)} value={Math.min(replay.index, Math.max(0, replay.length - 1))} disabled={replay.length === 0 || serialBusy} onChange={(event) => seek(Number(event.target.value))} />
          <div className="replay-status"><span>{replay.state}</span><strong>{replay.index.toLocaleString()} / {replay.length.toLocaleString()}</strong></div>
          <div className="speed-grid">{SPEEDS.map((speed) => <button key={speed} className={replay.speed === speed ? "selected" : "secondary"} disabled={serialBusy} onClick={() => setSpeed(speed)}>{speed}×</button>)}</div>
          {replayError && <p className="error">{replayError}</p>}
        </section>

        <section className="studio-card">
          <header><span>DISPLAY</span><strong>视图与数据</strong><InfoTip label="定位视图操作说明">清除三轨迹会清空 Final、Calib、LiDAR 的页面轨迹和当前帧，不删除录制文件。状态 JSON 导出相对定位值，并将场地锚点单独保存到 renderContext；地图画布按钮另行导出当前可见图像。</InfoTip></header>
          <button className="secondary wide" onClick={resetViewData}>清除三轨迹</button>
          <button className="secondary wide" onClick={exportSnapshot}>导出当前状态 JSON</button>
          <p className="studio-hint">地图右上角控制七类图层与跟随。滚轮以鼠标为中心缩放，拖拽平移；跟随开启时每帧自动回中。</p>
        </section>
      </aside>

      <section className="map-stage">
        <div className="map-side-toolbar">
          <div className="side-selector" role="group" aria-label="定位阵营">
            <button type="button" className={side === "red" ? "side-red selected" : "side-red"} aria-pressed={side === "red"} disabled={sideLocked} onClick={() => { setSide("red"); setMouse(null); }}>红方</button>
            <button type="button" className={side === "blue" ? "side-blue selected" : "side-blue"} aria-pressed={side === "blue"} disabled={sideLocked} onClick={() => { setSide("blue"); setMouse(null); }}>蓝方</button>
          </div>
          <span>{sideLocked ? "录制中已锁定阵营" : "双方起点均显示相对 (0,0,0)；切换只改变场地图放置锚点"}</span>
          <InfoTip label="红蓝方相对坐标说明">串口、日志、回放、轨迹、姿态卡和示波器始终使用机器人初始化位置为零点的相对坐标。红蓝按钮只改变机器人与轨迹在固定场地背景上的内部放置锚点，不旋转、不镜像，也不会清空已有轨迹。</InfoTip>
        </div>
        <div className="map-stage-head"><div className="map-series-legend"><span className="final">Final</span><span className="calib">Calib</span><span className="lidar">LiDAR</span><span className="dt-state">DT35 状态色</span><span className="dt-expected">DT35 期望</span><InfoTip label="地图图例与坐标说明">Final、Calib、LiDAR 均显示机器人初始点相对轨迹，单位 cm，+Y 方向在红蓝方保持一致；YAW 不旋转、不镜像。场地背景固定，DT35 几何计算仅在 Canvas 内部使用阵营锚点。</InfoTip></div><span>{mouse ? `相对 X ${mouse.x.toFixed(1)} · Y ${mouse.y.toFixed(1)} cm` : "移动鼠标读取起点相对坐标"}</span></div>
        <FieldMap frame={frame} trails={trails} coordinateContext={coordinateContext} onMousePositionChange={setMouse} />
      </section>

      <aside className="locator-side locator-inspector">
        <section className="studio-card pose-card">
          <header><span>POSE</span><strong>当前定位</strong><InfoTip label="定位姿态字段说明">X/Y/YAW 是协议给出的 Final 融合位姿。Calib 为标定修正坐标，LiDAR 为激光定位坐标，Encoder 为码盘里程计坐标，H30 yaw 为独立航向角。不同来源并列用于判断漂移与融合偏差，不应视为同一测量值。</InfoTip></header>
          <div className="pose-primary"><div><span>X</span><strong>{numberText(frame?.posXcm, 2)}</strong><small>cm</small></div><div><span>Y</span><strong>{numberText(frame?.posYcm, 2)}</strong><small>cm</small></div><div><span>YAW</span><strong>{numberText(frame?.posYawDeg, 2)}</strong><small>deg</small></div></div>
          <dl className="pose-details"><div><dt>协议</dt><dd>{frame?.protocol ?? "—"}</dd></div><div><dt>序号</dt><dd>{frame?.seq ?? "—"}</dd></div><div><dt>Calib</dt><dd>{numberText(frame?.calibXcm, 1)}, {numberText(frame?.calibYcm, 1)}</dd></div><div><dt>LiDAR</dt><dd>{numberText(frame?.lidarXcm, 1)}, {numberText(frame?.lidarYcm, 1)}</dd></div><div><dt>Encoder</dt><dd>{numberText(frame?.encoderXcm, 1)}, {numberText(frame?.encoderYcm, 1)}</dd></div><div><dt>H30 yaw</dt><dd>{numberText(frame?.h30YawDeg, 2)}°</dd></div></dl>
        </section>

        <section className="studio-card">
          <header><span>HEALTH</span><strong>传感器状态</strong><InfoTip label="定位传感器健康说明">H30 有效和 LiDAR 在线来自协议状态位；DT35 显示原始毫米测距及各自有效位，异常值可能来自遮挡、超量程或安装方向；Encoder-1/2 表示本帧是否观察到对应脉冲。状态位有效不代表融合结果一定准确，需结合三轨迹和 DT35 残差判断。</InfoTip></header>
          <div className="sensor-grid">
            <div className={sensorClass(frame?.h30Valid)}><i />H30<strong>{frame?.h30Valid ? "有效" : "无效"}</strong></div>
            <div className={sensorClass(frame?.lidarOnline)}><i />LiDAR<strong>{frame?.lidarOnline ? "在线" : "离线"}</strong></div>
            <div className={sensorClass(frame?.dt35_1Valid)}><i />DT35-1<strong>{numberText(frame?.dt35_1mm, 0)} mm</strong></div>
            <div className={sensorClass(frame?.dt35_2Valid)}><i />DT35-2<strong>{numberText(frame?.dt35_2mm, 0)} mm</strong></div>
            <div className={sensorClass(frame?.xPulseSeen)}><i />Encoder-1<strong>{frame?.xPulseSeen ? "脉冲" : "等待"}</strong></div>
            <div className={sensorClass(frame?.yPulseSeen)}><i />Encoder-2<strong>{frame?.yPulseSeen ? "脉冲" : "等待"}</strong></div>
          </div>
        </section>

        <section className="studio-card raw-preview">
          <header><span>RAW</span><strong>定位原始日志</strong><InfoTip label="定位原始日志说明">窗口最多保留 2000 行并只展示最后 80 行。暂停滚动只冻结可见快照，后台串口解析与录制继续；清空只清理页面日志。“保存”下载当前可见日志，不等同于停止录制后生成的完整会话包。</InfoTip><small>{visibleLogs.length}/2000{rawPaused ? ` · 后台 ${logs.length}` : ""}</small></header>
          <div className="raw-actions"><button className={rawPaused ? "selected" : "secondary"} onClick={toggleRawPause}>{rawPaused ? "继续滚动" : "暂停滚动"}</button><button className="secondary" onClick={() => { frozenLogs.current = null; setRawPaused(false); setLogs([]); }}>清空</button><button className="secondary" onClick={() => downloadText(`locator-visible-${Date.now()}.log`, visibleLogs.join("\n"))}>保存</button></div>
          <pre>{visibleLogs.length ? visibleLogs.slice(-80).join("\n") : "等待串口或演示数据…"}</pre>
        </section>
      </aside>
    </div>

    {recorder.error && <p className="error">录制：{recorder.error}</p>}
    {recorder.recoverable.length > 0 && <section className="recovery"><strong>可恢复会话</strong>{recorder.recoverable.map((item) => <button className="secondary" key={item.manifest.sessionId} disabled={recorder.exporting} onClick={() => void recorder.downloadRecovered(item.manifest.sessionId)}>{item.manifest.sessionId}（{Math.round(item.totalBytes / 1024)} KiB）</button>)}</section>}
  </main>;
}
