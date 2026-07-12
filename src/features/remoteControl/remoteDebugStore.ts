import { useSyncExternalStore } from "react";
import type { PortSnapshot } from "../../core/serial";
import type { ProtocolEvent, SourceRole } from "../../core/types";
import type { ChassisFrame, RemoteFrame, RemoteTxEvent } from "../../protocols";
import type { DiagnosticEvent } from "../communication/eventDetector";

export interface RemoteDebugLogEntry {
  at: number;
  role: SourceRole;
  line: string;
  result: string;
}

export interface RemoteDebugPortState {
  supported: boolean;
  snapshot: PortSnapshot | null;
  controlsReady: boolean;
}

export interface RemoteDebugState {
  latestRemote: RemoteFrame | null;
  latestChassis: ChassisFrame | null;
  latestTx: RemoteTxEvent | null;
  ports: Record<SourceRole, RemoteDebugPortState>;
  txEvents: RemoteTxEvent[];
  chassisEvents: ProtocolEvent[];
  firmwareEvents: DiagnosticEvent[];
  parseErrors: DiagnosticEvent[];
  logs: RemoteDebugLogEntry[];
  revision: number;
}

const EMPTY_PORT_STATE: RemoteDebugPortState = {
  supported: false,
  snapshot: null,
  controlsReady: false,
};

export interface RemoteDebugPortActions {
  select(): void | Promise<void>;
  connect(): void | Promise<void>;
  close(): void | Promise<void>;
}

const INITIAL_STATE: RemoteDebugState = {
  latestRemote: null,
  latestChassis: null,
  latestTx: null,
  ports: {
    remote: EMPTY_PORT_STATE,
    chassis: EMPTY_PORT_STATE,
    locator: EMPTY_PORT_STATE,
  },
  txEvents: [],
  chassisEvents: [],
  firmwareEvents: [],
  parseErrors: [],
  logs: [],
  revision: 0,
};

class RemoteDebugStore {
  private state = INITIAL_STATE;
  private readonly portActions: Partial<Record<SourceRole, RemoteDebugPortActions>> = {};
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): RemoteDebugState => this.state;

  publishRemote(frame: RemoteFrame): void {
    this.patch({ latestRemote: frame });
  }

  publishChassis(frame: ChassisFrame): void {
    this.patch({ latestChassis: frame });
  }

  publishTx(event: RemoteTxEvent): void {
    this.patch({
      latestTx: event,
      txEvents: [...this.state.txEvents, event].slice(-200),
    });
  }

  publishChassisEvent(event: ProtocolEvent): void {
    this.patch({ chassisEvents: [...this.state.chassisEvents, event].slice(-300) });
  }

  publishPort(role: SourceRole, supported: boolean, snapshot: PortSnapshot): void {
    const previous = this.state.ports[role];
    this.patch({
      ports: {
        ...this.state.ports,
        [role]: { ...previous, supported, snapshot },
      },
    });
  }

  registerPortActions(role: SourceRole, actions: RemoteDebugPortActions): () => void {
    this.portActions[role] = actions;
    this.patch({
      ports: {
        ...this.state.ports,
        [role]: { ...this.state.ports[role], controlsReady: true },
      },
    });
    return () => {
      if (this.portActions[role] !== actions) return;
      delete this.portActions[role];
      this.patch({
        ports: {
          ...this.state.ports,
          [role]: { ...this.state.ports[role], controlsReady: false },
        },
      });
    };
  }

  async selectPort(role: SourceRole): Promise<void> {
    await this.portActions[role]?.select();
  }

  async connectPort(role: SourceRole): Promise<void> {
    await this.portActions[role]?.connect();
  }

  async closePort(role: SourceRole): Promise<void> {
    await this.portActions[role]?.close();
  }

  publishFirmwareEvent(event: DiagnosticEvent): void {
    this.patch({ firmwareEvents: [...this.state.firmwareEvents, event].slice(-300) });
  }

  publishParseError(event: DiagnosticEvent): void {
    this.patch({ parseErrors: [...this.state.parseErrors, event].slice(-120) });
  }

  publishLog(entry: RemoteDebugLogEntry): void {
    this.patch({ logs: [...this.state.logs, entry].slice(-500) });
  }

  clear(): void {
    this.state = { ...INITIAL_STATE, ports: this.state.ports, revision: this.state.revision + 1 };
    this.emit();
  }

  clearRemote(): void {
    this.patch({ latestRemote: null, latestTx: null, txEvents: [] });
  }

  clearChassis(): void {
    this.patch({ latestChassis: null, chassisEvents: [] });
  }

  private patch(next: Partial<Omit<RemoteDebugState, "revision">>): void {
    this.state = { ...this.state, ...next, revision: this.state.revision + 1 };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const remoteDebugStore = new RemoteDebugStore();

export function useRemoteDebugState(): RemoteDebugState {
  return useSyncExternalStore(remoteDebugStore.subscribe, remoteDebugStore.snapshot, remoteDebugStore.snapshot);
}
