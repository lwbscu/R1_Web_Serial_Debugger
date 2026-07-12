import { describe, expect, it } from "vitest";
import type { LocatorFrame } from "../../src/protocols/models";
import {
  contextForSide,
  fieldToLocal,
  LOCATOR_START_POSES,
  localToField,
  parseLocatorCoordinateMetadata,
  projectLocatorFrameToField,
  restoreLocatorFrameFromField,
} from "../../src/core/locator";

function frame(): LocatorFrame {
  return {
    observedAtMs: 100,
    rawLine: "raw",
    protocol: "r1_csv_v3",
    sourceTimeMs: 90,
    seq: 7,
    posXcm: 1,
    posYcm: 2,
    posYawDeg: 3,
    calibXcm: 4,
    calibYcm: 5,
    calibYawDeg: 6,
    encoderXcm: 7,
    encoderYcm: 8,
    h30Xcm: 9,
    h30Ycm: 10,
    h30YawDeg: 11,
    lidarXcm: 12,
    lidarYcm: 13,
    lidarYawDeg: 14,
    dt35_1mm: 1000,
    dt35_2mm: 2000,
    status: 31,
    h30Valid: true,
    h30HasAttitude: true,
    h30HasAccel: false,
    lidarValid: true,
    lidarOnline: true,
    dt35_1Valid: true,
    dt35_2Valid: false,
    xPulseSeen: true,
    yPulseSeen: false,
    crcOk: true,
    crcState: "ok",
    diagnostics: { confidence: 0.9, fused: true },
  };
}

describe("locator start-relative coordinates", () => {
  function expectFrameCloseTo(actual: LocatorFrame, expected: LocatorFrame): void {
    const numericKeys = [
      "posXcm", "posYcm", "posYawDeg", "calibXcm", "calibYcm", "calibYawDeg",
      "encoderXcm", "encoderYcm", "h30Xcm", "h30Ycm", "h30YawDeg",
      "lidarXcm", "lidarYcm", "lidarYawDeg",
    ] as const;
    const actualStatic = { ...actual, diagnostics: undefined };
    const expectedStatic = { ...expected, diagnostics: undefined };
    for (const key of numericKeys) {
      delete actualStatic[key];
      delete expectedStatic[key];
    }
    expect(actualStatic).toEqual(expectedStatic);
    for (const key of numericKeys) {
      expect(actual[key]).toBeCloseTo(expected[key]);
    }
    expect(actual.diagnostics).toEqual(expected.diagnostics);
  }

  it("keeps each side origin user-visible as zero while projecting to its field anchor", () => {
    for (const side of ["red", "blue"] as const) {
      const context = contextForSide(side);
      const local = { x: 0, y: 0, yawDeg: 0 as const };
      const field = localToField(local, context);

      expect(field).toEqual({ ...local, x: context.fieldAnchorCm.x, y: context.fieldAnchorCm.y });
      expect(fieldToLocal(field, context)).toEqual(local);
      expect(local).toEqual({ x: 0, y: 0, yawDeg: 0 });
    }
  });

  it("uses the frozen red and blue anchors without rotation or mirroring", () => {
    expect(contextForSide("red").fieldAnchorCm).toEqual({ x: -555.7, y: 549, yawDeg: 0 });
    expect(contextForSide("blue").fieldAnchorCm).toEqual({ x: 548.5, y: 548, yawDeg: 0 });

    const local = { x: 25, y: -12, yawDeg: -37 };
    expect(localToField(local, contextForSide("red"))).toEqual({ x: -530.7, y: 537, yawDeg: -37 });
    expect(localToField(local, contextForSide("blue"))).toEqual({ x: 573.5, y: 536, yawDeg: -37 });
  });

  it("uses preliminary 9gong anchors above the exit line and rotates +Y to the vehicle front", () => {
    const redStart = LOCATOR_START_POSES.preliminary.red;
    const blueStart = LOCATOR_START_POSES.preliminary.blue;
    expect(redStart.fieldAnchorCm).toEqual({ x: -547.5, y: -300, yawDeg: 90 });
    expect(blueStart.fieldAnchorCm).toEqual({ x: 547.5, y: -300, yawDeg: 270 });
    expect(redStart.fieldAnchorCm.x - (-607.5)).toBeCloseTo(60);
    expect(607.5 - blueStart.fieldAnchorCm.x).toBeCloseTo(60);
    expect(redStart.fieldAnchorCm.y - (-344.5)).toBeCloseTo(44.5);
    expect(blueStart.fieldAnchorCm.y - (-344.5)).toBeCloseTo(44.5);
    expect(redStart.fieldAnchorCm.y).toBeGreaterThan(-330);
    expect(blueStart.fieldAnchorCm.y).toBeGreaterThan(-329.75);

    const red = contextForSide("red", "preliminary");
    const blue = contextForSide("blue", "preliminary");
    const redFront = localToField({ x: 0, y: 10, yawDeg: 0 }, red);
    const redRight = localToField({ x: 10, y: 0, yawDeg: 0 }, red);
    const blueFront = localToField({ x: 0, y: 10, yawDeg: 0 }, blue);
    const blueRight = localToField({ x: 10, y: 0, yawDeg: 0 }, blue);
    expect(redFront.x).toBeCloseTo(-537.5);
    expect(redFront.y).toBeCloseTo(-300);
    expect(redFront.yawDeg).toBe(90);
    expect(redRight.x).toBeCloseTo(-547.5);
    expect(redRight.y).toBeCloseTo(-310);
    expect(redRight.yawDeg).toBe(90);
    expect(blueFront.x).toBeCloseTo(537.5);
    expect(blueFront.y).toBeCloseTo(-300);
    expect(blueFront.yawDeg).toBe(270);
    expect(blueRight.x).toBeCloseTo(547.5);
    expect(blueRight.y).toBeCloseTo(-290);
    expect(blueRight.yawDeg).toBe(270);
  });

  it("translates all five XY groups, preserves yaw and other fields, and does not mutate input", () => {
    const input = frame();
    const snapshot = structuredClone(input);
    const context = contextForSide("red");
    const projected = projectLocatorFrameToField(input, context);

    expect(projected.posXcm).toBeCloseTo(-554.7);
    expect(projected.posYcm).toBeCloseTo(551);
    expect(projected.calibXcm).toBeCloseTo(-551.7);
    expect(projected.calibYcm).toBeCloseTo(554);
    expect(projected.encoderXcm).toBeCloseTo(-548.7);
    expect(projected.encoderYcm).toBeCloseTo(557);
    expect(projected.h30Xcm).toBeCloseTo(-546.7);
    expect(projected.h30Ycm).toBeCloseTo(559);
    expect(projected.lidarXcm).toBeCloseTo(-543.7);
    expect(projected.lidarYcm).toBeCloseTo(562);
    expect([projected.posYawDeg, projected.calibYawDeg, projected.h30YawDeg, projected.lidarYawDeg])
      .toEqual([3, 6, 11, 14]);
    expect(projected.dt35_1mm).toBe(input.dt35_1mm);
    expect(projected.rawLine).toBe(input.rawLine);
    expect(projected.diagnostics).toEqual(input.diagnostics);
    expect(projected.diagnostics).not.toBe(input.diagnostics);
    expect(input).toEqual(snapshot);
  });

  it("round-trips frames without accumulated offset", () => {
    for (const matchType of ["official", "preliminary"] as const) for (const side of ["red", "blue"] as const) {
      const input = frame();
      const context = contextForSide(side, matchType);
      const restored = restoreLocatorFrameFromField(projectLocatorFrameToField(input, context), context);
      expectFrameCloseTo(restored, input);
    }
  });
});

