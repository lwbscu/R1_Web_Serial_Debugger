import { expect, test } from "@playwright/test";
import { bodyToWorld, DT35_MOUNTS, FIELD_BOUNDS } from "../../src/features/locator/geometry";

test("uses the frozen centered field and +Y forward body convention", () => {
  expect(FIELD_BOUNDS).toEqual({ minX: -607.5, maxX: 607.5, minY: -605, maxY: 605 });
  expect(bodyToWorld({ x: 0, y: 0, yawDeg: 0 }, 0, 10)).toEqual({ x: 0, y: 10 });
  const turned = bodyToWorld({ x: 0, y: 0, yawDeg: 90 }, 0, 10);
  expect(turned.x).toBeCloseTo(10);
  expect(turned.y).toBeCloseTo(0);
  expect(DT35_MOUNTS).toEqual([
    expect.objectContaining({ xCm: -40.4, yCm: -3.3, yawOffsetDeg: -90 }),
    expect.objectContaining({ xCm: 40.4, yCm: -3.3, yawOffsetDeg: 90 }),
  ]);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serial", { configurable: true, value: undefined });
  });
});

test("keeps three workspaces mounted and explains unsupported Web Serial", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
  await expect(page.getByText("实时串口需要桌面版 Chrome/Edge")).toBeVisible();

  await page.getByRole("button", { name: /定位地图/ }).click();
  await expect(page.getByRole("heading", { name: "定位地图" })).toBeVisible();
  await expect(page.getByLabel("R1 定位场地图")).toBeVisible();
  await expect(page.getByText("直接使用冻结 Python 上位机的原始场地图")).toBeVisible();

  await page.getByRole("button", { name: /数据示波器/ }).click();
  await expect(page.getByRole("heading", { name: "数据示波器" })).toBeVisible();
  await expect(page.getByText("VOFA 风格多变量时序波形")).toBeVisible();

  await page.getByRole("button", { name: /通信诊断/ }).click();
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
});

test("shows diagnostic tooltips and a working multi-series waveform demo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "演示数据" }).click();
  const noAck = page.locator(".diagnostic-metric").filter({ hasText: "无 ACK 时间" });
  await expect(noAck).toBeVisible();
  await noAck.hover();
  await expect(noAck.getByRole("tooltip")).toContainText("正常范围");
  await expect(noAck.getByRole("tooltip")).toContainText("优先排查");

  await page.getByRole("button", { name: /数据示波器/ }).click();
  await page.getByRole("button", { name: "演示波形" }).click();
  await page.getByRole("button", { name: "链路质量" }).click();
  await expect(page.locator(".uplot-waveform .u-wrap")).toBeVisible();
  await expect(page.locator(".channel-list label.selected")).toHaveCount(5);
});

test("loads the frozen map assets and draws the robot demo", async ({ page }) => {
  const responses: string[] = [];
  page.on("response", (response) => { if (response.url().includes("/assets/map/")) responses.push(response.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: /定位地图/ }).click();
  await page.getByRole("button", { name: "演示轨迹" }).click();
  await expect(page.getByText("DT35-1").last()).toBeVisible();
  await expect.poll(() => responses.some((url) => url.endsWith("field_prior_map_clean_labeled_1215x1210cm.png"))).toBeTruthy();
  await expect.poll(() => responses.some((url) => url.endsWith("r1_chassis_830mm_texture_1024.png"))).toBeTruthy();
});

test("locator layout has no page-level horizontal overflow at supported breakpoints", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /定位地图/ }).click();
  for (const width of [1600, 1440, 1366, 1201, 900, 680, 375]) {
    await page.setViewportSize({ width, height: width <= 680 ? 812 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `width ${width}px overflowed` }).toBeTruthy();
  }
});

test("never offers serial write or control-signal actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("严格接收模式")).toBeVisible();
  await expect(page.getByRole("button", { name: /发送|写入|Ping|Zero|调参/ })).toHaveCount(0);
});
