import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LocatorFrame } from "../../src/protocols";
import {
  DT35_MOUNTS,
  FIELD_BOUNDS,
  FIELD_SEGMENTS,
  NINE_GONG_START_POSES,
  bodyToWorld,
  canvasToWorld,
  computeDt35Ray,
  dt35YawFromFrame,
  followPoint,
  worldToCanvas,
  zoomViewportAt,
  type MapViewport,
} from "../../src/features/locator/geometry";

function locatorFrame(overrides: Partial<LocatorFrame> = {}): LocatorFrame {
  return {
    observedAtMs: 0, rawLine: "", protocol: "r1_csv_v3", sourceTimeMs: 0, seq: 1,
    posXcm: 0, posYcm: 0, posYawDeg: 0, calibXcm: 0, calibYcm: 0, calibYawDeg: 0,
    encoderXcm: 0, encoderYcm: 0, h30Xcm: 0, h30Ycm: 0, h30YawDeg: 0,
    lidarXcm: 0, lidarYcm: 0, lidarYawDeg: 0, dt35_1mm: 0, dt35_2mm: 0,
    status: 0, h30Valid: false, h30HasAttitude: false, h30HasAccel: false,
    lidarValid: false, lidarOnline: false, dt35_1Valid: false, dt35_2Valid: false,
    xPulseSeen: false, yPulseSeen: false, crcOk: false, crcState: "no_crc", diagnostics: {},
    ...overrides,
  };
}

const view: MapViewport = { width: 1000, height: 800, padding: 24, zoom: 1, panX: 0, panY: 0 };

describe("frozen e685044 map geometry", () => {
  it("uses center-origin bounds and the +Y-front clockwise yaw convention", () => {
    expect(FIELD_BOUNDS).toEqual({ minX: -607.5, maxX: 607.5, minY: -605, maxY: 605 });
    expect(bodyToWorld({ x: 0, y: 0, yawDeg: 0 }, 0, 10)).toEqual({ x: 0, y: 10 });
    const turned = bodyToWorld({ x: 0, y: 0, yawDeg: 90 }, 0, 10);
    expect(turned.x).toBeCloseTo(10);
    expect(turned.y).toBeCloseTo(0);
    expect(DT35_MOUNTS.map(({ xCm, yCm, yawOffsetDeg }) => ({ xCm, yCm, yawOffsetDeg }))).toEqual([
      { xCm: -40.4, yCm: -3.3, yawOffsetDeg: -90 },
      { xCm: 40.4, yCm: -3.3, yawOffsetDeg: 90 },
    ]);
  });

  it("keeps world/canvas transforms invertible and zoom anchored under the pointer", () => {
    expect(worldToCanvas({ x: 0, y: 0 }, view)).toEqual({ x: 500, y: 400 });
    const world = { x: 231.25, y: -119.5 };
    const pixel = worldToCanvas(world, view);
    expect(canvasToWorld(pixel, view).x).toBeCloseTo(world.x);
    expect(canvasToWorld(pixel, view).y).toBeCloseTo(world.y);
    const anchor = { x: 173, y: 219 };
    const before = canvasToWorld(anchor, view);
    const zoomed = zoomViewportAt(view, 1.15, anchor);
    expect(canvasToWorld(anchor, zoomed).x).toBeCloseTo(before.x);
    expect(canvasToWorld(anchor, zoomed).y).toBeCloseTo(before.y);
  });

  it("centers the followed robot without changing zoom", () => {
    const followed = followPoint({ ...view, zoom: 2 }, { x: 150, y: -80 });
    expect(followed.zoom).toBe(2);
    expect(worldToCanvas({ x: 150, y: -80 }, followed)).toEqual({ x: 500, y: 400 });
  });

  it("defines 9gong start poses in field coordinates with +Y as the vehicle front", () => {
    const [red, blue] = NINE_GONG_START_POSES;
    expect(red).toMatchObject({ side: "red", x: -547.5, y: -389, yawDeg: 90 });
    expect(blue).toMatchObject({ side: "blue", x: 547.5, y: -389, yawDeg: 270 });

    expect(red.x - FIELD_BOUNDS.minX).toBeCloseTo(60);
    expect(FIELD_BOUNDS.maxX - blue.x).toBeCloseTo(60);

    const lowerUsedWeaponWall = FIELD_SEGMENTS.find((segment) => segment.name === "lower_used_weapon_wall");
    expect(lowerUsedWeaponWall).toBeDefined();
    expect(lowerUsedWeaponWall!.a.y - red.y).toBeCloseTo(44.5);
    expect(lowerUsedWeaponWall!.a.y - blue.y).toBeCloseTo(44.5);
    expect(red.sideBoundaryDistanceCm).toBe(60);
    expect(blue.sideBoundaryDistanceCm).toBe(60);
    expect(red.lowerBoundaryDistanceCm).toBe(44.5);
    expect(blue.lowerBoundaryDistanceCm).toBe(44.5);

    const redFront = bodyToWorld(red, 0, 10);
    const blueFront = bodyToWorld(blue, 0, 10);
    expect(redFront.x).toBeGreaterThan(red.x);
    expect(redFront.y).toBeCloseTo(red.y);
    expect(blueFront.x).toBeLessThan(blue.x);
    expect(blueFront.y).toBeCloseTo(blue.y);
  });

  it("uses H30 yaw when valid and falls back to displayed pose yaw", () => {
    expect(dt35YawFromFrame(locatorFrame({ posYawDeg: 15, h30YawDeg: 75 }))).toBe(15);
    expect(dt35YawFromFrame(locatorFrame({ posYawDeg: 15, h30YawDeg: 75, h30HasAttitude: true }))).toBe(75);
  });

  it("projects from the frozen mount, finds the field model hit, and clips an overlong display ray", () => {
    const frame = locatorFrame({ posXcm: 0, posYcm: 0, posYawDeg: 0, dt35_2mm: 1000, dt35_2Valid: true });
    const ray = computeDt35Ray(frame, DT35_MOUNTS[1], frame.dt35_2mm, frame.dt35_2Valid);
    expect(ray.sensor.x).toBeCloseTo(40.4);
    expect(ray.sensor.y).toBeCloseTo(-3.3);
    expect(ray.rayYawDeg).toBe(90);
    expect(ray.target).toBe("blue_forest_obstacle");
    expect(ray.expectedCm).toBeCloseTo(87.1);
    expect(ray.residualCm).toBeCloseTo(12.9);
    expect(ray.clipped).toBe(true);
    expect(ray.displayHit.x).toBeCloseTo(127.5);
    expect(ray.state).toBe("large_residual");
  });

  it("marks disabled/status-invalid DT35 data as invalid", () => {
    const ray = computeDt35Ray(locatorFrame(), DT35_MOUNTS[0], 500, false);
    expect(ray.valid).toBe(false);
    expect(ray.state).toBe("invalid");
  });
});
describe("frozen binary assets", () => {
  it.each([
    ["field_prior_map_clean_labeled_1215x1210cm.png", "492b462dd38120c33e08c5d30e6e99a3fb60b19e17d23ef09cfda5408e247789"],
    ["r1_chassis_830mm_texture_1024.png", "72b2f76a12a46badd7c75e41feb698a7254a8abfcab49398893d4e02246e9336"],
  ])("matches the e685044 blob for %s", (name, expected) => {
    const bytes = readFileSync(new URL(`../../public/assets/map/${name}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
  });
});
