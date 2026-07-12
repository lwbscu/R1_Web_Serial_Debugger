import type { LocatorFrame } from "../../protocols/models";

export type LocatorSide = "red" | "blue";
export type LocatorMatchType = "official" | "preliminary";
export type LocatorTransformVersion = "r1-start-relative-v2";

export interface LocatorPoint {
  x: number;
  y: number;
}
export interface LocatorCoordinateContext {
  side: LocatorSide;
  matchType: LocatorMatchType;
  coordinateSpace: "start-relative";
  transformVersion: LocatorTransformVersion;
  fieldAnchorCm: {
    x: number;
    y: number;
    yawDeg: number;
  };
}

export interface LocatorStartPose {
  side: LocatorSide;
  matchType: LocatorMatchType;
  label: string;
  fieldAnchorCm: LocatorCoordinateContext["fieldAnchorCm"];
  r1ChannelBoundaryDistanceCm?: number;
  forestLowerBoundaryDistanceCm?: number;
}

export const LOCATOR_COORDINATE_TRANSFORM_VERSION: LocatorTransformVersion = "r1-start-relative-v2";

export const LOCATOR_START_POSES: Readonly<Record<LocatorMatchType, Record<LocatorSide, LocatorStartPose>>> = {
  official: {
    red: {
      side: "red",
      matchType: "official",
      label: "正式赛红方起点",
      fieldAnchorCm: { x: -555.7, y: 549, yawDeg: 0 },
    },
    blue: {
      side: "blue",
      matchType: "official",
      label: "正式赛蓝方起点",
      fieldAnchorCm: { x: 548.5, y: 548, yawDeg: 0 },
    },
  },
  preliminary: {
    red: {
      side: "red",
      matchType: "preliminary",
      label: "预选赛红方 9gong 起点",
      fieldAnchorCm: { x: -547.5, y: -239.5, yawDeg: 90 },
      r1ChannelBoundaryDistanceCm: 60,
      forestLowerBoundaryDistanceCm: 44.5,
    },
    blue: {
      side: "blue",
      matchType: "preliminary",
      label: "预选赛蓝方 9gong 起点",
      fieldAnchorCm: { x: 547.5, y: -239.5, yawDeg: 270 },
      r1ChannelBoundaryDistanceCm: 60,
      forestLowerBoundaryDistanceCm: 44.5,
    },
  },
};

/** Returns a fresh context so callers cannot mutate the frozen side defaults. */
export function contextForSide(side: LocatorSide, matchType: LocatorMatchType = "official"): LocatorCoordinateContext {
  const startPose = LOCATOR_START_POSES[matchType][side];
  return {
    side,
    matchType,
    coordinateSpace: "start-relative",
    transformVersion: LOCATOR_COORDINATE_TRANSFORM_VERSION,
    fieldAnchorCm: { ...startPose.fieldAnchorCm },
  };
}

export function localToField<T extends LocatorPoint>(
  point: T,
  context: LocatorCoordinateContext,
): T {
  const yaw = context.fieldAnchorCm.yawDeg * Math.PI / 180;
  const result = {
    ...point,
    x: context.fieldAnchorCm.x + point.x * Math.cos(yaw) + point.y * Math.sin(yaw),
    y: context.fieldAnchorCm.y - point.x * Math.sin(yaw) + point.y * Math.cos(yaw),
  };
  if ("yawDeg" in point && typeof (point as { yawDeg?: unknown }).yawDeg === "number") {
    (result as T & { yawDeg: number }).yawDeg = (point as { yawDeg: number }).yawDeg + context.fieldAnchorCm.yawDeg;
  }
  return result;
}

export function fieldToLocal<T extends LocatorPoint>(
  point: T,
  context: LocatorCoordinateContext,
): T {
  const yaw = context.fieldAnchorCm.yawDeg * Math.PI / 180;
  const dx = point.x - context.fieldAnchorCm.x;
  const dy = point.y - context.fieldAnchorCm.y;
  const result = {
    ...point,
    x: dx * Math.cos(yaw) - dy * Math.sin(yaw),
    y: dx * Math.sin(yaw) + dy * Math.cos(yaw),
  };
  if ("yawDeg" in point && typeof (point as { yawDeg?: unknown }).yawDeg === "number") {
    (result as T & { yawDeg: number }).yawDeg = (point as { yawDeg: number }).yawDeg - context.fieldAnchorCm.yawDeg;
  }
  return result;
}

const XY_FIELDS = [
  ["posXcm", "posYcm"],
  ["calibXcm", "calibYcm"],
  ["encoderXcm", "encoderYcm"],
  ["h30Xcm", "h30Ycm"],
  ["lidarXcm", "lidarYcm"],
] as const satisfies readonly (readonly [keyof LocatorFrame, keyof LocatorFrame])[];

const YAW_FIELDS = [
  "posYawDeg",
  "calibYawDeg",
  "h30YawDeg",
  "lidarYawDeg",
] as const satisfies readonly (keyof LocatorFrame)[];

function translateLocatorFrame(
  frame: LocatorFrame,
  context: LocatorCoordinateContext,
  direction: 1 | -1,
): LocatorFrame {
  const translated: LocatorFrame = {
    ...frame,
    diagnostics: { ...frame.diagnostics },
  };

  for (const [xField, yField] of XY_FIELDS) {
    const point = direction === 1
      ? localToField({ x: frame[xField] as number, y: frame[yField] as number }, context)
      : fieldToLocal({ x: frame[xField] as number, y: frame[yField] as number }, context);
    (translated[xField] as number) = point.x;
    (translated[yField] as number) = point.y;
  }

  for (const yawField of YAW_FIELDS) {
    (translated[yawField] as number) =
      (frame[yawField] as number) + direction * context.fieldAnchorCm.yawDeg;
  }

  return translated;
}

/** Produces an internal field-rendering frame without modifying the local frame. */
export function projectLocatorFrameToField(
  frame: LocatorFrame,
  context: LocatorCoordinateContext,
): LocatorFrame {
  return translateLocatorFrame(frame, context, 1);
}

/** Restores a field-rendering frame to the user-visible start-relative frame. */
export function restoreLocatorFrameFromField(
  frame: LocatorFrame,
  context: LocatorCoordinateContext,
): LocatorFrame {
  return translateLocatorFrame(frame, context, -1);
}
