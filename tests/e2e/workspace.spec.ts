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
        private readonly lines: string | string[],
        private readonly info: { usbVendorId: number; usbProductId: number },
      ) {}

      getInfo() { return this.info; }

      async open() {
        if (this.readable) throw new DOMException("port already open", "InvalidStateError");
        const lines = Array.isArray(this.lines) ? this.lines : [this.lines];
        let index = 0;
        let timer = 0;
        this.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            const emit = () => {
              controller.enqueue(new TextEncoder().encode(lines[index % lines.length]!));
              index += 1;
            };
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

    const cdbgV3 = (() => {
      const prefix = Array.from({ length: 87 }, (_, index) => String(index + 1));
      const extension = Array.from({ length: 61 }, () => "0");
      extension[18] = "0"; // taskFrameAgeMs
      extension[19] = "1"; // taskFrameCount
      extension[39] = "1"; // actionEnqueueOkCount
      extension[41] = "1"; // actionDequeueCount
      extension[42] = "0"; // actionDequeueAgeMs
      extension[43] = "1"; // mechTxStartCount
      extension[44] = "1"; // mechTxOkCount
      extension[47] = "3"; // mechTxLastDurationMs
      extension[48] = "0"; // mechTxLastStatus
      extension[52] = "1"; // mechFeedbackOkCount
      extension[55] = "0"; // mechFeedbackAgeMs
      extension[59] = "1"; // uart1RxByteCount
      extension[60] = "0"; // uart1RxByteAgeMs
      return ["CDBG", "3", "151", ...prefix, ...extension].join(",") + "\n";
    })();
    const ports = [
      new MockSerialPort([
        "RDBG,100,7,ACT,76,1,6,1,20,4,1,1,10,0,2,88,1,none\n",
        "RDBG_TX,1,120,8,ACT,5,5B02010101,1,6,875C02010101,0,1,2,1,1,1\n",
      ], { usbVendorId: 0x0483, usbProductId: 0x5740 }),
      new MockSerialPort([
        cdbgV3,
        "CEVT,MECH_CMD,130,1,2,1,1,1,1\n",
        "CEVT,MECH_CMD,140,3,2,1,1,1,0\n",
        "CEVT,MECH_TX,150,2,2,1,1,1,0,3\n",
        "CEVT,MECH_FB,160,1,2,1,1,1,5,5\n",
      ], { usbVendorId: 0x1a86, usbProductId: 0x7523 }),
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

async function installMapStrokeAudit(page: Page) {
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const beginPath = proto.beginPath;
    const lineTo = proto.lineTo;
    const stroke = proto.stroke;
    const pathLineCounts = new WeakMap<CanvasRenderingContext2D, number>();
    const latestByStyle: Record<string, number> = {};

    proto.beginPath = function beginPathWithAudit() {
      pathLineCounts.set(this, 0);
      return beginPath.call(this);
    };
    proto.lineTo = function lineToWithAudit(x: number, y: number) {
      pathLineCounts.set(this, (pathLineCounts.get(this) ?? 0) + 1);
      return lineTo.call(this, x, y);
    };
    proto.stroke = function strokeWithAudit(path?: Path2D) {
      latestByStyle[String(this.strokeStyle)] = pathLineCounts.get(this) ?? 0;
      return Reflect.apply(stroke, this, path === undefined ? [] : [path]);
    };
    Object.defineProperty(window, "__r1MapStrokeAudit", { configurable: true, value: latestByStyle });
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

test("keeps workspaces mounted and explains unsupported Web Serial", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
  await expect(page.getByText("实时串口需要桌面版 Chrome/Edge")).toBeVisible();
  const discoveryLauncher = page.getByRole("button", { name: "智能连接串口" }).first();
  await discoveryLauncher.click();
  await expect(page.getByRole("dialog", { name: "串口自动识别与绑定" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "串口自动识别与绑定" })).toBeHidden();

  await page.getByRole("button", { name: /定位地图/ }).click();
  await expect(page.getByRole("heading", { name: "定位地图" })).toBeVisible();
  await expect(page.getByLabel("R1 定位场地图")).toBeVisible();
  await expect(page.getByText("直接使用冻结 Python 上位机的原始场地图")).toBeVisible();

  await page.getByRole("button", { name: /遥控器窗口/ }).click();
  await expect(page.getByRole("heading", { name: "遥控器窗口" })).toBeVisible();
  await expect(page.getByLabel("遥控器串口侧栏")).toContainText("浏览器不支持 Web Serial");
  await expect(page.getByRole("button", { name: "智能识别串口" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "打开通信诊断全量串口" })).toBeVisible();
  await expect(page.getByText("当前命令")).toBeVisible();
  await expect(page.getByText("协议数组")).toBeVisible();

  await page.getByRole("button", { name: /数据示波器/ }).click();
  await expect(page.getByRole("heading", { name: "数据示波器" })).toBeVisible();
  await expect(page.getByText("VOFA 风格多变量时序波形")).toBeVisible();

  await page.getByRole("button", { name: /通信诊断/ }).click();
  await expect(page.getByRole("heading", { name: "双串口通信诊断" })).toBeVisible();
});

test("remote command window reuses communication demo data", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");
  await page.getByRole("button", { name: "演示数据" }).click();
  await page.getByRole("button", { name: /遥控器窗口/ }).click();
  await expect(page.getByRole("heading", { name: "遥控器窗口" })).toBeVisible();
  const remoteWindow = page.getByTestId("remote-control-workspace");
  await expect(remoteWindow.locator(".remote-hero > div:first-child > strong")).toContainText(/ADC|MODE|KEY|ACT/);
  await expect(remoteWindow.getByLabel("遥控器串口侧栏")).toContainText("遥控器数据正在刷新");
  await expect(remoteWindow.locator(".byte-strip code").first()).toBeVisible();
  await expect(remoteWindow.getByText("效果链路")).toBeVisible();
});

test("shows progress while stopping and downloading a local recording", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");

  await page.getByRole("button", { name: "开始三串口录制" }).click();
  await expect(page.getByRole("button", { name: "停止并后台下载" })).toBeVisible();
  const communicationDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "停止并后台下载" }).click();
  await expect(page.getByRole("button", { name: "开始三串口录制" })).toBeVisible();
  await page.getByRole("button", { name: "开始三串口录制" }).click();
  await expect(page.getByRole("button", { name: "停止并后台下载" })).toBeVisible();
  const communicationStatus = page.getByRole("status").filter({ hasText: "后台生成下载" });
  await expect(communicationStatus).toBeVisible();
  await expect(communicationStatus.getByRole("progressbar", { name: "录制下载进度" })).toBeVisible();
  await expect(communicationStatus).toContainText("100%");
  expect((await communicationDownload).suggestedFilename()).toMatch(/^global_/);

  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
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
  await expect(mapInfo.locator("xpath=..", { hasText: "Final、Calib、LiDAR 均显示机器人初始点相对轨迹" })).toBeVisible();
});

