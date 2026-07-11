import type { PortSnapshot, ReadOnlySerialPort } from "../../core/serial";
import type { SourceRole } from "../../core/types";

export interface RegisteredSerialSession {
  snapshot(): PortSnapshot;
  bindAndConnect(port: ReadOnlySerialPort): Promise<void>;
  disconnectAndRelease(): Promise<void>;
}

export interface RegistryBindResult {
  ok: boolean;
  role: SourceRole;
  message: string;
}

const BUSY_LIFECYCLES = new Set(["requesting", "opening", "reading", "closing"]);
const ROLE_NAMES: Record<SourceRole, string> = { remote: "遥控器", chassis: "底盘", locator: "定位/码盘板" };

/**
 * Bridges the app-level discovery dialog to the three PortSession hooks without
 * coupling the workspaces together. Port identity is the SerialPort object
 * supplied by the browser, which is stable within the page lifetime.
 */
export class SerialSessionRegistry {
  private readonly sessions = new Map<SourceRole, RegisteredSerialSession>();
  private readonly portOwners = new Map<ReadOnlySerialPort, SourceRole>();
  private readonly rolePorts = new Map<SourceRole, ReadOnlySerialPort>();

  register(role: SourceRole, session: RegisteredSerialSession): () => void {
    this.sessions.set(role, session);
    return () => {
      if (this.sessions.get(role) !== session) return;
      this.sessions.delete(role);
      const port = this.rolePorts.get(role);
      if (port) this.portOwners.delete(port);
      this.rolePorts.delete(role);
    };
  }

  ownerOf(port: ReadOnlySerialPort): SourceRole | null {
    return this.portOwners.get(port) ?? null;
  }

  isClaimed(port: ReadOnlySerialPort): boolean {
    return this.portOwners.has(port);
  }

  claimPort(role: SourceRole, port: ReadOnlySerialPort): RegistryBindResult {
    const owner = this.portOwners.get(port);
    if (owner && owner !== role) {
      return { ok: false, role, message: `该串口已经绑定到${ROLE_NAMES[owner]}，不能重复使用。` };
    }
    const previous = this.rolePorts.get(role);
    if (previous && previous !== port) this.portOwners.delete(previous);
    this.portOwners.set(port, role);
    this.rolePorts.set(role, port);
    return { ok: true, role, message: "串口占用登记成功。" };
  }

  canAutoBind(role: SourceRole, port: ReadOnlySerialPort): RegistryBindResult {
    const session = this.sessions.get(role);
    if (!session) return { ok: false, role, message: "对应工作区尚未就绪。" };
    const owner = this.portOwners.get(port);
    if (owner && owner !== role) return { ok: false, role, message: `该串口已绑定到${ROLE_NAMES[owner]}。` };
    const snapshot = session.snapshot();
    if (BUSY_LIFECYCLES.has(snapshot.lifecycle)) {
      return { ok: false, role, message: `${ROLE_NAMES[role]}会话正在工作（${snapshot.lifecycle}），不会替换现有连接。` };
    }
    return { ok: true, role, message: "可以自动绑定。" };
  }

  async bindAndConnect(role: SourceRole, port: ReadOnlySerialPort, signal?: AbortSignal): Promise<RegistryBindResult> {
    if (signal?.aborted) return { ok: false, role, message: "探测已取消，未绑定串口。" };
    const allowed = this.canAutoBind(role, port);
    if (!allowed.ok) return allowed;
    const session = this.sessions.get(role);
    if (!session) return { ok: false, role, message: "对应工作区尚未就绪。" };
    const claimed = this.claimPort(role, port);
    if (!claimed.ok) return claimed;
    try {
      await session.bindAndConnect(port);
      if (signal?.aborted) {
        await session.disconnectAndRelease();
        if (this.portOwners.get(port) === role) this.portOwners.delete(port);
        if (this.rolePorts.get(role) === port) this.rolePorts.delete(role);
        return { ok: false, role, message: "探测已取消，晚到的串口连接已关闭。" };
      }
      return { ok: true, role, message: "已自动绑定并开始只读接收。" };
    } catch (error) {
      await session.disconnectAndRelease().catch(() => undefined);
      if (this.portOwners.get(port) === role) this.portOwners.delete(port);
      if (this.rolePorts.get(role) === port) this.rolePorts.delete(role);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, role, message: `绑定后打开失败：${message}。已释放占用，可重新探测。` };
    }
  }
}

export const serialSessionRegistry = new SerialSessionRegistry();
