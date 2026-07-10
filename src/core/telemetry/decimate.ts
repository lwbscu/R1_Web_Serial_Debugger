import type { TelemetryPoint } from "./types";

/** Min/max bucket decimation. It preserves endpoints and short spikes. */
export function minMaxDecimate(points: readonly TelemetryPoint[], maxPoints: number): TelemetryPoint[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 2) throw new RangeError("maxPoints 必须至少为 2");
  if (points.length <= maxPoints) return [...points];
  if (maxPoints === 2) return [points[0]!, points.at(-1)!];
  const output: TelemetryPoint[] = [points[0]!];
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 2));
  const interior = points.length - 2;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor(bucket * interior / bucketCount);
    const end = 1 + Math.floor((bucket + 1) * interior / bucketCount);
    let min = points[start]!;
    let max = min;
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index]!;
      if (point.value < min.value) min = point;
      if (point.value > max.value) max = point;
    }
    if (min.atMs <= max.atMs) {
      output.push(min);
      if (max !== min) output.push(max);
    } else {
      output.push(max, min);
    }
  }
  output.push(points.at(-1)!);
  return output.slice(0, maxPoints);
}
