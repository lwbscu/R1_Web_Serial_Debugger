import type { SourceRole } from "../core/types";

export function detectProtocolRole(line: string): SourceRole | null {
  if (/RDBG_TX,|RDBG_CFG,|RDBG_CMD,|RDBG,/.test(line)) return "remote";
  if (/CDBG_BOOT,|CDBG,|CEVT,/.test(line)) return "chassis";
  if (/\$R1M,/.test(line)) return "locator";
  const text = line.trim();
  if (!text || !text.includes(",")) return null;
  const values = text.split(",").filter((part) => part.trim() !== "");
  if ([5, 6, 9, 12, 25, 41].includes(values.length) && values.every((value) => Number.isFinite(Number(value)))) {
    return "locator";
  }
  return null;
}
