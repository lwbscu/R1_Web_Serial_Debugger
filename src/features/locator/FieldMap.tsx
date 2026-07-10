import { useEffect, useRef } from "react";
import type { LocatorFrame } from "../../protocols";
import { bodyToWorld, DT35_MOUNTS, FIELD_BOUNDS, FIELD_RECTANGLES, FIELD_SEGMENTS } from "./geometry";

export interface MapTrails { final: LocatorFrame[]; calib: LocatorFrame[]; lidar: LocatorFrame[] }
export function FieldMap({ frame, trails }: { frame: LocatorFrame | null; trails: MapTrails }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#08111d"; ctx.fillRect(0, 0, width, height);
    const pad = 26;
    const fieldW = FIELD_BOUNDS.maxX - FIELD_BOUNDS.minX;
    const fieldH = FIELD_BOUNDS.maxY - FIELD_BOUNDS.minY;
    const scale = Math.min((width - pad * 2) / fieldW, (height - pad * 2) / fieldH);
    const ox = (width - fieldW * scale) / 2;
    const oy = (height - fieldH * scale) / 2;
    const project = (x: number, y: number): [number, number] => [ox + (x - FIELD_BOUNDS.minX) * scale, oy + (FIELD_BOUNDS.maxY - y) * scale];
    ctx.strokeStyle = "#263b52"; ctx.lineWidth = 1;
    for (let x = -600; x <= 600; x += 100) { const [px] = project(x, 0); ctx.beginPath(); ctx.moveTo(px, oy); ctx.lineTo(px, oy + fieldH * scale); ctx.stroke(); }
    for (let y = -600; y <= 600; y += 100) { const [, py] = project(0, y); ctx.beginPath(); ctx.moveTo(ox, py); ctx.lineTo(ox + fieldW * scale, py); ctx.stroke(); }
    ctx.strokeStyle = "#6d8cab"; ctx.lineWidth = 2; ctx.strokeRect(ox, oy, fieldW * scale, fieldH * scale);
    FIELD_RECTANGLES.forEach(([centerX, centerY, rectWidth, rectHeight, kind]) => {
      const [left, top] = project(centerX - rectWidth / 2, centerY + rectHeight / 2);
      ctx.fillStyle = kind === "solid" ? "rgba(255,102,125,.16)" : kind === "start" ? "rgba(90,176,255,.12)" : kind === "ignore" ? "rgba(120,146,173,.07)" : "rgba(255,191,105,.1)";
      ctx.strokeStyle = kind === "ignore" ? "#40566d" : kind === "solid" ? "#ff667d" : "#806d4c";
      ctx.lineWidth = 1;
      ctx.fillRect(left, top, rectWidth * scale, rectHeight * scale);
      ctx.strokeRect(left, top, rectWidth * scale, rectHeight * scale);
    });
    FIELD_SEGMENTS.forEach(([x1, y1, x2, y2, kind]) => {
      const start = project(x1, y1); const end = project(x2, y2);
      ctx.strokeStyle = kind === "ignore" ? "#40566d" : "#b89b62";
      ctx.lineWidth = kind === "ignore" ? 1 : 2;
      ctx.beginPath(); ctx.moveTo(...start); ctx.lineTo(...end); ctx.stroke();
    });
    const drawTrail = (items: LocatorFrame[], keyX: "posXcm" | "calibXcm" | "lidarXcm", keyY: "posYcm" | "calibYcm" | "lidarYcm", color: string) => {
      if (items.length < 2) return;
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      items.forEach((item, index) => { const [x, y] = project(item[keyX], item[keyY]); if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    };
    drawTrail(trails.final, "posXcm", "posYcm", "#41dba8");
    drawTrail(trails.calib, "calibXcm", "calibYcm", "#ffbf69");
    drawTrail(trails.lidar, "lidarXcm", "lidarYcm", "#5ab0ff");
    if (!frame) return;
    const pose = { x: frame.posXcm, y: frame.posYcm, yawDeg: frame.posYawDeg };
    const [cx, cy] = project(pose.x, pose.y);
    const corners = [[-41.5, -34], [41.5, -34], [41.5, 34], [-41.5, 34]] as const;
    ctx.fillStyle = "rgba(65,219,168,.2)"; ctx.strokeStyle = "#d7fff2"; ctx.lineWidth = 2; ctx.beginPath();
    corners.forEach(([x, y], index) => { const world = bodyToWorld(pose, x, y); const screen = project(world.x, world.y); if (index === 0) ctx.moveTo(...screen); else ctx.lineTo(...screen); }); ctx.closePath(); ctx.fill(); ctx.stroke();
    const heading = bodyToWorld(pose, 0, 55); const [hx, hy] = project(heading.x, heading.y); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
    const ray = (distanceMm: number, valid: boolean, mount: typeof DT35_MOUNTS[number], color: string) => {
      if (!valid || !Number.isFinite(distanceMm) || distanceMm <= 0) return;
      const origin = bodyToWorld(pose, mount.xCm, mount.yCm);
      const angle = (pose.yawDeg + mount.yawOffsetDeg) * Math.PI / 180;
      const end = { x: origin.x + Math.sin(angle) * distanceMm / 10, y: origin.y + Math.cos(angle) * distanceMm / 10 };
      const [sx, sy] = project(origin.x, origin.y); const [ex, ey] = project(end.x, end.y);
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
    };
    ray(frame.dt35_1mm, frame.dt35_1Valid, DT35_MOUNTS[0], "#f18fda");
    ray(frame.dt35_2mm, frame.dt35_2Valid, DT35_MOUNTS[1], "#b494ff");
  }, [frame, trails]);
  return <canvas className="field-canvas" ref={ref} aria-label="R1 定位场地图" />;
}
