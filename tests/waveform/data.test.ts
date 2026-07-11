import { describe, expect, it } from "vitest";
import { minMaxDecimate } from "../../src/core/telemetry";
import {
  MIN_X_SPAN_SECONDS,
  alignPlotSeries,
  calculateYRange,
  centeredZoomLevelToRatio,
  clampXRange,
  describeSeries,
  minimumSafeXSpanSeconds,
  smoothTelemetryPoints,
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

describe("仅显示层曲线平滑", () => {
  const step = [
    { atMs: 0, value: 0 },
    { atMs: 100, value: 0 },
    { atMs: 200, value: 10 },
    { atMs: 300, value: 10 },
  ] as const;

  it("0 严格保持原始数值且不修改输入", () => {
    const original = step.map((point) => ({ ...point }));
    const result = smoothTelemetryPoints(step, 0);
    expect(result).toEqual(step);
    expect(step).toEqual(original);
    expect(result).not.toBe(step);
  });

  it("中间值平滑阶跃，1 最平滑但仍持续更新", () => {
    const middle = smoothTelemetryPoints(step, .5);
    const maximum = smoothTelemetryPoints(step, 1);
    expect(middle[2]!.value).toBeGreaterThan(0);
    expect(middle[2]!.value).toBeLessThan(10);
    expect(maximum[2]!.value).toBeGreaterThan(0);
    expect(maximum[3]!.value).toBeGreaterThan(maximum[2]!.value);
    expect(maximum[2]!.value).toBeLessThan(middle[2]!.value);
  });

  it("偏置修正让常值序列从首点起保持常值", () => {
    const result = smoothTelemetryPoints([
      { atMs: 0, value: 42 },
      { atMs: 20, value: 42 },
      { atMs: 40, value: 42 },
    ], 1);
    result.forEach((point) => expect(point.value).toBeCloseTo(42, 12));
  });

  it("遇到时间倒退或过大空洞时重置 EMA", () => {
    const result = smoothTelemetryPoints([
      { atMs: 0, value: 0 },
      { atMs: 100, value: 10 },
      { atMs: 200, value: 10 },
      { atMs: 1_301, value: 50 },
      { atMs: 1_401, value: 60 },
      { atMs: 1_000, value: 80 },
    ], .8);
    expect(result[3]!.value).toBe(50);
    expect(result[4]!.value).toBeGreaterThan(50);
    expect(result[4]!.value).toBeLessThan(60);
    expect(result[5]!.value).toBe(80);
  });

  it("每条曲线独立平滑，并且先平滑再做 min/max 降采样", () => {
    const first = Array.from({ length: 40 }, (_, index) => ({ atMs: index * 100, value: index === 20 ? 100 : 0 }));
    const second = Array.from({ length: 40 }, (_, index) => ({ atMs: index * 100, value: 7 }));
    const expectedFirst = smoothTelemetryPoints(first, .7);
    const result = alignPlotSeries([
      { id: "remote:signalBars", label: "first", color: "#fff", visible: true, points: first },
      { id: "chassis:ackScore", label: "second", color: "#000", visible: true, points: second },
    ], 10, .7);

    expect(result.series[0]!.points).toEqual(minMaxDecimate(expectedFirst, 10));
    result.series[1]!.points.forEach((point) => expect(point.value).toBeCloseTo(7, 12));
    expect(first[20]!.value).toBe(100);
  });

  it("自动 Y 量程可直接使用平滑后的显示序列", () => {
    const raw = [{ atMs: 0, value: 0 }, { atMs: 100, value: 100 }, { atMs: 200, value: 0 }];
    const displayed = alignPlotSeries([
      { id: "remote:signalBars", label: "signal", color: "#fff", visible: true, points: raw },
    ], 10, 1).series;
    const rawRange = calculateYRange([
      { id: "remote:signalBars", label: "signal", color: "#fff", visible: true, points: raw },
    ], { kind: "auto" });
    const displayRange = calculateYRange(displayed, { kind: "auto" });
    expect(displayRange[1]).toBeLessThan(rawRange[1]);
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
