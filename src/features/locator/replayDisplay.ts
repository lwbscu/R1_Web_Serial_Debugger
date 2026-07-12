import { contextForSide, parseLocatorCoordinateMetadata, type LocatorCoordinateContext } from "../../core/locator";
import type { ReplayRecord } from "../../core/replay";
import { LocatorProtocolAdapter, type LocatorFrame } from "../../protocols";

export function replayCoordinateContext(metadata: unknown): LocatorCoordinateContext | null {
  const strict = parseLocatorCoordinateMetadata(metadata);
  if (strict) return strict;
  if (!metadata || typeof metadata !== "object") return null;
  const root = metadata as Record<string, unknown>;
  const nested = parseLocatorCoordinateMetadata(root.locatorCoordinates)
    ?? parseLocatorCoordinateMetadata(root.renderContext);
  if (nested) return nested;
  const render = root.renderContext && typeof root.renderContext === "object"
    ? root.renderContext as Record<string, unknown>
    : null;
  const capture = root.capture && typeof root.capture === "object"
    ? root.capture as Record<string, unknown>
    : null;
  const candidate = root.side ?? root.start_side ?? render?.side ?? capture?.side ?? capture?.start_side;
  return candidate === "red" || candidate === "blue" ? contextForSide(candidate) : null;
}

export function displayReplayFrame(record: ReplayRecord, adapter: LocatorProtocolAdapter): LocatorFrame | null {
  const columns = record.columns;
  if (!columns) return null;
  const named = "pos_x_cm" in columns || "fuse_x_cm" in columns;
  const get = (name: string, fallbackName?: string, index?: number): number => {
    const raw = columns[name] ?? (fallbackName ? columns[fallbackName] : undefined) ?? (index ? columns[`column_${index}`] : undefined);
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  };
  const values = named
    ? [
        get("pos_x_cm", "fuse_x_cm"), get("pos_y_cm", "fuse_y_cm"), get("pos_yaw_deg", "fuse_yaw_deg"),
        get("lidar_x_cm"), get("lidar_y_cm"), get("lidar_yaw_deg"),
        get("calib_x_cm", "enc_x_cm"), get("calib_y_cm", "enc_y_cm"), get("calib_yaw_deg", "enc_yaw_deg"),
        get("dt35_1_mm"), get("dt35_2_mm"), get("status"),
      ]
    : [get("", undefined, 4), get("", undefined, 5), get("", undefined, 6), get("", undefined, 10), get("", undefined, 11), get("", undefined, 12), get("", undefined, 7), get("", undefined, 8), get("", undefined, 9), get("", undefined, 13), get("", undefined, 14), get("", undefined, 15)];
  const outcome = adapter.parse(values.join(","), record.observedAtMs ?? performance.now());
  if (outcome.kind !== "frame") return null;
  if (named) {
    Object.assign(outcome.frame, {
      sourceTimeMs: get("source_time_ms"), seq: get("seq"),
      encoderXcm: get("encoder_x_cm", "enc_x_cm"), encoderYcm: get("encoder_y_cm", "enc_y_cm"),
      h30Xcm: get("h30_x_cm"), h30Ycm: get("h30_y_cm"), h30YawDeg: get("h30_yaw_deg"),
    });
  } else {
    outcome.frame.sourceTimeMs = get("", undefined, 2);
    outcome.frame.seq = get("", undefined, 3);
  }
  return outcome.frame;
}
