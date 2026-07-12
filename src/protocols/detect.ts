import type { SourceRole } from "../core/types";

export function detectProtocolRole(line: string): SourceRole | null {
  if (/RDBG_TX,|RDBG_CFG,|RDBG_CMD,|RDBG,/.test(line)) return "remote";
  const metaMarker = line.indexOf("DBG_META,");
  if (metaMarker >= 0) {
    const meta = line.slice(metaMarker).trim().split(",");
    if (meta[4] === "remote" || meta[4] === "chassis" || meta[4] === "locator") return meta[4];
    return null;
  }
  if (/CDBG_BOOT,|CDBG,/.test(line)) return "chassis";
  // CEVT is intentionally role-neutral. A preceding role-specific frame or
  // DBG_META binds the port; an event alone must never migrate a session.
  if (/CEVT,/.test(line)) return null;
  if (/\$R1M,/.test(line)) return "locator";
  const text = line.trim();
  if (!text || !text.includes(",")) return null;
  const values = text.split(",").filter((part) => part.trim() !== "");
  if ([5, 6, 9, 12, 25, 41].includes(values.length) && values.every((value) => Number.isFinite(Number(value)))) {
    return "locator";
  }
  return null;
}
