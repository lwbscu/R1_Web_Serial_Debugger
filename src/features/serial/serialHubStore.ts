import { useSyncExternalStore } from "react";
import type { LocatorCoordinateContext } from "../../core/locator";
import type { PortSnapshot } from "../../core/serial";
import type { SourceRole } from "../../core/types";

export const SERIAL_ROLE_LABELS: Record<SourceRole, string> = {
  remote: "遥控器",
  chassis: "底盘",
  locator: "码盘/定位板",
};

export const SERIAL_ROLE_ORDER: readonly SourceRole[] = ["remote", "chassis", "locator"];

export interface SerialHubRoleState {
  supported: boolean;
  snapshot: PortSnapshot | null;
  controlsReady: boolean;
  lastAutoMessage: string | null;
}

export interface SerialHubState {
  roles: Record<SourceRole, SerialHubRoleState>;
  locatorCoordinates: LocatorCoordinateContext | null;
  revision: number;
}

export interface SerialHubPortActions {
  select(): void | Promise<void>;
  connect(): void | Promise<void>;
  close(): void | Promise<void>;
}

const EMPTY_ROLE_STATE: SerialHubRoleState = {
  supported: false,
  snapshot: null,
  controlsReady: false,
  lastAutoMessage: null,
};

const INITIAL_STATE: SerialHubState = {
  roles: {
    remote: EMPTY_ROLE_STATE,
    chassis: EMPTY_ROLE_STATE,
    locator: EMPTY_ROLE_STATE,
  },
  locatorCoordinates: null,
  revision: 0,
};

class SerialHubStore {
  private state = INITIAL_STATE;
  private readonly actions: Partial<Record<SourceRole, SerialHubPortActions>> = {};
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): SerialHubState => this.state;

  publishPort(role: SourceRole, supported: boolean, snapshot: PortSnapshot): void {
    const previous = this.state.roles[role];
    this.patchRole(role, { ...previous, supported, snapshot });
  }

  publishAutoMessage(role: SourceRole, message: string | null): void {
    this.patchRole(role, { ...this.state.roles[role], lastAutoMessage: message });
  }

  publishLocatorCoordinates(locatorCoordinates: LocatorCoordinateContext): void {
    this.patch({ locatorCoordinates });
  }

  registerPortActions(role: SourceRole, actions: SerialHubPortActions): () => void {
    this.actions[role] = actions;
    this.patchRole(role, { ...this.state.roles[role], controlsReady: true });
    return () => {
      if (this.actions[role] !== actions) return;
      delete this.actions[role];
      this.patchRole(role, { ...this.state.roles[role], controlsReady: false });
    };
  }

  async selectPort(role: SourceRole): Promise<void> {
    await this.actions[role]?.select();
  }

  async connectPort(role: SourceRole): Promise<void> {
    await this.actions[role]?.connect();
  }

  async closePort(role: SourceRole): Promise<void> {
    await this.actions[role]?.close();
  }

  private patchRole(role: SourceRole, value: SerialHubRoleState): void {
    this.patch({ roles: { ...this.state.roles, [role]: value } });
  }

  private patch(next: Partial<Omit<SerialHubState, "revision">>): void {
    this.state = { ...this.state, ...next, revision: this.state.revision + 1 };
    this.listeners.forEach((listener) => listener());
  }
}

export const serialHubStore = new SerialHubStore();

export function useSerialHubState(): SerialHubState {
  return useSyncExternalStore(serialHubStore.subscribe, serialHubStore.snapshot, serialHubStore.snapshot);
}
