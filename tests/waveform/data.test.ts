import { describe, expect, it } from "vitest";
import { alignPlotSeries } from "../../src/features/waveform/data";

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
});
