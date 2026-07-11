import { describe, expect, it } from "vitest";
import {
  MIN_X_SPAN_SECONDS,
  alignPlotSeries,
  calculateYRange,
  centeredZoomLevelToRatio,
  clampXRange,
  describeSeries,
  minimumSafeXSpanSeconds,
  zoomedXSpanSeconds,
  zoomLevelToRatio,
} from "../../src/features/waveform/data";

describe("波形共享时间轴", () => {
  it("对齐异步序列并用 null 保留缺口", () => {
    const result = alignPlotSeries([
      { id: "remote:signalBars", label: "remote.signalBars", color: "#fff", visible: true, points: [{ atMs: 1000, value: 1 }, { atMs: 3000, value: 3 }] },
      { id: "chassis:ackScore", label: "chassis.ackScore", color: "#000", visible: true, points: [{ atMs: 2000, value: 20 }, { atMs: 3000, value: 30 }] },
    ]);
    expect(result.data[0]).toEqual([1, 2, 3]);
    expect(result.data[1]).toEqual([1, null, 3]);
    expect(result.data[2]).toEqual([null, 20, 30]);
  });

  it("进入 uPlot 前每序列不超过指定点数", () => {
    const result = alignPlotSeries([{
      id: "locator:posXcm", label: "locator.posXcm", color: "#fff", visible: true,
      points: Array.from({ length: 100 }, (_, index) => ({ atMs: index * 1000, value: index })),
    }], 10);
    expect(result.series[0]?.points.length).toBeLessThanOrEqual(10);
    expect(result.data[0].length).toBeLessThanOrEqual(10);
  });

  it("保留字段说明元数据", () => {
    const result = alignPlotSeries([{
      id: "locator:dt35_1mm", label: "locator.dt35_1mm", color: "#fff", visible: true,
      description: "左侧测距", sourceLabel: "定位板", unit: "mm", points: [{ atMs: 1, value: 100 }],
    }]);
    expect(result.series[0]).toMatchObject({ description: "左侧测距", sourceLabel: "定位板", unit: "mm" });
  });
});

describe("连续坐标轴缩放", () => {
  it("横轴滑块按对数连续缩小到毫秒级而非预设的 10 秒下限", () => {
    expect(zoomLevelToRatio(0, 6)).toBe(1);
    expect(zoomLevelToRatio(50, 6)).toBe(1000);
    const epochSeconds = 1_700_000_000;
    const minimum = minimumSafeXSpanSeconds(epochSeconds);
    expect(zoomedXSpanSeconds(30_000, zoomLevelToRatio(100, 10), epochSeconds)).toBe(minimum);
    expect(minimum).toBeLessThan(.001);
    expect(MIN_X_SPAN_SECONDS).toBe(.000001);
  });

  it("极细横轴范围仍保持有限、正宽并限制在采集范围内", () => {
    const [min, max] = clampXRange(1_700_000_005, 1_700_000_005, 1_700_000_000, 1_700_000_010);
    const safeSpan = minimumSafeXSpanSeconds(1_700_000_005);
    expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
    expect(max - min).toBeGreaterThanOrEqual(safeSpan * .95);
    expect(max - min).toBeLessThan(safeSpan * 1.1);
    expect(min).toBeGreaterThanOrEqual(1_700_000_000);
    expect(max).toBeLessThanOrEqual(1_700_000_010);
  });

  it("纵轴围绕基础量程中心连续缩放并忽略隐藏曲线", () => {
    const series = [
      { id: "remote:signalBars" as const, label: "a", color: "#fff", visible: true, points: [{ atMs: 1, value: 0 }, { atMs: 2, value: 100 }] },
      { id: "chassis:ackScore" as const, label: "b", color: "#000", visible: false, points: [{ atMs: 1, value: 10000 }] },
    ];
    const base = calculateYRange(series, { kind: "auto" }, 1);
    const zoomed = calculateYRange(series, { kind: "auto" }, 10);
    expect((zoomed[0] + zoomed[1]) / 2).toBeCloseTo((base[0] + base[1]) / 2);
    expect(zoomed[1] - zoomed[0]).toBeCloseTo((base[1] - base[0]) / 10);
    expect(base[1]).toBeLessThan(1000);
  });

  it("纵轴滑块支持围绕量程中心双向缩放", () => {
    expect(centeredZoomLevelToRatio(0, 4)).toBe(1);
    expect(centeredZoomLevelToRatio(50, 4)).toBe(100);
    expect(centeredZoomLevelToRatio(-50, 4)).toBe(.01);
    const base = calculateYRange([{ id: "remote:signalBars", label: "a", color: "#fff", visible: true, points: [{ atMs: 1, value: 0 }, { atMs: 2, value: 10 }] }], { kind: "auto" }, 1);
    const zoomedOut = calculateYRange([{ id: "remote:signalBars", label: "a", color: "#fff", visible: true, points: [{ atMs: 1, value: 0 }, { atMs: 2, value: 10 }] }], { kind: "auto" }, .01);
    expect(zoomedOut[1] - zoomedOut[0]).toBeCloseTo((base[1] - base[0]) * 100);
    const fixed = calculateYRange([], { kind: "fixed", min: -20, max: 80 }, 10);
    expect(fixed).toEqual([25, 35]);
  });
});

describe("字段中文提示", () => {
  it("提供含义、来源和单位", () => {
    expect(describeSeries("remote:noAckMs")).toMatchObject({
      label: "无 ACK 时长",
      description: "距离最近一次有效 NRF 应答的时间",
      sourceLabel: "遥控器 RDBG",
      unit: "ms",
      fieldPath: "noAckMs",
    });
    expect(describeSeries("locator:dt35_2mm")).toMatchObject({ sourceLabel: "定位板 CSV / R1M", unit: "mm" });
  });

  it("未知字段也返回可展示的中文后备说明", () => {
    expect(describeSeries("chassis:customAgeMs")).toMatchObject({ sourceLabel: "底盘 CDBG", unit: "ms" });
    expect(describeSeries("chassis:customAgeMs").description).toContain("时间或时延");
  });

  it("嵌套动态字段按末级字段推断单位并保留完整字段路径", () => {
    expect(describeSeries("locator:diagnostics.intervalMs")).toMatchObject({
      sourceLabel: "定位板 CSV / R1M",
      unit: "ms",
      fieldPath: "diagnostics.intervalMs",
    });
  });
});
