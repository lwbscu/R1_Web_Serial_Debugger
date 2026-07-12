import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { publishFrame, telemetryHub, type SeriesId, type TelemetrySource, type TelemetrySnapshot, type WaveWindowSeconds, type YScaleMode } from "../../core/telemetry";
import { UPlotWaveform } from "../../shared/components/UPlotWaveform";
import { WorkspaceHeader } from "../../shared/components/WorkspaceHeader";
import { demoChassisFrame, demoLocatorFrame, demoRemoteFrame } from "../demo/demoData";
import {
  centeredZoomLevelToRatio,
  describeSeries,
  zoomedXSpanSeconds,
  zoomLevelToRatio,
  type PlotSeriesInput,
} from "./data";
import "./WaveformControls.css";

const WINDOWS: ReadonlyArray<readonly [WaveWindowSeconds, string]> = [[10, "10 秒"], [30, "30 秒"], [60, "1 分钟"], [300, "5 分钟"], [600, "10 分钟"], [1800, "30 分钟"]];
const SOURCES: ReadonlyArray<{ id: TelemetrySource; label: string; detail: string }> = [
  { id: "remote", label: "遥控器", detail: "RDBG" },
  { id: "chassis", label: "底盘", detail: "CDBG" },
  { id: "locator", label: "定位板", detail: "CSV / R1M" },
];
const PRESETS: ReadonlyArray<{ label: string; fields: SeriesId[] }> = [
  { label: "链路质量", fields: ["remote:signalBars", "remote:noAckMs", "remote:failCount", "chassis:ackScore", "chassis:packetLossRate"] },
  { label: "双端信道", fields: ["remote:rfCh", "chassis:nrfCh"] },
  { label: "定位 XY", fields: ["locator:posXcm", "locator:posYcm", "locator:lidarXcm", "locator:lidarYcm"] },
  { label: "姿态角", fields: ["locator:posYawDeg", "locator:h30YawDeg", "locator:lidarYawDeg"] },
  { label: "DT35", fields: ["locator:dt35_1mm", "locator:dt35_2mm"] },
  { label: "四轮驱动", fields: ["chassis:drvCmd1", "chassis:drvFb1", "chassis:drvCmd2", "chassis:drvFb2", "chassis:drvCmd3", "chassis:drvFb3", "chassis:drvCmd4", "chassis:drvFb4"] },
  { label: "舵向闭环", fields: ["chassis:steerCmd1", "chassis:steerFb1", "chassis:steerErr1", "chassis:steerCmd2", "chassis:steerFb2", "chassis:steerErr2", "chassis:steerCmd3", "chassis:steerFb3", "chassis:steerErr3", "chassis:steerCmd4", "chassis:steerFb4", "chassis:steerErr4"] },
  { label: "八电机输出", fields: ["chassis:drvPidOut1", "chassis:drvPidOut2", "chassis:drvPidOut3", "chassis:drvPidOut4", "chassis:steerPidOut1", "chassis:steerPidOut2", "chassis:steerPidOut3", "chassis:steerPidOut4"] },
  { label: "走点闭环", fields: ["chassis:pointDistanceM", "chassis:pointYawErrorDeg", "chassis:pointPidOut", "chassis:pointSpeedOutput"] },
  { label: "舵向级联", fields: ["chassis:steerErr1", "chassis:steerPosPidOut1", "chassis:steerPidOut1", "chassis:steerRotorSpeedRpm1", "chassis:steerErr2", "chassis:steerPosPidOut2", "chassis:steerPidOut2", "chassis:steerRotorSpeedRpm2"] },
  { label: "DGM 恢复", fields: ["chassis:dgmRecoverCount1", "chassis:dgmRecoverCount2", "chassis:dgmRecoverCount3", "chassis:dgmRecoverCount4"] },
];

function formatTimeSpan(seconds: number): string {
  if (seconds < .001) return `${Number((seconds * 1_000_000).toPrecision(4))} μs`;
  if (seconds < 1) return `${Number((seconds * 1000).toPrecision(4))} ms`;
  if (seconds < 60) return `${Number(seconds.toPrecision(4))} s`;
  return `${Number((seconds / 60).toPrecision(4))} min`;
}

function formatZoomRatio(ratio: number): string {
  if (Math.abs(ratio - 1) < 1e-9) return "基础量程";
  if (ratio > 1) return `放大 ${Number(ratio.toPrecision(4))}×`;
  return `缩小 ${Number((1 / ratio).toPrecision(4))}×`;
}