describe("locator coordinate metadata", () => {
  it("accepts only the exact current metadata contract", () => {
    const red = contextForSide("red");
    const preliminaryBlue = contextForSide("blue", "preliminary");
    expect(parseLocatorCoordinateMetadata(red)).toEqual(red);
    expect(parseLocatorCoordinateMetadata(preliminaryBlue)).toEqual(preliminaryBlue);

    expect(parseLocatorCoordinateMetadata({ ...red, side: "green" })).toBeNull();
    expect(parseLocatorCoordinateMetadata({ ...red, matchType: "practice" })).toBeNull();
    expect(parseLocatorCoordinateMetadata({ ...red, coordinateSpace: "field" })).toBeNull();
    expect(parseLocatorCoordinateMetadata({ ...red, transformVersion: "legacy" })).toBeNull();
    expect(parseLocatorCoordinateMetadata({ ...red, fieldAnchorCm: { ...red.fieldAnchorCm, x: 0 } })).toBeNull();
    expect(parseLocatorCoordinateMetadata({ ...red, extra: true })).toBeNull();
    expect(parseLocatorCoordinateMetadata(null)).toBeNull();
  });

  it("accepts legacy official metadata without match type", () => {
    const legacy = {
      side: "red",
      coordinateSpace: "start-relative",
      transformVersion: "r1-start-relative-v1",
      fieldAnchorCm: { x: -555.7, y: 549, yawDeg: 0 },
    };
    expect(parseLocatorCoordinateMetadata(legacy)).toEqual(contextForSide("red", "official"));
  });
});
