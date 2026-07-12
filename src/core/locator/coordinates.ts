import type { LocatorFrame } from "../../protocols/models";

export type LocatorSide = "red" | "blue";

export interface LocatorPoint {
  x: number;
  y: number;
}
export interface LocatorCoordinateContext {
  side: LocatorSide;
  coordinateSpace: "start-relative";
  transformVersion: "r1-start-relative-v1";
  fieldAnchorCm: {
    x: number;
    y: number;
    yawDeg: 0;
  };
}

const CONTEXTS: Readonly<Record<LocatorSide, LocatorCoordinateContext>> = {
  red: {
    side: "red",
    coordinateSpace: "start-relative",
    transformVersion: "r1-start-relative-v1",
    fieldAnchorCm: { x: -555.7, y: 549, yawDeg: 0 },
  },
  blue: {
    side: "blue",
    coordinateSpace: "start-relative",
    transformVersion: "r1-start-relative-v1",
    fieldAnchorCm: { x: 548.5, y: 548, yawDeg: 0 },
  },
};

/** Returns a fresh context so callers cannot mutate the frozen side defaults. */
export function contextForSide(side: LocatorSide): LocatorCoordinateContext {
  const context = CONTEXTS[side];
  return {
    ...context,
    fieldAnchorCm: { ...context.fieldAnchorCm },
  };
}

export function localToField<T extends LocatorPoint>(
  point: T,
  context: LocatorCoordinateContext,
): T {
  return {
    ...point,
    x: point.x + context.fieldAnchorCm.x,
    y: point.y + context.fieldAnchorCm.y,
  };
}

export function fieldToLocal<T extends LocatorPoint>(
  point: T,
  context: LocatorCoordinateContext,
): T {
  return {
    ...point,
    x: point.x - context.fieldAnchorCm.x,
    y: point.y - context.fieldAnchorCm.y,
  };
}

const XY_FIELDS = [
  ["posXcm", "posYcm"],
  ["calibXcm", "calibYcm"],
  ["encoderXcm", "encoderYcm"],
  ["h30Xcm", "h30Ycm"],
  ["lidarXcm", "lidarYcm"],
] as const satisfies readonly (readonly [keyof LocatorFrame, keyof LocatorFrame])[];

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
    (translated[xField] as number) =
      (frame[xField] as number) + direction * context.fieldAnchorCm.x;
    (translated[yField] as number) =
      (frame[yField] as number) + direction * context.fieldAnchorCm.y;
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
