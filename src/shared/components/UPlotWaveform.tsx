import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { YScaleMode } from "../../core/telemetry";
import {
  alignPlotSeries,
  calculateYRange,
  clampXRange,
  zoomedXSpanSeconds,
  type PlotSeriesInput,
} from "../../features/waveform/data";

export interface UPlotWaveformProps {
  series: readonly PlotSeriesInput[];
  yScale: YScaleMode;
  followLatest: boolean;
  windowMs: number;
  throughMs: number;
  xZoomRatio?: number;
  yZoomRatio?: number;
  maxPointsPerSeries?: number;
  onVisibilityChange?: (id: PlotSeriesInput["id"], visible: boolean) => void;
  onUserNavigate?: () => void;
  onResetView?: () => void;
}

interface HoverReadout {
  atMs: number;
  values: Array<{
    id: string;
    label: string;
    color: string;
    value: number | null;
    unit: string;
    description: string;
    sourceLabel: string;
  }>;
}

interface SeriesTooltip {
  item: PlotSeriesInput;
  value: number | null;
  left: number;
  top: number;
  via: "curve" | "legend";
}

function dataValue(plot: uPlot, seriesIndex: number, index: number): number | null {
  const value = plot.data[seriesIndex + 1]?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Follow a rendered span across null cells introduced by other sources. */
function interpolatedDataValue(plot: uPlot, seriesIndex: number, index: number): number | null {
  const direct = dataValue(plot, seriesIndex, index);
  if (direct !== null) return direct;
  const values = plot.data[seriesIndex + 1];
  const times = plot.data[0];
  if (!values || !times) return null;
  let left = index - 1;
  while (left >= 0 && (typeof values[left] !== "number" || !Number.isFinite(values[left]))) left -= 1;
  let right = index + 1;
  while (right < values.length && (typeof values[right] !== "number" || !Number.isFinite(values[right]))) right += 1;
  if (left < 0 || right >= values.length) return null;
  const leftValue = values[left];
  const rightValue = values[right];
  const leftTime = times[left];
  const rightTime = times[right];
  const currentTime = times[index];
  if (typeof leftValue !== "number" || typeof rightValue !== "number" || typeof leftTime !== "number" || typeof rightTime !== "number" || typeof currentTime !== "number" || rightTime <= leftTime) return null;
  return leftValue + (rightValue - leftValue) * ((currentTime - leftTime) / (rightTime - leftTime));
}

function latestValue(plot: uPlot, seriesIndex: number): number | null {
  const values = plot.data[seriesIndex + 1];
  if (!values) return null;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function displayValue(value: number | null, unit: string | undefined): string {
  if (value === null) return "—";
  const text = String(Number(value.toPrecision(8)));
  return unit && unit !== "无量纲" ? `${text} ${unit}` : text;
}

export function UPlotWaveform({
  series,
  yScale,
  followLatest,
  windowMs,
  throughMs,
  xZoomRatio = 1,
  yZoomRatio = 1,
  maxPointsPerSeries = 10_000,
  onVisibilityChange,
  onUserNavigate,
  onResetView,
}: UPlotWaveformProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const fullRangeRef = useRef<[number, number] | null>(null);
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const callbacksRef = useRef({ onVisibilityChange, onUserNavigate, onResetView });
  callbacksRef.current = { onVisibilityChange, onUserNavigate, onResetView };
  const [hover, setHover] = useState<HoverReadout | null>(null);
  const [curveTooltip, setCurveTooltip] = useState<SeriesTooltip | null>(null);
  const [legendTooltip, setLegendTooltip] = useState<SeriesTooltip | null>(null);
  const aligned = useMemo(() => alignPlotSeries(series, maxPointsPerSeries), [series, maxPointsPerSeries]);
  const yRange = useMemo(() => calculateYRange(series, yScale, yZoomRatio), [series, yScale, yZoomRatio]);
  const firstTime = aligned.data[0][0];
  const lastTime = aligned.data[0].at(-1);
  fullRangeRef.current = firstTime == null || lastTime == null ? null : [firstTime, lastTime];
  const structureKey = series.map((item) => `${item.id}:${item.color}`).join("|");

  useEffect(() => {
    setHover(null);
    setCurveTooltip(null);
    setLegendTooltip(null);
  }, [structureKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const width = Math.max(480, host.clientWidth || 900);
    const options: uPlot.Options = {
      width,
      height: 500,
      scales: {
        x: { time: true },
        y: { auto: false, range: yRange },
      },
      axes: [
        { label: "时间", stroke: "#8aa4b8", grid: { stroke: "rgba(61,82,98,.42)", width: 1 }, ticks: { stroke: "#344c5d" }, font: "10px ui-monospace, Consolas, monospace" },
        { label: "数值", stroke: "#8aa4b8", grid: { stroke: "rgba(61,82,98,.42)", width: 1 }, ticks: { stroke: "#344c5d" }, font: "10px ui-monospace, Consolas, monospace", size: 65 },
      ],
      cursor: {
        show: true, x: true, y: true, lock: false,
        // Keep uPlot's default marker factory; overriding `show` with a boolean
        // suppresses the actual cursor-point elements in current uPlot builds.
        points: { size: 6 },
        drag: { x: true, y: false, setScale: true, dist: 8 },
      },
      legend: { show: true, live: true },
      series: [
        { label: "时间" },
        ...series.map((item) => ({ label: item.label, stroke: item.color, width: 2, show: item.visible, spanGaps: true, points: { show: false } })),
      ],
      hooks: {
        setCursor: [(plot) => {
          const index = plot.cursor.idx;
          if (index == null) { setHover(null); setCurveTooltip(null); return; }
          const atSeconds = plot.data[0][index];
          if (typeof atSeconds !== "number") { setHover(null); setCurveTooltip(null); return; }
          const currentSeries = seriesRef.current;
          setHover({
            atMs: atSeconds * 1000,
            values: currentSeries.map((item, seriesIndex) => ({
              id: item.id, label: item.label, color: item.color, unit: item.unit ?? "无量纲",
              description: item.description ?? "实时协议数值字段",
              sourceLabel: item.sourceLabel ?? item.id.split(":")[0]!,
              value: interpolatedDataValue(plot, seriesIndex, index),
            })),
          });
          const cursorTop = plot.cursor.top;
          const cursorLeft = plot.cursor.left;
          if (typeof cursorTop !== "number" || typeof cursorLeft !== "number") { setCurveTooltip(null); return; }
          let nearest: { item: PlotSeriesInput; value: number; distance: number } | null = null;
          for (let seriesIndex = 0; seriesIndex < currentSeries.length; seriesIndex += 1) {
            const item = currentSeries[seriesIndex];
            if (!item) continue;
            if (!plot.series[seriesIndex + 1]?.show) continue;
            const value = interpolatedDataValue(plot, seriesIndex, index);
            if (value === null) continue;
            const distance = Math.abs(plot.valToPos(value, "y") - cursorTop);
            if (!nearest || distance < nearest.distance) nearest = { item, value, distance };
          }
          if (nearest && nearest.distance <= 14) {
            setCurveTooltip({
              item: nearest.item, value: nearest.value, via: "curve",
              left: Math.max(8, Math.min(host.clientWidth - 292, plot.bbox.left / uPlot.pxRatio + cursorLeft + 14)),
              top: Math.max(8, Math.min(430, plot.bbox.top / uPlot.pxRatio + cursorTop + 14)),
            });
          } else setCurveTooltip(null);
        }],
        setSeries: [(_plot, seriesIndex, opts) => {
          if (seriesIndex == null || seriesIndex === 0 || opts.show === undefined) return;
          const item = seriesRef.current[seriesIndex - 1];
          if (item) callbacksRef.current.onVisibilityChange?.(item.id, opts.show);
        }],
        setSelect: [() => callbacksRef.current.onUserNavigate?.()],
      },
    };
    const plot = new uPlot(options, aligned.data, host);
    plotRef.current = plot;

    const wheel = (event: WheelEvent) => {
      const xScale = plot.scales.x;
      const fullRange = fullRangeRef.current;
      if (!xScale || typeof xScale.min !== "number" || typeof xScale.max !== "number" || !fullRange || fullRange[1] <= fullRange[0]) return;
      const [fullMin, fullMax] = fullRange;
      event.preventDefault();
      callbacksRef.current.onUserNavigate?.();
      const xMin = xScale.min; const xMax = xScale.max;
      const span = xMax - xMin;
      if (event.shiftKey) {
        const shift = Math.sign(event.deltaY || event.deltaX) * span * .12;
        const [min, max] = clampXRange(xMin + shift, xMax + shift, fullMin, fullMax);
        plot.setScale("x", { min, max });
      } else {
        const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * .0015)));
        const anchor = plot.posToVal(event.offsetX - plot.bbox.left / uPlot.pxRatio, "x");
        const min = anchor - (anchor - xMin) * factor;
        const max = anchor + (xMax - anchor) * factor;
        const [boundedMin, boundedMax] = clampXRange(min, max, fullMin, fullMax);
        plot.setScale("x", { min: boundedMin, max: boundedMax });
      }
    };
    const doubleClick = () => callbacksRef.current.onResetView?.();
    let panStart: { clientX: number; min: number; max: number } | null = null;
    const pointerDown = (event: PointerEvent) => {
      const xScale = plot.scales.x;
      if (!event.shiftKey || !xScale || typeof xScale.min !== "number" || typeof xScale.max !== "number") return;
      event.preventDefault(); event.stopImmediatePropagation();
      panStart = { clientX: event.clientX, min: xScale.min, max: xScale.max };
      plot.over.setPointerCapture(event.pointerId);
    };
    const pointerMove = (event: PointerEvent) => {
      if (!panStart) return;
      const fullRange = fullRangeRef.current;
      if (!fullRange) return;
      const [fullMin, fullMax] = fullRange;
      const unitsPerPixel = (panStart.max - panStart.min) / Math.max(1, plot.bbox.width / uPlot.pxRatio);
      const shift = (panStart.clientX - event.clientX) * unitsPerPixel;
      const [min, max] = clampXRange(panStart.min + shift, panStart.max + shift, fullMin, fullMax);
      plot.setScale("x", { min, max }); callbacksRef.current.onUserNavigate?.();
    };
    const pointerUp = () => { panStart = null; };
    plot.over.addEventListener("wheel", wheel, { passive: false });
    plot.over.addEventListener("dblclick", doubleClick);
    plot.over.addEventListener("pointerdown", pointerDown, true);
    plot.over.addEventListener("pointermove", pointerMove);
    plot.over.addEventListener("pointerup", pointerUp);

    const legendRows = [...plot.root.querySelectorAll<HTMLElement>(".u-legend .u-series")];
    const legendCleanups: Array<() => void> = [];
    legendRows.forEach((row, rowIndex) => {
      if (rowIndex === 0) return;
      const enter = () => {
        const item = seriesRef.current[rowIndex - 1];
        if (!item) return;
        const rowRect = row.getBoundingClientRect(); const hostRect = host.getBoundingClientRect();
        setLegendTooltip({ item, value: latestValue(plot, rowIndex - 1), via: "legend", left: Math.max(8, Math.min(host.clientWidth - 292, rowRect.left - hostRect.left)), top: rowRect.bottom - hostRect.top + 7 });
      };
      const leave = () => setLegendTooltip(null);
      row.addEventListener("mouseenter", enter); row.addEventListener("mouseleave", leave);
      legendCleanups.push(() => { row.removeEventListener("mouseenter", enter); row.removeEventListener("mouseleave", leave); });
    });

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      plot.setSize({ width: Math.max(480, Math.floor(entry.contentRect.width)), height: 500 });
    });
    observer.observe(host);
    return () => {
      observer.disconnect(); legendCleanups.forEach((cleanup) => cleanup());
      plot.over.removeEventListener("wheel", wheel);
      plot.over.removeEventListener("dblclick", doubleClick);
      plot.over.removeEventListener("pointerdown", pointerDown, true);
      plot.over.removeEventListener("pointermove", pointerMove);
      plot.over.removeEventListener("pointerup", pointerUp);
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
    // Rebuild only when the series identity or colors change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(aligned.data, false);
    series.forEach((item, index) => {
      if (plot.series[index + 1]?.show !== item.visible) plot.setSeries(index + 1, { show: item.visible }, false);
    });
    plot.setScale("y", { min: yRange[0], max: yRange[1] });
    if (followLatest && throughMs > 0) {
      const spanSeconds = zoomedXSpanSeconds(windowMs, xZoomRatio, throughMs / 1000);
      plot.setScale("x", { min: throughMs / 1000 - spanSeconds, max: throughMs / 1000 });
    }
  }, [aligned, followLatest, series, throughMs, windowMs, xZoomRatio, yRange]);

  const tooltip = legendTooltip ?? curveTooltip;
  return <section className="uplot-waveform" aria-label="时序波形图">
    <div className="uplot-host" ref={hostRef} />
    {tooltip && <div className={`wave-series-tooltip ${tooltip.via}`} style={{ left: tooltip.left, top: tooltip.top }} role="tooltip">
      <strong style={{ color: tooltip.item.color }}>{tooltip.item.label}</strong>
      <p>{tooltip.item.description ?? "实时协议数值字段"}</p>
      <dl><div><dt>来源</dt><dd>{tooltip.item.sourceLabel ?? tooltip.item.id.split(":")[0]}</dd></div><div><dt>字段</dt><dd>{tooltip.item.fieldPath ?? tooltip.item.id.split(":")[1]}</dd></div><div><dt>单位</dt><dd>{tooltip.item.unit ?? "无量纲"}</dd></div><div><dt>当前值</dt><dd>{displayValue(tooltip.value, tooltip.item.unit)}</dd></div></dl>
    </div>}
    <div className="scope-cursor-readout" aria-live="polite">
      <strong>{hover ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(hover.atMs) : "移动光标查看读数"}</strong>
      {hover?.values.map((item) => <span title={`${item.description} · 来源：${item.sourceLabel} · 单位：${item.unit}`} key={item.id} style={{ color: item.color }}><i style={{ background: item.color }} />{item.label}<b>{displayValue(item.value, item.unit)}</b></span>)}
    </div>
    <p className="muted">框选缩放 · Shift 拖动平移 · 滚轮连续缩放至浮点安全极限 · Shift+滚轮平移 · 双击复位双轴</p>
  </section>;
}
