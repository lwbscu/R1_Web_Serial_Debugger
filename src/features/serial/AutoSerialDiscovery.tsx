import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { browserSerialApi, probePorts, type PortProbeResult, type ProbeCandidate, type ReadOnlySerialPort } from "../../core/serial";
import type { SourceRole } from "../../core/types";
import { serialSessionRegistry, type RegistryBindResult } from "./serialSessionRegistry";
import "./AutoSerialDiscovery.css";

const ROLE_LABELS: Record<SourceRole, string> = {
  remote: "遥控器",
  chassis: "底盘",
  locator: "定位/码盘板",
};

const CONFIDENCE_LABELS = {
  confident: "可信识别",
  ambiguous: "结果冲突",
  unknown: "暂未识别",
} as const;

interface DiscoveryRow {
  candidate: ProbeCandidate;
  result: PortProbeResult;
  binding: RegistryBindResult | null;
}

function validFrameTotal(result: PortProbeResult): number {
  return Object.values(result.validFrameCounts).reduce((sum, value) => sum + value, 0);
}

function roleText(result: PortProbeResult): string {
  if (!result.role) return "未知设备";
  return ROLE_LABELS[result.role];
}

export function AutoSerialDiscovery() {
  const api = useMemo(() => typeof navigator === "undefined" || typeof window === "undefined" || !window.isSecureContext ? null : browserSerialApi(), []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"authorize" | "probe" | null>(null);
  const [status, setStatus] = useState("等待授权或探测。网页不会向设备发送任何字节。 ");
  const [rows, setRows] = useState<DiscoveryRow[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const ids = useRef(new WeakMap<ReadOnlySerialPort, string>());
  const nextId = useRef(1);
  const aborter = useRef<AbortController | null>(null);
  const launchRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const candidateFor = (port: ReadOnlySerialPort): ProbeCandidate => {
    let id = ids.current.get(port);
    if (!id) {
      id = `device-${nextId.current++}`;
      ids.current.set(port, id);
    }
    return { id, label: `临时设备 ${id.slice("device-".length)}`, port };
  };

  const inspectCandidates = async (candidates: ProbeCandidate[], signal: AbortSignal): Promise<DiscoveryRow[]> => {
    const results = await probePorts(candidates, { signal });
    const discovered: DiscoveryRow[] = [];
    for (const result of results) {
      const candidate = candidates.find((item) => item.id === result.id);
      if (!candidate) continue;
      let binding: RegistryBindResult | null = null;
      if (!signal.aborted && result.reason !== "cancelled" && result.confidence === "confident" && result.role) {
        binding = await serialSessionRegistry.bindAndConnect(result.role, candidate.port, signal);
      }
      discovered.push({ candidate, result, binding });
    }
    setRows((old) => {
      const merged = new Map(old.map((item) => [item.result.id, item]));
      discovered.forEach((item) => merged.set(item.result.id, item));
      return [...merged.values()];
    });
    return discovered;
  };

  useEffect(() => () => aborter.current?.abort(), []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const closeDialog = () => {
    if (busy) return;
    setOpen(false);
    window.requestAnimationFrame(() => launchRef.current?.focus());
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])") ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const authorizeOne = async () => {
    if (!api || busy) return;
    setBusy("authorize");
    let portSelected = false;
    try {
      const port = await api.requestPort();
      portSelected = true;
      const candidate = candidateFor(port);
      if (serialSessionRegistry.isClaimed(port)) {
        setStatus(`${candidate.label} 已经绑定，本次没有重复打开或探测。`);
        return;
      }
      const controller = new AbortController();
      aborter.current = controller;
      setBusy("probe");
      setStatus(`${candidate.label} 已授权，正在只读采样并自动识别…`);
      const discovered = await inspectCandidates([candidate], controller.signal);
      const row = discovered[0];
      if (controller.signal.aborted || row?.result.reason === "cancelled") setStatus("已停止本次只读探测，未绑定晚到结果。");
      else if (!row) setStatus(`${candidate.label} 未返回探测结果。`);
      else if (row.binding?.ok) setStatus(`${candidate.label} 已识别为${roleText(row.result)}，并自动绑定连接。若还有新设备，可继续添加。`);
      else if (row.result.confidence !== "confident") setStatus(`${candidate.label} 的协议证据不足或冲突，已保留结果但没有绑定。`);
      else setStatus(`${candidate.label} 已识别为${roleText(row.result)}，但未绑定：${row.binding?.message ?? "对应会话不可用"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("cancel") || message.includes("选择") || message.includes("cancelled")) setStatus(portSelected ? "已停止本次只读探测。" : "已取消本次串口选择。");
      else setStatus(portSelected ? `新串口探测失败：${message}` : `授权失败：${message}`);
    } finally {
      aborter.current = null;
      setBusy(null);
    }
  };

  const probeAuthorized = async () => {
    if (!api || busy) return;
    setBusy("probe");
    aborter.current = new AbortController();
    try {
      const ports = await api.getPorts();
      const candidates = ports.filter((port) => !serialSessionRegistry.isClaimed(port)).map(candidateFor);
      const skipped = ports.length - candidates.length;
      if (candidates.length === 0) {
        setStatus(ports.length === 0 ? "当前网站还没有获得任何串口授权。" : `已授权的 ${ports.length} 个串口都已绑定，未重复探测。`);
        return;
      }
      setStatus(`正在并行只读探测 ${candidates.length} 个串口${skipped ? `，跳过 ${skipped} 个已绑定串口` : ""}…`);
      const discovered = await inspectCandidates(candidates, aborter.current.signal);
      if (aborter.current.signal.aborted || discovered.every((item) => item.result.reason === "cancelled")) {
        setStatus("已停止本次只读探测，未绑定晚到结果。");
        return;
      }
      const connected = discovered.filter((item) => item.binding?.ok).length;
      const unbound = discovered.length - connected;
      setStatus(`探测完成：${connected} 个已自动绑定并连接，${unbound} 个因证据不足、冲突或会话占用而未绑定。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`探测失败：${message}`);
    } finally {
      aborter.current = null;
      setBusy(null);
    }
  };

  const cancelProbe = () => {
    aborter.current?.abort();
    setStatus("正在停止只读探测…");
  };

  return <>
    <button ref={launchRef} type="button" className="asd-launch" aria-label="自动识别串口" onClick={() => setOpen(true)} title="对已授权串口只读采样，自动识别并绑定遥控器、底盘和定位/码盘板">
      <span className="asd-launch-icon">A</span>
      <span><strong>自动识别串口</strong><small>READ-ONLY DISCOVERY</small></span>
    </button>

    {open && <div className="asd-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDialog(); }}>
      <section ref={dialogRef} className="asd-dialog" role="dialog" aria-modal="true" aria-labelledby="asd-title" onKeyDown={handleDialogKeyDown}>
        <header className="asd-head">
          <div><span className="asd-kicker">READ-ONLY PORT DISCOVERY</span><h2 id="asd-title">串口自动识别与绑定</h2><p>采样前几帧并识别 RDBG、CDBG、定位 CSV / $R1M；可信且角色唯一时自动连接对应工作区。</p></div>
          <button ref={closeRef} type="button" className="asd-close" disabled={busy !== null} onClick={closeDialog} aria-label="关闭">×</button>
        </header>
        <div className="asd-body">
          <div className="asd-notice"><b>!</b><div><strong>浏览器权限限制：</strong>Web Serial 每次只能由你在系统弹窗中选择一个新串口，不能一次勾选多个，也不能静默扫描全部 COM 口。每个新设备点击一次“添加并识别新串口”，授权后会立即只读探测；以前授权过的设备可批量识别。标准接口不会返回 COM7 之类的系统端口名。网页不创建 writer、不发送字节且不主动调用 setSignals；但调用 open 时个别驱动仍可能改变线路状态或让板卡复位。</div></div>
          <div className="asd-actions">
            <button type="button" onClick={() => void authorizeOne()} disabled={!api || busy !== null}>添加并识别新串口</button>
            <button type="button" className="asd-primary" onClick={() => void probeAuthorized()} disabled={!api || busy !== null}>批量探测已授权串口</button>
            {busy === "probe" && <button type="button" className="asd-stop" onClick={cancelProbe}>停止探测</button>}
          </div>
          <div className="asd-status" role="status">{api ? status : "当前浏览器或页面环境不支持 Web Serial，请使用 HTTPS 下的最新版 Chrome / Edge。"}</div>

          <div className="asd-results">
            {rows.length === 0 && <div className="asd-empty">探测结果将在这里列出设备编号、USB VID/PID、协议证据、有效帧数和自动绑定状态。</div>}
            {rows.map(({ candidate, result, binding }) => <article className="asd-result" key={result.id}>
              <div className="asd-device">
                <strong>{aliases[result.id]?.trim() || candidate.label}</strong>
                <span className="asd-usb">{result.usbLabel}</span>
                <label className="asd-alias">COM 别名（可选，由你确认后填写）
                  <input value={aliases[result.id] ?? ""} onChange={(event) => setAliases((old) => ({ ...old, [result.id]: event.target.value }))} placeholder="例如 COM7" maxLength={24} />
                </label>
                <span className="asd-com-note">未填写时使用本页面临时设备号；刷新后编号可能变化。</span>
              </div>

              <div className="asd-classification">
                <span className={`asd-role ${result.confidence === "confident" ? "" : result.confidence}`}>{roleText(result)} · {CONFIDENCE_LABELS[result.confidence]}</span>
                <div className="asd-facts">
                  <span>有效帧<b>{validFrameTotal(result)}</b></span>
                  <span>检查行数<b>{result.inspectedLines}</b></span>
                  <span>判定原因<b>{result.reason}</b></span>
                  <span>目标工作区<b>{result.role ? ROLE_LABELS[result.role] : "不自动绑定"}</b></span>
                </div>
                {binding && <span className={`asd-bind ${binding.ok ? "ok" : "error"}`}>{binding.message}</span>}
                {result.error && <span className="asd-bind error">探测错误：{result.error}</span>}
              </div>

              <div className="asd-evidence">
                <strong>协议证据</strong>
                {result.evidence.length === 0 && <span>未观察到可归类的协议帧。</span>}
                {result.evidence.slice(0, 5).map((evidence, index) => <code key={`${result.id}-${index}`} title={evidence.line}>{ROLE_LABELS[evidence.role]} · {evidence.protocolVersion ?? evidence.outcome}{evidence.detail ? ` · ${evidence.detail}` : ""}</code>)}
                {result.evidence.length > 5 && <span>另有 {result.evidence.length - 5} 条证据未展开。</span>}
              </div>
            </article>)}
          </div>
        </div>
      </section>
    </div>}
  </>;
}
