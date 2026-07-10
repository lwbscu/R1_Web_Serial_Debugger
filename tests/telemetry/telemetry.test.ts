import { describe, expect, it } from "vitest";
import { extractNumericFields, minMaxDecimate, stableSeriesColor, TelemetryHub } from "../../src/core/telemetry";

describe("数值字段目录", () => {
  it("提取三类帧的有限数值、布尔值和嵌套诊断字段", () => {
    const result = extractNumericFields("locator", {
      observedAtMs: 12, rawLine: "不可信文本", posXcm: 1.5, valid: true,
      bad: Number.NaN, diagnostics: { packets: 7, online: false }, nested: { too: { deep: 1 } },
    });
    expect(result.values).toEqual({ posXcm: 1.5, valid: 1, "diagnostics.packets": 7, "diagnostics.online": 0 });
    expect(result.descriptors.map((item) => item.id)).toEqual([
      "locator:posXcm", "locator:valid", "locator:diagnostics.packets", "locator:diagnostics.online",
    ]);
  });

  it("颜色仅由序列 ID 决定", () => {
    expect(stableSeriesColor("remote:signalBars")).toBe(stableSeriesColor("remote:signalBars"));
    expect(stableSeriesColor("remote:signalBars")).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("min/max 降采样", () => {
  it("限制点数并保留端点与短尖峰", () => {
    const points = Array.from({ length: 1000 }, (_, index) => ({ atMs: index, value: index === 501 ? 999 : Math.sin(index / 20) }));
    const result = minMaxDecimate(points, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
    expect(Math.max(...result.map((point) => point.value))).toBe(999);
  });
});

describe("TelemetryHub", () => {
  it("发布动态字段、按窗口查询并保持 snapshot 独立", () => {
    let now = 100_000;
    const hub = new TelemetryHub({ retentionMs: 60_000, maxPointsPerSeries: 10, now: () => now });
    hub.publishFrame("remote", { signalBars: 2, linkOnline: true }, "serial");
    const frozen = hub.snapshot(60_000);
    now += 1000;
    hub.publishFrame("chassis", { ackScore: 80 }, "serial");
    expect(frozen.series.get("remote:signalBars")).toHaveLength(1);
    expect(frozen.series.has("chassis:ackScore")).toBe(false);
    expect(hub.catalog().map((item) => item.id)).toEqual(["chassis:ackScore", "remote:linkOnline", "remote:signalBars"]);
    expect(hub.snapshot(60_000).retainedPoints).toBe(3);
  });

  it("按时间和容量双重限制缓冲，clear 保留字段目录", () => {
    const hub = new TelemetryHub({ retentionMs: 100, maxPointsPerSeries: 6, now: () => 0 });
    for (let index = 0; index < 20; index += 1) hub.publishFrame("locator", { posXcm: index }, "demo", index * 10);
    const points = hub.snapshot(100, 190).series.get("locator:posXcm") ?? [];
    expect(points.length).toBeLessThanOrEqual(6);
    expect(points.every((point) => point.atMs >= 90)).toBe(true);
    hub.clear();
    expect(hub.snapshot().retainedPoints).toBe(0);
    expect(hub.catalog().map((item) => item.id)).toContain("locator:posXcm");
  });

  it("只通知订阅者，不访问网络或串口", () => {
    const hub = new TelemetryHub();
    let calls = 0;
    const unsubscribe = hub.subscribe(() => { calls += 1; });
    hub.publishFrame("remote", { failCount: 1 }, "serial", 1);
    unsubscribe();
    hub.publishFrame("remote", { failCount: 2 }, "serial", 2);
    expect(calls).toBe(1);
  });

  it("乱序时间戳仍按共享时间轴排序", () => {
    const hub = new TelemetryHub({ retentionMs: 1000 });
    hub.publishFrame("remote", { rfCh: 3 }, "replay", 300);
    hub.publishFrame("remote", { rfCh: 1 }, "replay", 100);
    hub.publishFrame("remote", { rfCh: 2 }, "replay", 200);
    expect(hub.snapshot(1000, 300).series.get("remote:rfCh")?.map((point) => point.value)).toEqual([1, 2, 3]);
  });

  it("仅为已选曲线保留长窗口，未选字段保持短预览", () => {
    const hub = new TelemetryHub({ retentionMs: 1000, maxPointsPerSeries: 50, unselectedRetentionMs: 100, maxUnselectedPoints: 5, pruneBatchSize: 1 });
    hub.select(["remote:signalBars"]);
    for (let index = 0; index < 20; index += 1) hub.publishFrame("remote", { signalBars: index, ackOkCount: index }, "serial", index * 10);
    expect(hub.snapshot(1000, 190, ["remote:signalBars"]).series.get("remote:signalBars")).toHaveLength(20);
    expect(hub.snapshot(1000, 190, ["remote:ackOkCount"]).series.get("remote:ackOkCount")!.length).toBeLessThanOrEqual(5);
    expect(hub.latest("remote:ackOkCount")?.value).toBe(19);
  });

  it("按 serial > replay > demo 隔离来源，显式释放后才允许降级", () => {
    const hub = new TelemetryHub();
    hub.publishFrame("locator", { posXcm: 1 }, "demo", 1);
    hub.publishFrame("locator", { posXcm: 2 }, "serial", 2);
    hub.publishFrame("locator", { posXcm: 3 }, "demo", 3);
    expect(hub.activeOrigin("locator")).toBe("serial");
    expect(hub.snapshot(100, 3).series.get("locator:posXcm")?.map((point) => point.value)).toEqual([2]);
    hub.releaseSource("locator", "serial");
    hub.publishFrame("locator", { posXcm: 4 }, "demo", 4);
    expect(hub.snapshot(100, 4).series.get("locator:posXcm")?.map((point) => point.value)).toEqual([4]);
  });
});
