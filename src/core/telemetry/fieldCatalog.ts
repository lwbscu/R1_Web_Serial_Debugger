import type { NumericFieldDescriptor, SeriesId, TelemetrySource } from "./types";

const COLORS = [
  "#41dba8", "#5ab0ff", "#ffbf69", "#f18fda", "#b494ff", "#ff667d",
  "#7ce7f2", "#a8df65", "#ffa36c", "#d4d9ff", "#f7db57", "#6ed39a",
] as const;

const SKIP = new Set(["observedAtMs", "rawLine"]);

export function stableSeriesColor(id: string): string {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return COLORS[(hash >>> 0) % COLORS.length]!;
}

export interface ExtractedFrame {
  values: Record<string, number>;
  descriptors: NumericFieldDescriptor[];
}

/** Extracts finite numeric/boolean leaves. Nested diagnostic fields are supported. */
export function extractNumericFields(source: TelemetrySource, frame: unknown): ExtractedFrame {
  const values: Record<string, number> = {};
  const descriptors: NumericFieldDescriptor[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || SKIP.has(path)) return;
      values[path] = value;
      const id = `${source}:${path}` as SeriesId;
      descriptors.push({ id, source, path, label: `${source}.${path}`, color: stableSeriesColor(id), kind: "number" });
      return;
    }
    if (typeof value === "boolean") {
      values[path] = value ? 1 : 0;
      const id = `${source}:${path}` as SeriesId;
      descriptors.push({ id, source, path, label: `${source}.${path}`, color: stableSeriesColor(id), kind: "boolean" });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || depth >= 2) return;
    for (const [key, child] of Object.entries(value)) {
      if (SKIP.has(key)) continue;
      visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(frame, "", 0);
  return { values, descriptors };
}
