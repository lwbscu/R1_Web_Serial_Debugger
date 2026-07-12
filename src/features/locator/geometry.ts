import type { LocatorFrame } from "../../protocols";

export interface Point { x: number; y: number }
export interface Pose extends Point { yawDeg: number }

export const FIELD_BOUNDS = { minX: -607.5, maxX: 607.5, minY: -605, maxY: 605 } as const;
export const FIELD_WIDTH_CM = FIELD_BOUNDS.maxX - FIELD_BOUNDS.minX;
export const FIELD_HEIGHT_CM = FIELD_BOUNDS.maxY - FIELD_BOUNDS.minY;

export type FieldTargetType = "usable_wall" | "solid_obstacle" | "blocker" | "ignore" | "start_zone";

export interface FieldSegment {
  name: string;
  type: FieldTargetType;
  a: Point;
  b: Point;
}

export interface FieldRectangle {
  name: string;
  type: FieldTargetType;
  center: Point;
  width: number;
  height: number;
  visualOnly?: boolean;
}

export interface NineGongStartPose extends Pose {
  side: "red" | "blue";
  label: string;
  sideBoundaryDistanceCm: number;
  lowerBoundaryDistanceCm: number;
}

export const FIELD_SEGMENTS: readonly FieldSegment[] = [
  { name: "field_left", type: "usable_wall", a: { x: -607.5, y: -605 }, b: { x: -607.5, y: 605 } },
  { name: "field_right", type: "usable_wall", a: { x: 607.5, y: -605 }, b: { x: 607.5, y: 605 } },
  { name: "field_bottom", type: "usable_wall", a: { x: -607.5, y: -605 }, b: { x: 607.5, y: -605 } },
  { name: "field_top", type: "usable_wall", a: { x: -607.5, y: 605 }, b: { x: 607.5, y: 605 } },
  { name: "red_start_left_wall", type: "usable_wall", a: { x: -607.5, y: 430 }, b: { x: -607.5, y: 605 } },
  { name: "red_start_top_wall", type: "usable_wall", a: { x: -607.5, y: 605 }, b: { x: -430, y: 605 } },
  { name: "blue_start_right_wall", type: "usable_wall", a: { x: 607.5, y: 430 }, b: { x: 607.5, y: 605 } },
  { name: "blue_start_top_wall", type: "usable_wall", a: { x: 430, y: 605 }, b: { x: 607.5, y: 605 } },
  { name: "lower_used_weapon_wall", type: "usable_wall", a: { x: -450, y: -344.5 }, b: { x: 450, y: -344.5 } },
  { name: "center_divider_wall", type: "usable_wall", a: { x: 0, y: -605 }, b: { x: 0, y: 605 } },
  { name: "top_red_long_pole_ignore", type: "ignore", a: { x: -430, y: 560 }, b: { x: -300, y: 560 } },
  { name: "top_blue_long_pole_ignore", type: "ignore", a: { x: 300, y: 560 }, b: { x: 430, y: 560 } },
] as const;

export const FIELD_RECTANGLES: readonly FieldRectangle[] = [
  { name: "top_red_long_pole_rack_ignore", type: "ignore", center: { x: -365, y: 560 }, width: 130, height: 18 },
  { name: "top_blue_long_pole_rack_ignore", type: "ignore", center: { x: 365, y: 560 }, width: 130, height: 18 },
  { name: "red_forest_obstacle", type: "usable_wall", center: { x: -307.5, y: 45 }, width: 360, height: 480 },
  { name: "blue_forest_obstacle", type: "usable_wall", center: { x: 307.5, y: 45 }, width: 360, height: 480 },
  { name: "red_left_ramp_zone_450h", type: "solid_obstacle", center: { x: -528.75, y: -404 }, width: 155, height: 148 },
  { name: "blue_right_ramp_zone_450h", type: "solid_obstacle", center: { x: 524.5, y: -404 }, width: 148.5, height: 148.5 },
  { name: "top_center_end_rack_wall", type: "usable_wall", center: { x: 0, y: 505 }, width: 30, height: 120 },
  { name: "bottom_center_barrier_wall", type: "usable_wall", center: { x: -1.25, y: -473.75 }, width: 28, height: 161 },
  { name: "top_red_start_zone_marker", type: "start_zone", center: { x: -552.5, y: 549 }, width: 100, height: 100, visualOnly: true },
  { name: "top_blue_start_zone_marker", type: "start_zone", center: { x: 548.5, y: 548 }, width: 100, height: 100, visualOnly: true },
] as const;

export const NINE_GONG_START_POSES: readonly [NineGongStartPose, NineGongStartPose] = [
  {
    side: "red",
    label: "红区 9gong 起点",
    x: -547.5,
    y: -389,
    yawDeg: 90,
    sideBoundaryDistanceCm: 60,
    lowerBoundaryDistanceCm: 44.5,
  },
  {
    side: "blue",
    label: "蓝区 9gong 起点",
    x: 547.5,
    y: -389,
    yawDeg: 270,
    sideBoundaryDistanceCm: 60,
    lowerBoundaryDistanceCm: 44.5,
  },
] as const;

