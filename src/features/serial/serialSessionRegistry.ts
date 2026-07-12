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

export interface SerialRegistryEvent {
  type: "bound" | "migrated";
  role: SourceRole;
  fromRole?: SourceRole;
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
  private readonly listeners = new Set<(event: SerialRegistryEvent) => void>();

  subscribe(listener: (event: SerialRegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

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

  rolePort(role: SourceRole): ReadOnlySerialPort | null {
    return this.rolePorts.get(role) ?? null;
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
      const result = { ok: true, role, message: "已自动绑定并开始只读接收。" };
      this.emit({ type: "bound", role, message: result.message });
      return result;
    } catch (error) {
      await session.disconnectAndRelease().catch(() => undefined);
      if (this.portOwners.get(port) === role) this.portOwners.delete(port);
      if (this.rolePorts.get(role) === port) this.rolePorts.delete(role);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, role, message: `绑定后打开失败：${message}。已释放占用，可重新探测。` };
    }
  }

  async migrateClaimedPort(fromRole: SourceRole, toRole: SourceRole): Promise<RegistryBindResult> {
    if (fromRole === toRole) return { ok: true, role: toRole, message: "已在正确角色，无需迁移。" };
    const port = this.rolePorts.get(fromRole);
    if (!port) return { ok: false, role: toRole, message: `${ROLE_NAMES[fromRole]}没有可迁移串口。` };
    const fromSession = this.sessions.get(fromRole);
    const targetSession = this.sessions.get(toRole);
    if (!fromSession || !targetSession) return { ok: false, role: toRole, message: "迁移所需工作区尚未就绪。" };
    const targetSnapshot = targetSession.snapshot();
    if (BUSY_LIFECYCLES.has(targetSnapshot.lifecycle)) {
      return { ok: false, role: toRole, message: `${ROLE_NAMES[toRole]}会话正在工作（${targetSnapshot.lifecycle}），不会抢占迁移。` };
    }
    await fromSession.disconnectAndRelease().catch(() => undefined);
    if (this.portOwners.get(port) === fromRole) this.portOwners.delete(port);
    if (this.rolePorts.get(fromRole) === port) this.rolePorts.delete(fromRole);
    const result = await this.bindAndConnect(toRole, port);
    if (result.ok) {
      const message = `检测到${ROLE_NAMES[toRole]}协议，已从${ROLE_NAMES[fromRole]}自动迁移。`;
      this.emit({ type: "migrated", fromRole, role: toRole, message });
      return { ...result, message };
    }
    return result;
  }

  private emit(event: SerialRegistryEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }

  async migrateWrongRole(from: SourceRole, to: SourceRole, port: ReadOnlySerialPort): Promise<RegistryBindResult> {
    if (from === to) return { ok: false, role: to, message: "目标角色与当前角色相同，未迁移。" };
    if (this.portOwners.get(port) !== from || this.rolePorts.get(from) !== port) {
      return { ok: false, role: to, message: "串口归属已变化，取消自动迁移。" };
    }
    const fromSession = this.sessions.get(from);
    const toSession = this.sessions.get(to);
    if (!fromSession || !toSession) return { ok: false, role: to, message: "源或目标工作区尚未就绪。" };
    const targetSnapshot = toSession.snapshot();
    if (BUSY_LIFECYCLES.has(targetSnapshot.lifecycle) || targetSnapshot.selected) {
      return { ok: false, role: to, message: `${ROLE_NAMES[to]}已有连接或正在工作，未抢占。` };
    }

    try {
      await fromSession.disconnectAndRelease();
      if (this.portOwners.get(port) === from) this.portOwners.delete(port);
      if (this.rolePorts.get(from) === port) this.rolePorts.delete(from);
      this.portOwners.set(port, to);
      this.rolePorts.set(to, port);
      await toSession.bindAndConnect(port);
      const message = `检测到${ROLE_NAMES[to]}协议，已从${ROLE_NAMES[from]}自动迁移。`;
      this.emit({ type: "migrated", fromRole: from, role: to, message });
      return { ok: true, role: to, message };
    } catch (error) {
      await toSession.disconnectAndRelease().catch(() => undefined);
      if (this.portOwners.get(port) === to) this.portOwners.delete(port);
      if (this.rolePorts.get(to) === port) this.rolePorts.delete(to);
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, role: to, message: `自动迁移失败：${message}` };
    }
  }
}

export const serialSessionRegistry = new SerialSessionRegistry();
