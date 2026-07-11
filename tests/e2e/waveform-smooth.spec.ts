import { expect, test } from "@playwright/test";

test("smooth slider is display-only, keyboard accessible, responsive, and independent from axis reset", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serial", { configurable: true, value: undefined });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /数据示波器/ }).click();

  const smooth = page.getByRole("slider", { name: "曲线平滑" });
  await expect(smooth).toHaveAttribute("min", "0");
  await expect(smooth).toHaveAttribute("max", "1");
  await expect(smooth).toHaveAttribute("step", "0.01");
  await expect(smooth).toHaveValue("0");
  await expect(smooth).toHaveAttribute("aria-valuetext", /0\.00，?仅影响显示/);

  await smooth.focus();
  await page.keyboard.press("ArrowRight");
  await expect(smooth).toHaveValue("0.01");
  await smooth.fill("1");
  await expect(smooth).toHaveAttribute("aria-valuetext", /1\.00，?仅影响显示/);

  await page.getByRole("button", { name: "复位双轴" }).click();
  await expect(smooth).toHaveValue("1");

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(smooth).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);

  await page.reload();
  await page.getByRole("button", { name: /数据示波器/ }).click();
  await expect(page.getByRole("slider", { name: "曲线平滑" })).toHaveValue("0");
});
