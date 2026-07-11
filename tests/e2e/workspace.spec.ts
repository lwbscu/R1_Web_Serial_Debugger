import { expect, test, type Page } from "@playwright/test";
import { bodyToWorld, DT35_MOUNTS, FIELD_BOUNDS } from "../../src/features/locator/geometry";

async function disableWebSerial(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serial", { configurable: true, value: undefined });
  });
}

async function installMockSerial(page: Page) {
  await page.addInitScript(() => {
    class MockSerialPort {
      readable: ReadableStream<Uint8Array> | null = null;
      private stop: (() => void) | null = null;

      constructor(
        private readonly line: string,
        private readonly info: { usbVendorId: number; usbProductId: number },
      ) {}

      getInfo() { return this.info; }

      async open() {
        if (this.readable) throw new DOMException("port already open", "InvalidStateError");
        const line = this.line;
        let timer = 0;
        this.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            const emit = () => controller.enqueue(new TextEncoder().encode(line));
            emit();
            timer = window.setInterval(emit, 20);
          },
          cancel() { window.clearInterval(timer); },
        });
        this.stop = () => window.clearInterval(timer);
      }

      async close() {
        this.stop?.();
        this.stop = null;
        this.readable = null;
      }
    }

    const cdbg = ["CDBG", ...Array.from({ length: 29 }, (_, index) => String(index + 1))].join(",") + "\n";
    const ports = [
      new MockSerialPort("RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none\n", { usbVendorId: 0x0483, usbProductId: 0x5740 }),
      new MockSerialPort(cdbg, { usbVendorId: 0x1a86, usbProductId: 0x7523 }),
      new MockSerialPort("1,2,3,4,5,6,7,8,9,190,5221,114\n", { usbVendorId: 0x10c4, usbProductId: 0xea60 }),
    ];
    let next = 0;
    Object.defineProperty(navigator, "serial", {
      configurable: true,
      value: {
        getPorts: async () => ports,
        requestPort: async () => ports[next++ % ports.length],
      },
    });
  });
}

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

test("keeps three workspaces mounted and explains unsupported Web Serial", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
  await expect(page.getByText("实时串口需要桌面版 Chrome/Edge")).toBeVisible();
  const discoveryLauncher = page.getByRole("button", { name: /自动识别串口/ });
  await discoveryLauncher.click();
  await expect(page.getByRole("dialog", { name: "串口自动识别与绑定" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "串口自动识别与绑定" })).toBeHidden();
  await expect(discoveryLauncher).toBeFocused();

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
  await disableWebSerial(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const serialInfo = page.getByRole("button", { name: "遥控器 / RDBG 设备标识说明" });
  await serialInfo.hover();
  const serialTip = page.getByRole("tooltip").filter({ hasText: "不能可靠读取 Windows 的 COM 号" });
  await expect(serialTip).toBeVisible();
  await expect(serialTip).toHaveCSS("white-space", "normal");
  const serialTipHitTest = await serialTip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const connection = element.closest<HTMLElement>(".serial-connection");
    return {
      visible: hit === element || (hit !== null && element.contains(hit)),
      hit: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : String(hit),
      hitText: hit?.textContent?.slice(0, 80) ?? "",
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      connectionZ: connection ? getComputedStyle(connection).zIndex : "missing",
    };
  });
  expect(serialTipHitTest.visible, JSON.stringify(serialTipHitTest)).toBeTruthy();
  await page.getByRole("button", { name: "演示数据" }).click();
  await expect(page.locator(".diagnostic-metric").filter({ hasText: "CDBG version" })).toContainText("v3, 151 fields");
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

  const xZoom = page.getByRole("slider", { name: "横轴缩放" });
  const yZoom = page.getByRole("slider", { name: "纵轴缩放" });
  await xZoom.fill("100");
  await yZoom.fill("50");
  await expect(xZoom).toHaveAttribute("aria-valuetext", /μs|ms/);
  await expect(yZoom).toHaveAttribute("aria-valuetext", /放大 100×/);
  await page.getByRole("button", { name: "复位双轴" }).click();

  const plotOverlay = page.locator(".uplot-waveform .u-over");
  const box = await plotOverlay.boundingBox();
  expect(box).not.toBeNull();
  const curveTip = page.locator(".wave-series-tooltip.curve");
  if (box) {
    // First establish an x-index, then use uPlot's own visible cursor marker
    // to hit the rendered curve deterministically instead of scanning pixels.
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .5);
    const cursorPoint = page.locator(".uplot-waveform .u-cursor-pt:not(.u-off)").first();
    await expect(cursorPoint).toBeVisible();
    const pointBox = await cursorPoint.boundingBox();
    expect(pointBox).not.toBeNull();
    if (pointBox) await page.mouse.move(pointBox.x + pointBox.width / 2, pointBox.y + pointBox.height / 2);
  }
  await expect(curveTip).toBeVisible();
  await expect(curveTip).toContainText("来源");
  await expect(curveTip).toContainText(/ACK|信号|发送失败|丢包/);
});