test("keeps locator values and trail samples start-relative while switching red and blue anchors", async ({ page }) => {
  await disableWebSerial(page);
  await installMapStrokeAudit(page);
  await page.setViewportSize({ width: 1366, height: 1400 });
  await page.goto("/");
  await page.getByRole("button", { name: /定位地图/ }).click();

  const workspace = page.getByTestId("locator-workspace");
  const official = workspace.getByRole("button", { name: "正式赛", exact: true });
  const preliminary = workspace.getByRole("button", { name: "预选赛", exact: true });
  const red = workspace.getByRole("button", { name: "红方", exact: true });
  const blue = workspace.getByRole("button", { name: "蓝方", exact: true });
  const canvas = workspace.locator(".field-canvas");
  await expect(official).toHaveAttribute("aria-pressed", "true");
  await expect(preliminary).toHaveAttribute("aria-pressed", "false");
  await expect(red).toHaveAttribute("aria-pressed", "true");
  await expect(blue).toHaveAttribute("aria-pressed", "false");
  await expect(canvas).toHaveAttribute("data-match-type", "official");
  await expect(canvas).toHaveAttribute("data-side", "red");

  await preliminary.click();
  await expect(official).toHaveAttribute("aria-pressed", "false");
  await expect(preliminary).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-match-type", "preliminary");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (!canvasBox) throw new Error("missing field canvas");
  const mapScale = Math.min((canvasBox.width - 48) / 1215, (canvasBox.height - 48) / 1210);
  await page.mouse.move(
    canvasBox.x + canvasBox.width / 2 - 547.5 * mapScale,
    canvasBox.y + canvasBox.height / 2 + 259.5 * mapScale,
  );
  const coordinateStatus = workspace.locator(".map-coordinate-status");
  await expect(coordinateStatus).toContainText("预选赛红方 9gong 起点");
  await expect(coordinateStatus).toContainText("中心 x=-547.5 cm · y=-259.5 cm");
  await expect(coordinateStatus).toContainText("距 R1 通道边线 60.0 cm · 距树林下边界 64.5 cm");
  await official.click();
  await expect(canvas).toHaveAttribute("data-match-type", "official");

  const raw = [
    "0.000,0.000,0.000,0.000,0.000,0.000,0.000,0.000,0.000,850.000,1180.000,110",
    "10.000,5.000,3.000,9.000,4.000,2.000,8.000,3.000,2.500,860.000,1170.000,110",
    "20.000,10.000,6.000,18.000,9.000,5.000,17.000,8.000,5.500,870.000,1160.000,110",
  ].join("\n");
  await workspace.locator("input[type=file]").setInputFiles({
    name: "raw_serial.log",
    mimeType: "text/plain",
    buffer: Buffer.from(raw, "utf8"),
  });
  const step = workspace.getByRole("button", { name: "单步", exact: true });
  await step.click();
  await step.click();
  await step.click();

  const poseValues = workspace.locator(".pose-primary strong");
  await expect(poseValues.nth(0)).toHaveText("20.00");
  await expect(poseValues.nth(1)).toHaveText("10.00");
  await expect(poseValues.nth(2)).toHaveText("6.00");
  const redPose = await poseValues.allTextContents();
  const redTrailSegments = await page.evaluate(() => {
    const audit = (window as Window & { __r1MapStrokeAudit?: Record<string, number> }).__r1MapStrokeAudit;
    return audit?.["rgba(0, 255, 170, 0.82)"] ?? -1;
  });
  expect(redTrailSegments).toBe(2);

  await preliminary.click();
  await expect(official).toHaveAttribute("aria-pressed", "false");
  await expect(preliminary).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-match-type", "preliminary");
  await expect(poseValues).toHaveText(redPose);
  await official.click();
  await expect(canvas).toHaveAttribute("data-match-type", "official");

  await blue.click();
  await expect(red).toHaveAttribute("aria-pressed", "false");
  await expect(blue).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-side", "blue");
  await expect(poseValues).toHaveText(redPose);
  const blueTrailSegments = await page.evaluate(() => {
    const audit = (window as Window & { __r1MapStrokeAudit?: Record<string, number> }).__r1MapStrokeAudit;
    return audit?.["rgba(0, 255, 170, 0.82)"] ?? -1;
  });
  expect(blueTrailSegments).toBe(redTrailSegments);

  await page.reload();
  await page.getByRole("button", { name: /定位地图/ }).click();
  await expect(page.getByTestId("locator-workspace").getByRole("button", { name: "正式赛", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("locator-workspace").getByRole("button", { name: "红方", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("locator-workspace").locator(".field-canvas")).toHaveAttribute("data-match-type", "official");
  await expect(page.getByTestId("locator-workspace").locator(".field-canvas")).toHaveAttribute("data-side", "red");
});

test("starts locator demo near local zero and locks the side selector while recording", async ({ page }) => {
  await disableWebSerial(page);
  await page.goto("/");
  await page.getByRole("button", { name: /定位地图/ }).click();
  const workspace = page.getByTestId("locator-workspace");
  await page.clock.install({ time: new Date("2030-07-12T12:00:00Z") });
  await page.clock.pauseAt(new Date("2030-07-12T12:00:00Z"));
  await workspace.getByRole("button", { name: "演示轨迹", exact: true }).click();
  const poseValues = workspace.locator(".pose-primary strong");
  await expect(poseValues.nth(0)).toHaveText("0.00");
  await expect(poseValues.nth(1)).toHaveText("0.00");

  await page.getByRole("button", { name: "开始三串口录制", exact: true }).click();
  await expect(workspace.getByRole("button", { name: "正式赛", exact: true })).toBeDisabled();
  await expect(workspace.getByRole("button", { name: "预选赛", exact: true })).toBeDisabled();
  await expect(workspace.getByRole("button", { name: "红方", exact: true })).toBeDisabled();
  await expect(workspace.getByRole("button", { name: "蓝方", exact: true })).toBeDisabled();
  await expect(workspace.getByText("录制中已锁定比赛类型和阵营", { exact: true })).toBeVisible();
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

  await page.getByRole("button", { name: "智能连接串口" }).first().click();
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
  await page.getByRole("button", { name: /遥控器窗口/ }).click();
  const remotePanel = page.getByTestId("remote-control-workspace").getByLabel("遥控器串口侧栏");
  await expect(remotePanel).toContainText("遥控器串口正在接收");
  await expect(remotePanel).toContainText("数据正常");
  await expect(remotePanel.getByRole("button", { name: "断开" })).toBeVisible();
  const remoteWorkspace = page.getByTestId("remote-control-workspace");
  await expect(remoteWorkspace.locator(".remote-hero")).toContainText("当前动作指令");
  await expect(remoteWorkspace.locator(".remote-hero > div:first-child > strong")).toContainText("ACT");
  await expect(remoteWorkspace.locator(".remote-hero")).toContainText(/echo 匹配|机构反馈对齐/);
  await expect(remoteWorkspace.locator(".protocol-panel .remote-args")).toContainText("state");
  await expect(remoteWorkspace.locator(".protocol-panel .remote-args")).toContainText("enabled");
  await expect(remoteWorkspace.locator(".effect-panel")).toContainText("底盘接收 ACT");
  await expect(remoteWorkspace.locator(".effect-panel")).toContainText("ACT 队列");
  await expect(remoteWorkspace.locator(".effect-panel")).toContainText("USART1 发给机构");
  await expect(remoteWorkspace.locator(".effect-panel")).toContainText("MECH_TX done");
  await expect(remoteWorkspace.locator(".effect-panel")).toContainText("机构有效反馈");
  await expect(remoteWorkspace.locator(".mechanism-live-panel")).toContainText("机构反馈实况");
  await expect(remoteWorkspace.locator(".mechanism-live-panel")).toContainText("机构有效回传");
  await expect(remoteWorkspace.locator(".mechanism-live-panel")).toContainText("state");
  await expect(remoteWorkspace.locator(".mechanism-live-panel")).toContainText("stage");
  await expect(remoteWorkspace.locator(".remote-context-grid")).toContainText("v3/151");
  await expect(remoteWorkspace.locator(".remote-tx-row.type-act").first()).toContainText("state=2 stage=1 exec=1 enabled=1");
  await page.getByRole("button", { name: /定位地图/ }).click();
  await expect(page.getByRole("button", { name: "演示轨迹" })).toBeVisible();
  await expect(page.locator(".workspace-host.active").getByText("正在接收")).toHaveCount(1);
});
