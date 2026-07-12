import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProtocolAdapter, SourceRole } from "../../core/types";
import { browserSerialProvider, PortSession, probePort, supportsWebSerial, type PortSnapshot, type ReceivedLine } from "../../core/serial";
import { serialSessionRegistry } from "./serialSessionRegistry";
import { serialHubStore, SERIAL_ROLE_LABELS } from "./serialHubStore";

const SNAPSHOT_COALESCE_MS = 100;

const emptySnapshot = (role: SourceRole): PortSnapshot => ({
  role, lifecycle: "idle", health: "no-data", selected: false,
  portInfo: null,
  lastByteAtMs: null, lastValidFrameAtMs: null, detectedRole: null, error: null,
  stats: { bytesReceived: 0, linesReceived: 0, validFrames: 0, parseErrors: 0, ignoredLines: 0, wrongRoleLines: 0 },
});

export function usePortSession<T>(
  role: SourceRole,
  adapter: ProtocolAdapter<T>,
  onLine: (line: ReceivedLine<T>) => void,
  beforeExternalBind?: () => void | Promise<void>,
) {
  const callback = useRef(onLine);
  callback.current = onLine;
  const beforeExternalBindRef = useRef(beforeExternalBind);
  beforeExternalBindRef.current = beforeExternalBind;
  const [snapshot, setSnapshot] = useState(() => emptySnapshot(role));
  const snapshotRef = useRef(snapshot);
  const pendingSnapshotRef = useRef<PortSnapshot | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const supported = typeof window !== "undefined" && window.isSecureContext && supportsWebSerial();
  const baseProvider = useMemo(() => supported ? browserSerialProvider() : null, [supported]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  const flushPendingSnapshot = useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      window.clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    const next = pendingSnapshotRef.current;
    if (!next) return;
    pendingSnapshotRef.current = null;
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const publishSnapshot = useCallback((next: PortSnapshot) => {
    const previous = snapshotRef.current;
    const urgent = previous.lifecycle !== next.lifecycle ||
      previous.health !== next.health ||
      previous.selected !== next.selected ||
      previous.detectedRole !== next.detectedRole ||
      previous.error !== next.error;
    pendingSnapshotRef.current = next;
    if (urgent) {
      flushPendingSnapshot();
      return;
    }
    if (snapshotTimerRef.current !== null) return;
    snapshotTimerRef.current = window.setTimeout(flushPendingSnapshot, SNAPSHOT_COALESCE_MS);
  }, [flushPendingSnapshot]);
  const provider = useMemo(() => baseProvider ? {
    requestPort: async (options?: { filters?: readonly { usbVendorId?: number; usbProductId?: number }[] }) => {
      const port = await baseProvider.requestPort(options);
      const result = await probePort({ id: `${role}-manual`, label: `${SERIAL_ROLE_LABELS[role]}手动选择`, port }, {
        timeoutMs: 2200,
        maxLines: 30,
        minValidFrames: 3,
      });
      if (result.confidence === "confident" && result.role && result.role !== role) {
        const binding = await serialSessionRegistry.bindAndConnect(result.role, port);
        serialHubStore.publishAutoMessage(result.role, binding.message);
        throw new Error(binding.ok
          ? `已识别为${SERIAL_ROLE_LABELS[result.role]}并自动切换到对应角色。`
          : `该串口识别为${SERIAL_ROLE_LABELS[result.role]}，但自动绑定失败：${binding.message}`);
      }
      const claim = serialSessionRegistry.claimPort(role, port);
      if (!claim.ok) throw new Error(claim.message);
      return port;
    },
  } : null, [baseProvider, role]);
  const session = useMemo(() => provider ? new PortSession<T>({
    role,
    provider,
    adapter,
    onLine: (line) => callback.current(line),
    onChange: publishSnapshot,
    onWrongRole: (event) => {
      void serialSessionRegistry.migrateWrongRole(event.fromRole, event.detectedRole, event.port)
        .then((result) => serialHubStore.publishAutoMessage(result.role, result.message));
    },
  }) : null, [role, provider, adapter, publishSnapshot]);
  useEffect(() => () => {
    if (snapshotTimerRef.current !== null) window.clearTimeout(snapshotTimerRef.current);
  }, []);
  useEffect(() => {
    if (!session) return;
    return serialSessionRegistry.register(role, {
      snapshot: () => session.snapshot(),
      bindAndConnect: async (port) => {
        await beforeExternalBindRef.current?.();
        session.selectPort(port);
        await session.connect();
      },
      disconnectAndRelease: async () => {
        await session.close().catch(() => undefined);
        if (["idle", "error"].includes(session.snapshot().lifecycle)) session.clearPort();
      },
    });
  }, [role, session]);
  useEffect(() => () => { void session?.close(); }, [session]);
  useEffect(() => {
    if (!session || snapshot.lifecycle !== "reading") return;
    const timer = window.setInterval(() => setSnapshot(session.snapshot()), 500);
    return () => window.clearInterval(timer);
  }, [session, snapshot.lifecycle]);
  const select = useCallback(async () => { try { await session?.requestPort(); } catch { /* snapshot carries the user-facing error */ } }, [session]);
  const connect = useCallback(async () => { try { await session?.connect(); } catch { /* snapshot carries the user-facing error */ } }, [session]);
  const close = useCallback(async () => { try { await session?.close(); } catch { /* close is best-effort */ } }, [session]);
  useEffect(() => {
    serialHubStore.publishPort(role, supported, snapshot);
  }, [role, supported, snapshot]);
  useEffect(() => serialHubStore.registerPortActions(role, { select, connect, close }), [role, select, connect, close]);
  return { supported, snapshot, select, connect, close };
}
