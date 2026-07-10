import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProtocolAdapter, SourceRole } from "../../core/types";
import { browserSerialProvider, PortSession, supportsWebSerial, type PortSnapshot, type ReceivedLine } from "../../core/serial";

const emptySnapshot = (role: SourceRole): PortSnapshot => ({
  role, lifecycle: "idle", health: "no-data", selected: false,
  lastByteAtMs: null, lastValidFrameAtMs: null, detectedRole: null, error: null,
  stats: { bytesReceived: 0, linesReceived: 0, validFrames: 0, parseErrors: 0, ignoredLines: 0, wrongRoleLines: 0 },
});

export function usePortSession<T>(role: SourceRole, adapter: ProtocolAdapter<T>, onLine: (line: ReceivedLine<T>) => void) {
  const callback = useRef(onLine);
  callback.current = onLine;
  const [snapshot, setSnapshot] = useState(() => emptySnapshot(role));
  const supported = typeof window !== "undefined" && window.isSecureContext && supportsWebSerial();
  const provider = useMemo(() => supported ? browserSerialProvider() : null, [supported]);
  const session = useMemo(() => provider ? new PortSession<T>({
    role, provider, adapter, onLine: (line) => callback.current(line), onChange: setSnapshot,
  }) : null, [role, provider, adapter]);
  useEffect(() => () => { void session?.close(); }, [session]);
  useEffect(() => {
    if (!session || snapshot.lifecycle !== "reading") return;
    const timer = window.setInterval(() => setSnapshot(session.snapshot()), 500);
    return () => window.clearInterval(timer);
  }, [session, snapshot.lifecycle]);
  const select = useCallback(async () => { try { await session?.requestPort(); } catch { /* snapshot carries the user-facing error */ } }, [session]);
  const connect = useCallback(async () => { try { await session?.connect(); } catch { /* snapshot carries the user-facing error */ } }, [session]);
  const close = useCallback(async () => { try { await session?.close(); } catch { /* close is best-effort */ } }, [session]);
  return { supported, snapshot, select, connect, close };
}
