import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { YScaleMode } from "../../core/telemetry";
import { alignPlotSeries, type PlotSeriesInput } from "../../features/waveform/data";

export interface UPlotWaveformProps {
  series: readonly PlotSeriesInput[];
  yScale: YScaleMode;
  followLatest: boolean;
  windowMs: number;
  throughMs: number;
  maxPointsPerSeries?: number;
  onVisibilityChange?: (id: PlotSeriesInput["id"], visible: boolean) => void;
  onUserNavigate?: () => void;
  onResetView?: () => void;
}

interface HoverReadout { atMs: number; values: Array<{ id: string; label: string; color: string; value: number | null }> }

export function UPlotWaveform({
  series,
  yScale,
  followLatest,
  windowMs,
  throughMs,
  maxPointsPerSeries = 10_000,
  onVisibilityChange,
  onUserNavigate,
  onResetView,
}: UPlotWaveformProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const fullRangeRef = useRef<[number, number] | null>(null);
  const callbacksRef = useRef({ onVisibilityChange, onUserNavigate, onResetView });
  callbacksRef.current = { onVisibilityChange, onUserNavigate, onResetView };
  const [hover, setHover] = useState<HoverReadout | null>(null);
  const aligned = useMemo(() => alignPlotSeries(series, maxPointsPerSeries), [series, maxPointsPerSeries]);
  const firstTime = aligned.data[0][0];
  const lastTime = aligned.data[0].at(-1);
  fullRangeRef.current = firstTime == null || lastTime == null ? null : [firstTime, lastTime];
  const structureKey = series.map((item) => `${item.id}:${item.color}`).join("|") + `:${yScale.kind === "fixed" ? `${yScale.min}:${yScale.max}` : "auto"}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const width = Math.max(480, host.clientWidth || 900);
    const options: uPlot.Options = {
      width,
      height: 500,
      scales: {
        x: { time: true },
        y: yScale.kind === "fixed" ? { auto: false, range: [yScale.min, yScale.max] } : { auto: true },
      },
      axes: [
        { label: "时间", stroke: "#8aa4b8", grid: { stroke: "rgba(61,82,98,.42)", width: 1 }, ticks: { stroke: "#344c5d" }, font: "10px ui-monospace, Consolas, monospace" },
        { label: "数值", stroke: "#8aa4b8", grid: { stroke: "rgba(61,82,98,.42)", width: 1 }, ticks: { stroke: "#344c5d" }, font: "10px ui-monospace, Consolas, monospace", size: 65 },
      ],
      cursor: {
        show: true, x: true, y: true, lock: false,
        points: { show: true, size: 6 },
        drag: { x: true, y: false, setScale: true, dist: 8 },
      },
      legend: { show: true, live: true },
      series: [
        { label: "时间" },
        ...series.map((item) => ({ label: item.label, stroke: item.color, width: 2, show: item.visible, spanGaps: false, points: { show: false } })),
      ],
      hooks: {
        setCursor: [(plot) => {
          const index = plot.cursor.idx;
          if (index == null) { setHover(null); return; }
          const atSeconds = plot.data[0][index];
          if (typeof atSeconds !== "number") { setHover(null); return; }
          setHover({
            atMs: atSeconds * 1000,
            values: series.map((item, seriesIndex) => ({
              id: item.id, label: item.label, color: item.color,
              value: typeof plot.data[seriesIndex + 1]?.[index] === "number" ? plot.data[seriesIndex + 1]![index] as number : null,
            })),
          });
        }],
        setSeries: [(_plot, seriesIndex, opts) => {
          if (seriesIndex == null || seriesIndex === 0 || opts.show === undefined) return;
          const item = series[seriesIndex - 1];
          if (item) callbacksRef.current.onVisibilityChange?.(item.id, opts.show);
        }],
        setSelect: [() => callbacksRef.current.onUserNavigate?.()],
      },
    };
    const plot = new uPlot(options, aligned.data, host);
    plotRef.current = plot;

    const clampRange = (min: number, max: number, fullMin: number, fullMax: number): [number, number] => {
      const widthValue = Math.min(max - min, fullMax - fullMin);
      let nextMin = Math.max(fullMin, min);
      let nextMax = nextMin + widthValue;
      if (nextMax > fullMax) { nextMax = fullMax; nextMin = fullMax - widthValue; }
      return [nextMin, nextMax];
    };
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
        const shift = Math.sign(event.deltaY || event.deltaX) * span * 0.12;
        const [min, max] = clampRange(xMin + shift, xMax + shift, fullMin, fullMax);
        plot.setScale("x", { min, max });
      } else {
        const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.0015)));
        const anchor = plot.posToVal(event.offsetX - plot.bbox.left / uPlot.pxRatio, "x");
        const min = anchor - (anchor - xMin) * factor;
        const max = anchor + (xMax - anchor) * factor;
        const [boundedMin, boundedMax] = clampRange(min, max, fullMin, fullMax);
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
      const [min, max] = clampRange(panStart.min + shift, panStart.max + shift, fullMin, fullMax);
      plot.setScale("x", { min, max }); callbacksRef.current.onUserNavigate?.();
    };
    const pointerUp = () => { panStart = null; };
    plot.over.addEventListener("wheel", wheel, { passive: false });
    plot.over.addEventListener("dblclick", doubleClick);
    plot.over.addEventListener("pointerdown", pointerDown, true);
    plot.over.addEventListener("pointermove", pointerMove);
    plot.over.addEventListener("pointerup", pointerUp);
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      plot.setSize({ width: Math.max(480, Math.floor(entry.contentRect.width)), height: 500 });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      plot.over.removeEventListener("wheel", wheel);
      plot.over.removeEventListener("dblclick", doubleClick);
      plot.over.removeEventListener("pointerdown", pointerDown, true);
      plot.over.removeEventListener("pointermove", pointerMove);
      plot.over.removeEventListener("pointerup", pointerUp);
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
    // Rebuild only when series structure or scale policy changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(aligned.data, false);
    series.forEach((item, index) => {
      if (plot.series[index + 1]?.show !== item.visible) plot.setSeries(index + 1, { show: item.visible }, false);
    });
    if (followLatest && throughMs > 0) {
      plot.setScale("x", { min: (throughMs - windowMs) / 1000, max: throughMs / 1000 });
    }
  }, [aligned, followLatest, series, throughMs, windowMs]);

  return <section className="uplot-waveform" aria-label="时序波形图">
    <div className="uplot-host" ref={hostRef} />
    <div className="scope-cursor-readout" aria-live="polite">
      <strong>{hover ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(hover.atMs) : "移动光标查看读数"}</strong>
      {hover?.values.map((item) => <span key={item.id} style={{ color: item.color }}><i style={{ background: item.color }} />{item.label}<b>{item.value == null ? "—" : Number(item.value.toPrecision(7))}</b></span>)}
    </div>
    <p className="muted">框选缩放 · Shift 拖动平移 · 滚轮缩放 · Shift+滚轮平移 · 双击复位</p>
  </section>;
}
