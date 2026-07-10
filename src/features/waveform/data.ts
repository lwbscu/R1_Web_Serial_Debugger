import type uPlot from "uplot";
import { minMaxDecimate, type SeriesId, type TelemetryPoint } from "../../core/telemetry";

export interface PlotSeriesInput {
  id: SeriesId;
  label: string;
  color: string;
  visible: boolean;
  points: readonly TelemetryPoint[];
}

export interface AlignedPlotData {
  data: uPlot.AlignedData;
  series: PlotSeriesInput[];
}

export function alignPlotSeries(inputs: readonly PlotSeriesInput[], maxPointsPerSeries = 10_000): AlignedPlotData {
  const prepared = inputs.map((input) => ({
    ...input,
    points: minMaxDecimate(input.points, maxPointsPerSeries),
  }));
  const timestamps = new Set<number>();
  for (const input of prepared) for (const point of input.points) timestamps.add(point.atMs / 1000);
  const x = [...timestamps].sort((a, b) => a - b);
  const xIndex = new Map(x.map((value, index) => [value, index]));
  const columns: (number | null)[][] = prepared.map(() => Array.from<number | null>({ length: x.length }).fill(null));
  prepared.forEach((input, seriesIndex) => {
    for (const point of input.points) {
      const index = xIndex.get(point.atMs / 1000);
      if (index !== undefined) columns[seriesIndex]![index] = point.value;
    }
  });
  return { data: [x, ...columns] as uPlot.AlignedData, series: prepared };
}