function useWaveformRevision(enabled: boolean, maxFps = 30): number {
  const [revision, setRevision] = useState(telemetryHub.revision);
  useEffect(() => {
    if (!enabled) return;
    setRevision(telemetryHub.revision);
    let lastUpdate = 0;
    let timer: number | null = null;
    const update = () => { timer = null; lastUpdate = performance.now(); setRevision(telemetryHub.revision); };
    const unsubscribe = telemetryHub.subscribe(() => {
      if (timer !== null) return;
      timer = window.setTimeout(update, Math.max(0, 1000 / maxFps - (performance.now() - lastUpdate)));
    });
    return () => { unsubscribe(); if (timer !== null) window.clearTimeout(timer); };
  }, [enabled, maxFps]);
  return revision;
}

export function WaveformWorkspace({ active = true }: { active?: boolean }) {
  const revision = useWaveformRevision(active);
  const [selected, setSelected] = useState<SeriesId[]>([]);
  const [selectionMode, setSelectionMode] = useState<"single" | "multi">("multi");
  const [sources, setSources] = useState<Set<TelemetrySource>>(() => new Set(SOURCES.map((source) => source.id)));
  const [windowSeconds, setWindowSeconds] = useState<WaveWindowSeconds>(30);
  const [paused, setPaused] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [hidden, setHidden] = useState<Set<SeriesId>>(() => new Set());
  const [colors, setColors] = useState<Partial<Record<SeriesId, string>>>({});
  const [yMode, setYMode] = useState<"auto" | "fixed">("auto");
  const [yMin, setYMin] = useState("0");
  const [yMax, setYMax] = useState("100");
  const [xZoomLevel, setXZoomLevel] = useState(0);
  const [yZoomLevel, setYZoomLevel] = useState(0);
  const [smoothLevel, setSmoothLevel] = useState(0);
  const [search, setSearch] = useState("");
  const [demoActive, setDemoActive] = useState(false);
  const frozenRef = useRef<TelemetrySnapshot | null>(null);
  const windowMs = windowSeconds * 1000;
  void revision;

  useEffect(() => {
    if (!demoActive) return;
    const tick = () => {
      const at = Date.now();
      publishFrame("remote", demoRemoteFrame(at), "demo", at);
      publishFrame("chassis", demoChassisFrame(at), "demo", at);
      publishFrame("locator", demoLocatorFrame(at), "demo", at);
    };
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [demoActive]);

  useEffect(() => { telemetryHub.select(selected); }, [selected]);

  const live = telemetryHub.snapshot(windowMs, undefined, selected);
  const shown = paused ? frozenRef.current ?? live : live;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const fieldCatalog = telemetryHub.catalog();
  const catalog = fieldCatalog.filter((field) => {
    const details = describeSeries(field.id);
    return sources.has(field.source) && (!normalizedSearch || `${field.label} ${details.description} ${details.sourceLabel} ${details.unit}`.toLocaleLowerCase().includes(normalizedSearch));
  });
  const descriptors = new Map(fieldCatalog.map((field) => [field.id, field]));
  const plotSeries: PlotSeriesInput[] = selected.flatMap((id) => {
    const descriptor = descriptors.get(id);
    if (!descriptor) return [];
    const details = describeSeries(id);
    return [{ id, ...details, color: colors[id] ?? descriptor.color, visible: !hidden.has(id), points: shown.series.get(id) ?? [] }];
  });
  const fixedMin = Number(yMin); const fixedMax = Number(yMax);
  const yScale: YScaleMode = yMode === "fixed" && Number.isFinite(fixedMin) && Number.isFinite(fixedMax) && fixedMin < fixedMax
    ? { kind: "fixed", min: fixedMin, max: fixedMax } : { kind: "auto" };
  const xZoomRatio = zoomLevelToRatio(xZoomLevel, 10);
  const yZoomRatio = centeredZoomLevelToRatio(yZoomLevel, 4);
  const throughSeconds = (shown.acquiredThroughMs ?? Date.now()) / 1000;
  const visibleXSpan = zoomedXSpanSeconds(windowMs, xZoomRatio, throughSeconds);

  const toggleField = (id: SeriesId) => {
    setSelected((old) => selectionMode === "single" ? [id] : old.includes(id) ? old.filter((item) => item !== id) : [...old, id]);
    setFollowLatest(true);
  };
  const togglePause = () => {
    if (!paused) frozenRef.current = telemetryHub.snapshot(windowMs, undefined, selected);
    else frozenRef.current = null;
    setPaused(!paused);
  };
  const applyPreset = (fields: readonly SeriesId[]) => {
    const existing = new Set(telemetryHub.catalog().map((field) => field.id));
    setSelected(fields.filter((field) => existing.has(field)));
    setSelectionMode("multi"); setFollowLatest(true);
  };
  const stopDemo = useCallback(() => {
    setDemoActive(false);
    SOURCES.forEach((source) => telemetryHub.releaseSource(source.id, "demo"));
  }, []);
  const toggleDemo = () => {
    if (demoActive) { stopDemo(); return; }
    const now = Date.now();
    for (let offset = 30_000; offset >= 0; offset -= 100) {
      const at = now - offset;
      publishFrame("remote", demoRemoteFrame(at), "demo", at);
      publishFrame("chassis", demoChassisFrame(at), "demo", at);
      publishFrame("locator", demoLocatorFrame(at), "demo", at);
    }
    setDemoActive(true);
  };
  useEffect(() => { if (!active && demoActive) stopDemo(); }, [active, demoActive, stopDemo]);
  const selectedPoints = useMemo(() => plotSeries.reduce((total, item) => total + item.points.length, 0), [plotSeries]);

  return <main className="workspace waveform-workspace" data-testid="waveform-workspace">
    <WorkspaceHeader kicker="R1 DATA OSCILLOSCOPE" title="数据示波器" description="VOFA 风格多变量时序波形：任意选择遥控器、底盘或定位板数值字段，在同一真实时间轴上悬停对比、缩放、平移和冻结观察。"
      meta={<><span>shared X time axis</span><span>up to 30 min</span><span>hover crosshair</span><span>30 FPS render cap</span></>}
      actions={<><button className={demoActive ? "selected" : "secondary"} onClick={toggleDemo}>{demoActive ? "停止演示" : "演示波形"}</button><button className={paused ? "selected" : "secondary"} onClick={togglePause}>{paused ? "恢复实时" : "暂停显示"}</button><button className="secondary" onClick={() => { telemetryHub.clear(); frozenRef.current = null; }}>清空缓冲</button></>} />

    <section className="scope-controlbar" title="选择波形通道、基础时间窗口和纵轴量程策略。">
      <div className="scope-control-group"><span>选择模式</span><div><button title="每次只显示一个数据字段。" className={selectionMode === "single" ? "selected" : "secondary"} onClick={() => { setSelectionMode("single"); setSelected((old) => old.slice(-1)); }}>单曲线</button><button title="允许把多个数据字段叠加到同一时间轴。" className={selectionMode === "multi" ? "selected" : "secondary"} onClick={() => setSelectionMode("multi")}>多曲线</button></div></div>
      <div className="scope-control-group grow"><span>时间窗口</span><div>{WINDOWS.map(([seconds, label]) => <button title={`把横轴基础窗口设置为 ${label}；仍可用下方滑块继续放大到微秒级浮点安全下限。`} key={seconds} className={windowSeconds === seconds ? "selected" : "secondary"} onClick={() => { setWindowSeconds(seconds); setXZoomLevel(0); setFollowLatest(true); }}>{label}</button>)}</div></div>
      <div className="scope-control-group"><span>Y 轴</span><div><button title="根据当前可见曲线数据自动计算基础纵轴范围。" className={yMode === "auto" ? "selected" : "secondary"} onClick={() => setYMode("auto")}>自动量程</button><button title="以手动输入的最小值和最大值作为基础纵轴范围。" className={yMode === "fixed" ? "selected" : "secondary"} onClick={() => setYMode("fixed")}>固定范围</button></div></div>
      <button title="让横轴右端持续对齐最新数据。手动框选、滚轮或平移会退出跟随。" className={followLatest ? "selected" : "secondary"} onClick={() => setFollowLatest(true)}>跟随最新</button>
    </section>

    <section className="scope-zoom-controls" aria-label="波形显示控制">
      <label title="按指数连续缩短可见时间窗；最大端会停在当前时间戳的 IEEE-754 浮点安全下限，不受 10 秒预设限制。"><span><strong>横轴缩放</strong><small>可见时间窗 {formatTimeSpan(visibleXSpan)}</small></span><input aria-label="横轴缩放" aria-valuetext={`可见时间窗 ${formatTimeSpan(visibleXSpan)}`} type="range" min="0" max="100" step="0.1" value={xZoomLevel} onChange={(event) => { setXZoomLevel(Number(event.target.value)); setFollowLatest(true); }} /></label>
      <label title="围绕当前自动量程或固定量程的中心缩放；向左缩小曲线，向右放大曲线。"><span><strong>纵轴缩放</strong><small>{formatZoomRatio(yZoomRatio)}</small></span><input aria-label="纵轴缩放" aria-valuetext={formatZoomRatio(yZoomRatio)} type="range" min="-100" max="100" step="0.1" value={yZoomLevel} onChange={(event) => setYZoomLevel(Number(event.target.value))} /></label>
      <label title="使用类似 TensorBoard 的偏置修正指数移动平均让所有曲线更平滑；仅改变绘图、自动 Y 量程与悬停显示，不修改采集、诊断或导出数据。"><span><strong>曲线平滑</strong><small>{smoothLevel.toFixed(2)} · 仅影响显示</small></span><input aria-label="曲线平滑" aria-valuetext={`${smoothLevel.toFixed(2)}，仅影响显示`} type="range" min="0" max="1" step="0.01" value={smoothLevel} onChange={(event) => setSmoothLevel(Number(event.target.value))} /></label>
      <button title="恢复当前时间窗口和当前 Y 轴量程，并重新跟随最新数据。" className="secondary" type="button" onClick={() => { setXZoomLevel(0); setYZoomLevel(0); setFollowLatest(true); }}>复位双轴</button>
    </section>

    {yMode === "fixed" && <section className="fixed-range"><label>Y 最小值<input type="number" value={yMin} onChange={(event) => setYMin(event.target.value)} /></label><label>Y 最大值<input type="number" value={yMax} onChange={(event) => setYMax(event.target.value)} /></label>{yScale.kind !== "fixed" && <span>固定范围必须满足：有限数值且最小值小于最大值。</span>}</section>}

    <section className="preset-strip" title="一键选择常用的多曲线诊断组合。"><strong>快速组合</strong>{PRESETS.map((preset) => <button title={`显示${preset.label}相关字段。`} className="secondary" key={preset.label} onClick={() => applyPreset(preset.fields)}>{preset.label}</button>)}</section>

    <div className="scope-layout">
      <aside className="scope-sidebar panel">
        <header><div><span>CHANNELS</span><strong>数值字段</strong></div><small>{selected.length} 已选</small></header>
        <div className="source-filters">{SOURCES.map((source) => <label key={source.id} className={sources.has(source.id) ? "active" : ""}><input type="checkbox" checked={sources.has(source.id)} onChange={() => setSources((old) => { const next = new Set(old); if (next.has(source.id)) next.delete(source.id); else next.add(source.id); return next; })} /><span>{source.label}<small>{source.detail} · {telemetryHub.activeOrigin(source.id) ?? "idle"}</small></span></label>)}</div>
        <input className="channel-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索字段，例如 yaw / ack…" />
        <div className="channel-list">{catalog.length === 0 ? <p className="empty">连接串口、加载回放或启用演示波形后显示字段。</p> : catalog.map((field) => {
          const point = telemetryHub.latest(field.id);
          const details = describeSeries(field.id);
          return <label key={field.id} className={selected.includes(field.id) ? "selected" : ""}>
            <input aria-label={`选择 ${details.label}`} type={selectionMode === "single" ? "radio" : "checkbox"} checked={selected.includes(field.id)} onChange={() => toggleField(field.id)} />
            <i style={{ background: colors[field.id] ?? field.color }} />
            <span title={`${details.description} · 来源：${details.sourceLabel} · 单位：${details.unit} · 字段：${details.fieldPath}`}><span>{details.label}<em>{details.fieldPath}</em></span><small>{point ? Number(point.value.toPrecision(7)) : "—"}</small></span>
            <input title={`修改“${details.label}”的曲线颜色。`} aria-label={`${details.label} 颜色`} type="color" value={colors[field.id] ?? field.color} onChange={(event) => setColors((old) => ({ ...old, [field.id]: event.target.value }))} />
          </label>;
        })}</div>
      </aside>

      <section className="scope-stage panel">
        <header className="scope-stage-head"><div><strong>实时波形</strong><span>{paused ? "显示已冻结，后台仍持续采集" : followLatest ? "跟随最新数据" : "已离开实时窗口"}</span></div><dl><div><dt>缓冲点</dt><dd>{telemetryHub.pointCount().toLocaleString()}</dd></div><div><dt>当前曲线点</dt><dd>{selectedPoints.toLocaleString()}</dd></div><div><dt>曲线</dt><dd>{plotSeries.length}</dd></div></dl></header>
        {plotSeries.length === 0 ? <div className="scope-empty"><strong>选择一条或多条曲线开始观察</strong><p>可先点击“演示波形”，再使用上方快速组合；真实串口连接后字段会自动进入左侧列表。</p></div> : <UPlotWaveform series={plotSeries} yScale={yScale} xZoomRatio={xZoomRatio} yZoomRatio={yZoomRatio} smoothLevel={smoothLevel} followLatest={followLatest} windowMs={windowMs} throughMs={shown.acquiredThroughMs ?? Date.now()} onUserNavigate={() => setFollowLatest(false)} onResetView={() => { setXZoomLevel(0); setYZoomLevel(0); setFollowLatest(true); }} onVisibilityChange={(id, visible) => setHidden((old) => { const next = new Set(old); if (visible) next.delete(id); else next.add(id); return next; })} />}
      </section>
    </div>
  </main>;
}