export interface Dt35Mount {
  name: "DT35-1" | "DT35-2";
  xCm: number;
  yCm: number;
  yawOffsetDeg: number;
  maxRangeCm: number;
}

export const DT35_MOUNTS: readonly [Dt35Mount, Dt35Mount] = [
  { name: "DT35-1", xCm: -40.4, yCm: -3.3, yawOffsetDeg: -90, maxRangeCm: 1000 },
  { name: "DT35-2", xCm: 40.4, yCm: -3.3, yawOffsetDeg: 90, maxRangeCm: 1000 },
];

/** Body +X is right and body +Y is front. Yaw 0 faces world +Y and positive yaw turns clockwise toward +X. */
export function bodyToWorld(pose: Pose, localX: number, localY: number): Point {
  const yaw = pose.yawDeg * Math.PI / 180;
  return {
    x: pose.x + localX * Math.cos(yaw) + localY * Math.sin(yaw),
    y: pose.y - localX * Math.sin(yaw) + localY * Math.cos(yaw),
  };
}

export function headingVector(yawDeg: number): Point {
  const yaw = yawDeg * Math.PI / 180;
  return { x: Math.sin(yaw), y: Math.cos(yaw) };
}

export function dt35YawFromFrame(frame: LocatorFrame): number {
  return frame.h30Valid || frame.h30HasAttitude ? frame.h30YawDeg : frame.posYawDeg;
}

export interface MapViewport {
  width: number;
  height: number;
  padding: number;
  zoom: number;
  panX: number;
  panY: number;
}

export function fitScale(view: Pick<MapViewport, "width" | "height" | "padding">): number {
  return Math.max(0.0001, Math.min(
    Math.max(1, view.width - view.padding * 2) / FIELD_WIDTH_CM,
    Math.max(1, view.height - view.padding * 2) / FIELD_HEIGHT_CM,
  ));
}

export function worldToCanvas(point: Point, view: MapViewport): Point {
  const scale = fitScale(view) * view.zoom;
  return {
    x: view.width / 2 + view.panX + point.x * scale,
    y: view.height / 2 + view.panY - point.y * scale,
  };
}

export function canvasToWorld(point: Point, view: MapViewport): Point {
  const scale = fitScale(view) * view.zoom;
  return {
    x: (point.x - view.width / 2 - view.panX) / scale,
    y: -(point.y - view.height / 2 - view.panY) / scale,
  };
}

export function zoomViewportAt(view: MapViewport, factor: number, anchor: Point): MapViewport {
  const world = canvasToWorld(anchor, view);
  const zoom = Math.min(20, Math.max(0.2, view.zoom * factor));
  const scale = fitScale(view) * zoom;
  return {
    ...view,
    zoom,
    panX: anchor.x - view.width / 2 - world.x * scale,
    panY: anchor.y - view.height / 2 + world.y * scale,
  };
}

export function followPoint(view: MapViewport, point: Point): MapViewport {
  const scale = fitScale(view) * view.zoom;
  return { ...view, panX: -point.x * scale, panY: point.y * scale };
}

interface HitCandidate {
  distance: number;
  point: Point;
  target: string;
  targetType: FieldTargetType;
  incidenceDeg: number;
  direction: Point;
}

function cross(a: Point, b: Point): number { return a.x * b.y - a.y * b.x; }
function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }

function segmentHit(origin: Point, direction: Point, segment: FieldSegment): HitCandidate | null {
  const edge = subtract(segment.b, segment.a);
  const denominator = cross(direction, edge);
  if (Math.abs(denominator) < 1e-9) return null;
  const relative = subtract(segment.a, origin);
  const distance = cross(relative, edge) / denominator;
  const fraction = cross(relative, direction) / denominator;
  if (distance < 1e-6 || fraction < -1e-9 || fraction > 1 + 1e-9) return null;
  const edgeLength = Math.hypot(edge.x, edge.y);
  const normal = edgeLength > 0 ? { x: -edge.y / edgeLength, y: edge.x / edgeLength } : { x: 0, y: 0 };
  const incidenceDeg = Math.acos(Math.min(1, Math.abs(direction.x * normal.x + direction.y * normal.y))) * 180 / Math.PI;
  return {
    distance,
    point: { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance },
    target: segment.name,
    targetType: segment.type,
    incidenceDeg,
    direction: edge,
  };
}