test("loads the frozen map assets and draws the robot demo", async ({ page }) => {
  await disableWebSerial(page);
  const responses: string[] = [];
  page.on("response", (response) => { if (response.url().includes("/assets/map/")) responses.push(response.url()); });
  await page.goto("/");
  await page.getByRole("button", { name: /定位地图/ }).click();
  await page.getByRole("button", { name: "演示轨迹" }).click();
  await expect(page.getByText("DT35-1").last()).toBeVisible();
  await expect.poll(() => responses.some((url) => url.endsWith("field_prior_map_clean_labeled_1215x1210cm.png"))).toBeTruthy();
  await expect.poll(() => responses.some((url) => url.endsWith("r1_chassis_830mm_texture_1024.png"))).toBeTruthy();
  const mapInfo = page.getByRole("button", { name: "地图图例与坐标说明" });
  await mapInfo.hover();
  await expect(mapInfo.locator("xpath=..", { hasText: "Final 是融合后定位" })).toBeVisible();
});

test("locator layout has no page-level horizontal overflow at supported breakpoints", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");
  await page.getByRole("button", { name: /定位地图/ }).click();
  for (const width of [1600, 1440, 1366, 1201, 900, 680, 375]) {
    await page.setViewportSize({ width, height: width <= 680 ? 812 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `width ${width}px overflowed` }).toBeTruthy();
  }
});

test("never offers serial write or control-signal actions", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");
  await expect(page.getByText("严格接收模式")).toBeVisible();
  await expect(page.getByRole("button", { name: /^(发送|写入|Ping|Zero|调参)$/i })).toHaveCount(0);
});

test("read-only probes three authorized ports and auto-binds unique roles", async ({ page }) => {
  await installMockSerial(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  await page.getByRole("button", { name: "演示数据" }).click();
  await page.getByRole("button", { name: /定位地图/ }).click();
  await page.getByRole("button", { name: "演示轨迹" }).click();
  await page.getByRole("button", { name: /通信诊断/ }).click();

  await page.getByRole("button", { name: /自动识别串口/ }).click();
  await expect(page.getByRole("dialog", { name: "串口自动识别与绑定" })).toBeVisible();
  await expect(page.getByText("标准接口不会返回 COM7")).toBeVisible();
  await page.getByRole("button", { name: "批量探测已授权串口" }).click();
  await expect(page.getByRole("status")).toContainText("3 个已自动绑定并连接", { timeout: 10_000 });
  await expect(page.locator(".asd-result")).toHaveCount(3);
  await expect(page.locator(".asd-result")).toContainText(["遥控器", "底盘", "定位/码盘板"]);
  await expect(page.getByText("已自动绑定并开始只读接收。")).toHaveCount(3);

  const aliases = page.getByLabel("COM 别名（可选，由你确认后填写）");
  await aliases.first().fill("COM7");
  await expect(page.locator(".asd-result").first()).toContainText("COM7");
  await page.getByRole("button", { name: "关闭" }).click();

  await expect(page.getByRole("button", { name: "演示数据" })).toBeVisible();
  await expect(page.locator(".workspace-host.active").getByText("正在接收")).toHaveCount(2);
  await page.getByRole("button", { name: /定位地图/ }).click();
  await expect(page.getByRole("button", { name: "演示轨迹" })).toBeVisible();
  await expect(page.locator(".workspace-host.active").getByText("正在接收")).toHaveCount(1);
});
