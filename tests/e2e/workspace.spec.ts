import { expect, test } from "@playwright/test";
import { bodyToWorld, DT35_MOUNTS, FIELD_BOUNDS } from "../../src/features/locator/geometry";

test("uses the frozen centered field and +Y forward body convention", () => {
  expect(FIELD_BOUNDS).toEqual({ minX: -607.5, maxX: 607.5, minY: -605, maxY: 605 });
  expect(bodyToWorld({ x: 0, y: 0, yawDeg: 0 }, 0, 10)).toEqual({ x: 0, y: 10 });
  const turned = bodyToWorld({ x: 0, y: 0, yawDeg: 90 }, 0, 10);
  expect(turned.x).toBeCloseTo(10);
  expect(turned.y).toBeCloseTo(0);
  expect(DT35_MOUNTS).toEqual([
    { xCm: -40.4, yCm: -3.3, yawOffsetDeg: -90 },
    { xCm: 40.4, yCm: -3.3, yawOffsetDeg: 90 },
  ]);
});

test("shows both persistent workspaces and a clear unsupported notice without Web Serial", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serial", { configurable: true, value: undefined });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
  await expect(page.getByText("当前浏览器不支持 Web Serial").first()).toBeVisible();
  await page.getByRole("button", { name: /定位地图/ }).click();
  await expect(page.getByRole("heading", { name: "定位地图" })).toBeVisible();
  await expect(page.getByText("冻结基线协议提供的原始融合结果")).toBeVisible();
  await page.getByRole("button", { name: /通信诊断/ }).click();
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
});

test("never offers serial write or control-signal actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("严格接收模式")).toBeVisible();
  await expect(page.getByRole("button", { name: /发送|写入|Ping|Zero|调参/ })).toHaveCount(0);
});
