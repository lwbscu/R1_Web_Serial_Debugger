export const FIELD_BOUNDS = { minX: -607.5, maxX: 607.5, minY: -605, maxY: 605 } as const;

export const DT35_MOUNTS = [
  { xCm: -40.4, yCm: -3.3, yawOffsetDeg: -90 },
  { xCm: 40.4, yCm: -3.3, yawOffsetDeg: 90 },
] as const;

export const FIELD_SEGMENTS = [
  [-607.5, 430, -607.5, 605, "wall"], [-607.5, 605, -430, 605, "wall"],
  [607.5, 430, 607.5, 605, "wall"], [430, 605, 607.5, 605, "wall"],
  [-450, -344.5, 450, -344.5, "wall"], [0, -605, 0, 605, "wall"],
  [-430, 560, -300, 560, "ignore"], [300, 560, 430, 560, "ignore"],
] as const;

export const FIELD_RECTANGLES = [
  [-365, 560, 130, 18, "ignore"], [365, 560, 130, 18, "ignore"],
  [-307.5, 45, 360, 480, "wall"], [307.5, 45, 360, 480, "wall"],
  [-528.75, -404, 155, 148, "solid"], [524.5, -404, 148.5, 148.5, "solid"],
  [0, 505, 30, 120, "wall"], [-1.25, -473.75, 28, 161, "wall"],
  [-552.5, 549, 100, 100, "start"], [548.5, 548, 100, 100, "start"],
] as const;

/** Body +Y is forward; positive yaw turns the forward vector toward world +X. */
export function bodyToWorld(pose: { x: number; y: number; yawDeg: number }, localX: number, localY: number) {
  const yaw = pose.yawDeg * Math.PI / 180;
  return {
    x: pose.x + localX * Math.cos(yaw) + localY * Math.sin(yaw),
    y: pose.y - localX * Math.sin(yaw) + localY * Math.cos(yaw),
  };
}
