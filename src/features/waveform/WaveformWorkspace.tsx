import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { publishFrame, telemetryHub, type SeriesId, type TelemetrySource, type TelemetrySnapshot, type WaveWindowSeconds, type YScaleMode } from "../../core/telemetry";
import { UPlotWaveform } from "../../shared/components/UPlotWaveform";
import { WorkspaceHeader } from "../../shared/components/WorkspaceHeader";
import { demoChassisFrame, demoLocatorFrame, demoRemoteFrame } from "../demo/demoData";
import type { PlotSeriesInput } from "./data";

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
  { label: "驱动反馈", fields: ["chassis:drvCmd1", "chassis:drvFb1", "chassis:drvCmd2", "chassis:drvFb2"] },
];

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
  const catalog = fieldCatalog.filter((field) => sources.has(field.source) && (!normalizedSearch || field.label.toLocaleLowerCase().includes(normalizedSearch)));
  const descriptors = new Map(fieldCatalog.map((field) => [field.id, field]));
  const plotSeries: PlotSeriesInput[] = selected.flatMap((id) => {
    const descriptor = descriptors.get(id);
    if (!descriptor) return [];
    return [{ id, label: descriptor.label, color: colors[id] ?? descriptor.color, visible: !hidden.has(id), points: shown.series.get(id) ?? [] }];
  });
  const fixedMin = Number(yMin); const fixedMax = Number(yMax);
  const yScale: YScaleMode = yMode === "fixed" && Number.isFinite(fixedMin) && Number.isFinite(fixedMax) && fixedMin < fixedMax
    ? { kind: "fixed", min: fixedMin, max: fixedMax } : { kind: "auto" };

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

    <section className="scope-controlbar">
      <div className="scope-control-group"><span>选择模式</span><div><button className={selectionMode === "single" ? "selected" : "secondary"} onClick={() => { setSelectionMode("single"); setSelected((old) => old.slice(-1)); }}>单曲线</button><button className={selectionMode === "multi" ? "selected" : "secondary"} onClick={() => setSelectionMode("multi")}>多曲线</button></div></div>
      <div className="scope-control-group grow"><span>时间窗口</span><div>{WINDOWS.map(([seconds, label]) => <button key={seconds} className={windowSeconds === seconds ? "selected" : "secondary"} onClick={() => { setWindowSeconds(seconds); setFollowLatest(true); }}>{label}</button>)}</div></div>
      <div className="scope-control-group"><span>Y 轴</span><div><button className={yMode === "auto" ? "selected" : "secondary"} onClick={() => setYMode("auto")}>自动量程</button><button className={yMode === "fixed" ? "selected" : "secondary"} onClick={() => setYMode("fixed")}>固定范围</button></div></div>
      <button className={followLatest ? "selected" : "secondary"} onClick={() => setFollowLatest(true)}>跟随最新</button>
    </section>

    {yMode === "fixed" && <section className="fixed-range"><label>Y 最小值<input type="number" value={yMin} onChange={(event) => setYMin(event.target.value)} /></label><label>Y 最大值<input type="number" value={yMax} onChange={(event) => setYMax(event.target.value)} /></label>{yScale.kind !== "fixed" && <span>固定范围必须满足：有限数值且最小值小于最大值。</span>}</section>}

    <section className="preset-strip"><strong>快速组合</strong>{PRESETS.map((preset) => <button className="secondary" key={preset.label} onClick={() => applyPreset(preset.fields)}>{preset.label}</button>)}</section>

    <div className="scope-layout">
      <aside className="scope-sidebar panel">
        <header><div><span>CHANNELS</span><strong>数值字段</strong></div><small>{selected.length} 已选</small></header>
        <div className="source-filters">{SOURCES.map((source) => <label key={source.id} className={sources.has(source.id) ? "active" : ""}><input type="checkbox" checked={sources.has(source.id)} onChange={() => setSources((old) => { const next = new Set(old); if (next.has(source.id)) next.delete(source.id); else next.add(source.id); return next; })} /><span>{source.label}<small>{source.detail} · {telemetryHub.activeOrigin(source.id) ?? "idle"}</small></span></label>)}</div>
        <input className="channel-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索字段，例如 yaw / ack…" />
        <div className="channel-list">{catalog.length === 0 ? <p className="empty">连接串口、加载回放或启用演示波形后显示字段。</p> : catalog.map((field) => {
          const point = telemetryHub.latest(field.id);
          return <label key={field.id} className={selected.includes(field.id) ? "selected" : ""}>
            <input aria-label={`选择 ${field.label}`} type={selectionMode === "single" ? "radio" : "checkbox"} checked={selected.includes(field.id)} onChange={() => toggleField(field.id)} />
            <i style={{ background: colors[field.id] ?? field.color }} />
            <span title={field.label}>{field.label}<small>{point ? Number(point.value.toPrecision(7)) : "—"}</small></span>
            <input aria-label={`${field.label} 颜色`} type="color" value={colors[field.id] ?? field.color} onChange={(event) => setColors((old) => ({ ...old, [field.id]: event.target.value }))} />
          </label>;
        })}</div>
      </aside>

      <section className="scope-stage panel">
        <header className="scope-stage-head"><div><strong>实时波形</strong><span>{paused ? "显示已冻结，后台仍持续采集" : followLatest ? "跟随最新数据" : "已离开实时窗口"}</span></div><dl><div><dt>缓冲点</dt><dd>{telemetryHub.pointCount().toLocaleString()}</dd></div><div><dt>当前曲线点</dt><dd>{selectedPoints.toLocaleString()}</dd></div><div><dt>曲线</dt><dd>{plotSeries.length}</dd></div></dl></header>
        {plotSeries.length === 0 ? <div className="scope-empty"><strong>选择一条或多条曲线开始观察</strong><p>可先点击“演示波形”，再使用上方快速组合；真实串口连接后字段会自动进入左侧列表。</p></div> : <UPlotWaveform series={plotSeries} yScale={yScale} followLatest={followLatest} windowMs={windowMs} throughMs={shown.acquiredThroughMs ?? Date.now()} onUserNavigate={() => setFollowLatest(false)} onResetView={() => setFollowLatest(true)} onVisibilityChange={(id, visible) => setHidden((old) => { const next = new Set(old); if (visible) next.delete(id); else next.add(id); return next; })} />}
      </section>
    </div>
  </main>;
}