function rectangleEdges(rectangle: FieldRectangle): FieldSegment[] {
  const left = rectangle.center.x - rectangle.width / 2;
  const right = rectangle.center.x + rectangle.width / 2;
  const bottom = rectangle.center.y - rectangle.height / 2;
  const top = rectangle.center.y + rectangle.height / 2;
  return [
    { name: rectangle.name, type: rectangle.type, a: { x: left, y: bottom }, b: { x: right, y: bottom } },
    { name: rectangle.name, type: rectangle.type, a: { x: right, y: bottom }, b: { x: right, y: top } },
    { name: rectangle.name, type: rectangle.type, a: { x: right, y: top }, b: { x: left, y: top } },
    { name: rectangle.name, type: rectangle.type, a: { x: left, y: top }, b: { x: left, y: bottom } },
  ];
}

export function fieldRayHits(origin: Point, yawDeg: number): HitCandidate[] {
  const direction = headingVector(yawDeg);
  const segments = [
    ...FIELD_SEGMENTS,
    ...FIELD_RECTANGLES.filter((rectangle) => !rectangle.visualOnly).flatMap(rectangleEdges),
  ];
  return segments
    .map((segment) => segmentHit(origin, direction, segment))
    .filter((hit): hit is HitCandidate => hit !== null)
    .sort((left, right) => left.distance - right.distance);
}

export type Dt35State = "invalid" | "ok" | "large_residual" | "floor_suspect" | "corner" | "ignored" | "blocked";

export interface Dt35Ray {
  name: string;
  sensor: Point;
  measuredHit: Point;
  displayHit: Point;
  expectedHit: Point | null;
  rayYawDeg: number;
  measuredCm: number;
  displayCm: number;
  expectedCm: number | null;
  residualCm: number | null;
  incidenceDeg: number | null;
  target: string;
  targetType: FieldTargetType | "none";
  valid: boolean;
  clipped: boolean;
  cornerAmbiguous: boolean;
  state: Dt35State;
}

export function computeDt35Ray(frame: LocatorFrame, mount: Dt35Mount, distanceMm: number, statusValid: boolean): Dt35Ray {
  const pose = { x: frame.posXcm, y: frame.posYcm, yawDeg: dt35YawFromFrame(frame) };
  const sensor = bodyToWorld(pose, mount.xCm, mount.yCm);
  const measuredCm = Math.max(0, distanceMm / 10);
  const valid = statusValid && Number.isFinite(measuredCm) && measuredCm > 0 && measuredCm <= mount.maxRangeCm;
  const rayYawDeg = pose.yawDeg + mount.yawOffsetDeg;
  const direction = headingVector(rayYawDeg);
  const hits = fieldRayHits(sensor, rayYawDeg);
  const expected = hits[0] ?? null;
  const drawCm = valid ? measuredCm : mount.maxRangeCm;
  const measuredHit = { x: sensor.x + direction.x * drawCm, y: sensor.y + direction.y * drawCm };
  const clips = new Set<FieldTargetType>(["usable_wall", "solid_obstacle", "blocker"]);
  const clipped = Boolean(expected && clips.has(expected.targetType) && drawCm > expected.distance);
  const displayCm = clipped && expected ? expected.distance : drawCm;
  const displayHit = { x: sensor.x + direction.x * displayCm, y: sensor.y + direction.y * displayCm };
  const residualCm = valid && expected ? measuredCm - expected.distance : null;
  const second = hits[1];
  const cornerAmbiguous = Boolean(expected && second && Math.abs(second.distance - expected.distance) <= 3 && Math.abs(cross(expected.direction, second.direction)) > 1e-6);
  let state: Dt35State = "ok";
  if (!valid) state = "invalid";
  else if (residualCm !== null && residualCm < -12) state = "floor_suspect";
  else if (cornerAmbiguous) state = "corner";
  else if (expected?.targetType === "ignore") state = "ignored";
  else if (expected?.targetType === "blocker") state = "blocked";
  else if (residualCm !== null && Math.abs(residualCm) > 8) state = "large_residual";
  return {
    name: mount.name, sensor, measuredHit, displayHit, expectedHit: expected?.point ?? null,
    rayYawDeg, measuredCm, displayCm, expectedCm: expected?.distance ?? null, residualCm,
    incidenceDeg: expected?.incidenceDeg ?? null, target: expected?.target ?? "no_hit",
    targetType: expected?.targetType ?? "none", valid, clipped, cornerAmbiguous, state,
  };
}

export function dt35Tooltip(ray: Dt35Ray): string {
  const value = (number: number | null): string => number === null ? "—" : `${number.toFixed(1)} cm`;
  return [
    `${ray.name} · ${ray.state}`,
    `目标 ${ray.target} [${ray.targetType}]`,
    `射线 yaw ${ray.rayYawDeg.toFixed(1)}°`,
    `实测 ${value(ray.measuredCm)} / 期望 ${value(ray.expectedCm)}`,
    `残差 ${value(ray.residualCm)} / 入射角 ${ray.incidenceDeg === null ? "—" : `${ray.incidenceDeg.toFixed(1)}°`}`,
    ray.clipped ? `显示已裁剪至 ${ray.target} (${value(ray.displayCm)})` : "显示未裁剪",
  ].join("\n");
}

export function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.min(1, Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}
