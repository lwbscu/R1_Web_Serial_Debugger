export type TelemetrySource = "remote" | "chassis" | "locator";
export type TelemetryOrigin = "serial" | "replay" | "demo";
export type SeriesId = `${TelemetrySource}:${string}`;

export interface NumericFieldDescriptor {
  id: SeriesId;
  source: TelemetrySource;
  path: string;
  label: string;
  color: string;
  kind: "number" | "boolean";
}

export interface TelemetryPoint {
  atMs: number;
  value: number;
}

export interface TelemetrySample {
  source: TelemetrySource;
  origin: TelemetryOrigin;
  atMs: number;
  values: Readonly<Record<string, number>>;
}

export interface TelemetrySnapshot {
  revision: number;
  acquiredThroughMs: number | null;
  retainedPoints: number;
  catalog: readonly NumericFieldDescriptor[];
  series: ReadonlyMap<SeriesId, readonly TelemetryPoint[]>;
}

export type WaveWindowMinutes = 1 | 5 | 10 | 30;
export type WaveWindowSeconds = 10 | 30 | 60 | 300 | 600 | 1800;
export type YScaleMode = { kind: "auto" } | { kind: "fixed"; min: number; max: number };
