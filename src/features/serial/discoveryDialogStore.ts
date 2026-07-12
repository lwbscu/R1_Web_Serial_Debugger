type Listener = () => void;

class DiscoveryDialogStore {
  private requestId = 0;
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.requestId;

  requestOpen(): void {
    this.requestId += 1;
    this.listeners.forEach((listener) => listener());
  }
}

export const discoveryDialogStore = new DiscoveryDialogStore();

export function requestOpenSerialDiscovery(): void {
  discoveryDialogStore.requestOpen();
}
