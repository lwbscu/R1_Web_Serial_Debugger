import { describe, expect, it, vi } from "vitest";
import type { PortLifecycle, SourceRole } from "../../src/core/types";
import type { PortSnapshot, ReadOnlySerialPort } from "../../src/core/serial";
import { SerialSessionRegistry } from "../../src/features/serial/serialSessionRegistry";

function port(): ReadOnlySerialPort {
  return { readable: null, async open() {}, async close() {} };
}

function snapshot(role: SourceRole, lifecycle: PortLifecycle = "idle"): PortSnapshot {
  return {
    role, lifecycle, health: "no-data", selected: lifecycle === "reading", portInfo: null,
    lastByteAtMs: null, lastValidFrameAtMs: null, detectedRole: null, error: null,
    stats: { bytesReceived: 0, linesReceived: 0, validFrames: 0, parseErrors: 0, ignoredLines: 0, wrongRoleLines: 0 },
  };
}

describe("自动识别后的会话绑定注册表", () => {
  it("将唯一空闲角色绑定并连接到对应常驻会话", async () => {
    const registry = new SerialSessionRegistry();
    const selected = port();
    const bindAndConnect = vi.fn(async () => undefined);
    registry.register("remote", { snapshot: () => snapshot("remote"), bindAndConnect, disconnectAndRelease: async () => undefined });

    const result = await registry.bindAndConnect("remote", selected);

    expect(result).toMatchObject({ ok: true, role: "remote" });
    expect(bindAndConnect).toHaveBeenCalledWith(selected);
    expect(registry.ownerOf(selected)).toBe("remote");
  });

  it("不会把同一个浏览器串口重复交给另一个角色", async () => {
    const registry = new SerialSessionRegistry();
    const selected = port();
    registry.register("remote", { snapshot: () => snapshot("remote"), bindAndConnect: async () => undefined, disconnectAndRelease: async () => undefined });
    registry.register("chassis", { snapshot: () => snapshot("chassis"), bindAndConnect: async () => undefined, disconnectAndRelease: async () => undefined });
    expect(registry.claimPort("remote", selected).ok).toBe(true);

    const result = await registry.bindAndConnect("chassis", selected);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("已绑定");
    expect(registry.ownerOf(selected)).toBe("remote");
  });

  it.each(["requesting", "opening", "reading", "closing"] as const)("目标会话处于 %s 时不替换现有连接", async (lifecycle) => {
    const registry = new SerialSessionRegistry();
    const bindAndConnect = vi.fn(async () => undefined);
    registry.register("locator", { snapshot: () => snapshot("locator", lifecycle), bindAndConnect, disconnectAndRelease: async () => undefined });

    const result = await registry.bindAndConnect("locator", port());

    expect(result.ok).toBe(false);
    expect(result.message).toContain(lifecycle);
    expect(bindAndConnect).not.toHaveBeenCalled();
  });

  it("绑定打开失败时回滚新占用，允许用户修复后重新探测", async () => {
    const registry = new SerialSessionRegistry();
    const selected = port();
    const disconnectAndRelease = vi.fn(async () => undefined);
    registry.register("locator", { snapshot: () => snapshot("locator"), bindAndConnect: async () => { throw new Error("busy"); }, disconnectAndRelease });

    const result = await registry.bindAndConnect("locator", selected);

    expect(result).toMatchObject({ ok: false, role: "locator" });
    expect(result.message).toContain("busy");
    expect(result.message).toContain("重新探测");
    expect(registry.ownerOf(selected)).toBeNull();
    expect(registry.isClaimed(selected)).toBe(false);
    expect(disconnectAndRelease).toHaveBeenCalledOnce();
  });

  it("取消发生在连接完成前后都不会留下晚到绑定", async () => {
    const registry = new SerialSessionRegistry();
    const selected = port();
    let finishBind!: () => void;
    const bindGate = new Promise<void>((resolve) => { finishBind = resolve; });
    const disconnectAndRelease = vi.fn(async () => undefined);
    registry.register("remote", { snapshot: () => snapshot("remote"), bindAndConnect: () => bindGate, disconnectAndRelease });
    const controller = new AbortController();
    const pending = registry.bindAndConnect("remote", selected, controller.signal);
    controller.abort();
    finishBind();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, role: "remote" });
    expect(result.message).toContain("已关闭");
    expect(disconnectAndRelease).toHaveBeenCalledOnce();
    expect(registry.ownerOf(selected)).toBeNull();
  });
});
