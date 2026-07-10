import { extractNumericFields } from "./fieldCatalog";
import { minMaxDecimate } from "./decimate";
import type {
  NumericFieldDescriptor,
  SeriesId,
  TelemetryOrigin,
  TelemetryPoint,
  TelemetrySnapshot,
  TelemetrySource,
} from "./types";

export interface TelemetryHubOptions {
  retentionMs?: number;
  maxPointsPerSeries?: number;
  unselectedRetentionMs?: number;
  maxUnselectedPoints?: number;
  pruneBatchSize?: number;
  now?: () => number;
}

const ORIGIN_PRIORITY: Readonly<Record<TelemetryOrigin, number>> = { demo: 1, replay: 2, serial: 3 };

function lowerBound(points: readonly TelemetryPoint[], atMs: number): number {
  let low = 0; let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.atMs < atMs) low = middle + 1; else high = middle;
  }
  return low;
}

export class TelemetryHub {
  private readonly retentionMs: number;
  private readonly maxPointsPerSeries: number;
  private readonly unselectedRetentionMs: number;
  private readonly maxUnselectedPoints: number;
  private readonly pruneBatchSize: number;
  private readonly now: () => number;
  private readonly fields = new Map<SeriesId, NumericFieldDescriptor>();
  private readonly points = new Map<SeriesId, TelemetryPoint[]>();
  private readonly selected = new Set<SeriesId>();
  private readonly activeOrigins = new Map<TelemetrySource, TelemetryOrigin>();
  private readonly listeners = new Set<() => void>();
  private revisionValue = 0;
  private acquiredThroughMs: number | null = null;

  constructor(options: TelemetryHubOptions = {}) {
    this.retentionMs = options.retentionMs ?? 30 * 60_000;
    this.maxPointsPerSeries = options.maxPointsPerSeries ?? 120_000;
    this.unselectedRetentionMs = Math.min(options.unselectedRetentionMs ?? 60_000, this.retentionMs);
    this.maxUnselectedPoints = Math.min(options.maxUnselectedPoints ?? 3_000, this.maxPointsPerSeries);
    this.pruneBatchSize = options.pruneBatchSize ?? 256;
    this.now = options.now ?? Date.now;
    if (this.retentionMs <= 0 || this.unselectedRetentionMs <= 0 || this.maxPointsPerSeries < 2 || this.maxUnselectedPoints < 2 || this.pruneBatchSize < 1) {
      throw new RangeError("TelemetryHub 容量配置无效");
    }
  }

  get revision(): number { return this.revisionValue; }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Selected series retain the full 30-minute window; all others keep a short preview only. */
  select(ids: readonly SeriesId[]): void {
    const next = new Set(ids);
    let changed = next.size !== this.selected.size;
    if (!changed) for (const id of next) if (!this.selected.has(id)) { changed = true; break; }
    if (!changed) return;
    this.selected.clear();
    next.forEach((id) => this.selected.add(id));
    const through = this.acquiredThroughMs ?? this.now();
    for (const [id, series] of this.points) {
      if (this.selected.has(id)) continue;
      const start = lowerBound(series, through - this.unselectedRetentionMs);
      if (start > 0) series.splice(0, start);
      if (series.length > this.maxUnselectedPoints) series.splice(0, series.length, ...minMaxDecimate(series, this.maxUnselectedPoints));
    }
    this.changed();
  }

  activeOrigin(source: TelemetrySource): TelemetryOrigin | null { return this.activeOrigins.get(source) ?? null; }

  releaseSource(source: TelemetrySource, origin?: TelemetryOrigin): void {
    if (origin && this.activeOrigins.get(source) !== origin) return;
    const hadOrigin = this.activeOrigins.delete(source);
    let removed = false;
    const prefix = `${source}:`;
    for (const [id] of this.points) {
      if (!id.startsWith(prefix)) continue;
      this.points.delete(id); removed = true;
    }
    if (hadOrigin || removed) this.changed();
  }

  publishFrame(source: TelemetrySource, frame: unknown, origin: TelemetryOrigin = "serial", atMs = this.now()): void {
    if (!Number.isFinite(atMs) || !this.acceptOrigin(source, origin)) return;
    const extracted = extractNumericFields(source, frame);
    const throughMs = Math.max(this.acquiredThroughMs ?? atMs, atMs);
    for (const descriptor of extracted.descriptors) {
      if (!this.fields.has(descriptor.id)) this.fields.set(descriptor.id, descriptor);
      const series = this.points.get(descriptor.id) ?? [];
      const point = { atMs, value: extracted.values[descriptor.path]! };
      if (series.length === 0 || series.at(-1)!.atMs <= atMs) series.push(point);
      else series.splice(lowerBound(series, atMs), 0, point);

      const highResolution = this.selected.has(descriptor.id);
      const retention = highResolution ? this.retentionMs : this.unselectedRetentionMs;
      const limit = highResolution ? this.maxPointsPerSeries : this.maxUnselectedPoints;
      const first = lowerBound(series, throughMs - retention);
      if (first > 0 && (first >= this.pruneBatchSize || series.length > limit)) series.splice(0, first);
      if (series.length > limit) series.splice(0, series.length, ...minMaxDecimate(series, limit));
      this.points.set(descriptor.id, series);
    }
    this.acquiredThroughMs = throughMs;
    this.changed();
  }

  clear(): void {
    this.points.clear();
    this.activeOrigins.clear();
    this.acquiredThroughMs = null;
    this.changed();
  }

  catalog(): readonly NumericFieldDescriptor[] {
    return [...this.fields.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  latest(id: SeriesId): TelemetryPoint | undefined { return this.points.get(id)?.at(-1); }

  pointCount(): number {
    let count = 0;
    for (const series of this.points.values()) count += series.length;
    return count;
  }

  snapshot(windowMs = this.retentionMs, throughMs = this.acquiredThroughMs ?? this.now(), ids?: readonly SeriesId[]): TelemetrySnapshot {
    const selected = ids ? new Set(ids) : null;
    const cutoff = throughMs - Math.min(windowMs, this.retentionMs);
    const series = new Map<SeriesId, readonly TelemetryPoint[]>();
    let retainedPoints = 0;
    for (const [id, all] of this.points) {
      if (selected && !selected.has(id)) continue;
      const visible = all.slice(lowerBound(all, cutoff));
      retainedPoints += visible.length;
      series.set(id, visible);
    }
    return { revision: this.revisionValue, acquiredThroughMs: this.acquiredThroughMs, retainedPoints, catalog: this.catalog(), series };
  }

  private acceptOrigin(source: TelemetrySource, origin: TelemetryOrigin): boolean {
    const current = this.activeOrigins.get(source);
    if (!current) { this.activeOrigins.set(source, origin); return true; }
    if (current === origin) return true;
    if (ORIGIN_PRIORITY[origin] < ORIGIN_PRIORITY[current]) return false;
    this.activeOrigins.set(source, origin);
    const prefix = `${source}:`;
    for (const [id] of this.points) if (id.startsWith(prefix)) this.points.delete(id);
    return true;
  }

  private changed(): void {
    this.revisionValue += 1;
    for (const listener of this.listeners) listener();
  }
}

export const telemetryHub = new TelemetryHub();

export function publishFrame(source: TelemetrySource, frame: unknown, origin: TelemetryOrigin = "serial", atMs?: number): void {
  telemetryHub.publishFrame(source, frame, origin, atMs);
}
