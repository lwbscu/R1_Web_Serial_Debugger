import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { LocatorFrame } from "../../protocols";
import {
  DT35_MOUNTS,
  FIELD_BOUNDS,
  FIELD_HEIGHT_CM,
  FIELD_RECTANGLES,
  FIELD_SEGMENTS,
  FIELD_WIDTH_CM,
  bodyToWorld,
  canvasToWorld,
  computeDt35Ray,
  distanceToSegment,
  dt35Tooltip,
  fitScale,
  followPoint,
  worldToCanvas,
  zoomViewportAt,
  type Dt35Ray,
  type FieldSegment,
  type MapViewport,
  type Point,
} from "./geometry";

export interface MapTrails { final: LocatorFrame[]; calib: LocatorFrame[]; lidar: LocatorFrame[] }
export type MapLayer = "pos" | "calib" | "lidar" | "dt35" | "field_model" | "grid" | "axes";

export interface FieldMapProps {
  frame: LocatorFrame | null;
  trails: MapTrails;
  initialFollow?: boolean;
  initialLayers?: Partial<Record<MapLayer, boolean>>;
  onMousePositionChange?: (point: Point) => void;
}

const MAP_ASSET = "/assets/map/field_prior_map_clean_labeled_1215x1210cm.png";
const ROBOT_ASSET = "/assets/map/r1_chassis_830mm_texture_1024.png";
const ALL_LAYERS: readonly MapLayer[] = ["pos", "calib", "lidar", "dt35", "field_model", "grid", "axes"];
const LAYER_LABELS: Record<MapLayer, string> = {
  pos: "Final", calib: "Calib", lidar: "LiDAR", dt35: "DT35",
  field_model: "场地模型", grid: "网格", axes: "坐标轴",
};

const overlayStyle: CSSProperties = {
  position: "absolute", zIndex: 5, padding: "8px 10px", border: "1px solid #31475a",
  borderRadius: 5, background: "rgba(5,12,19,.9)", color: "#cde0ee",
  font: "11px/1.45 ui-monospace, Consolas, monospace", boxShadow: "0 5px 20px rgba(0,0,0,.3)",
};

function useMapAssets(): { background: HTMLImageElement | null; robot: HTMLImageElement | null; revision: number } {
  const backgroundRef = useRef<HTMLImageElement | null>(null);
  const robotRef = useRef<HTMLImageElement | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const load = (source: string, destination: { current: HTMLImageElement | null }) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => { if (active) { destination.current = image; setRevision((value) => value + 1); } };
      image.src = source;
    };
    load(MAP_ASSET, backgroundRef);
    load(ROBOT_ASSET, robotRef);
    return () => { active = false; };
  }, []);
  return { background: backgroundRef.current, robot: robotRef.current, revision };
}

function layerDefaults(overrides: FieldMapProps["initialLayers"]): Record<MapLayer, boolean> {
  return Object.fromEntries(ALL_LAYERS.map((layer) => [layer, overrides?.[layer] ?? true])) as Record<MapLayer, boolean>;
}

function targetStyle(type: FieldSegment["type"]): { stroke: string; fill: string; dash?: number[] } {
  if (type === "ignore") return { stroke: "rgba(45,130,255,.9)", fill: "rgba(45,130,255,.14)" };
  if (type === "solid_obstacle") return { stroke: "rgba(80,255,130,.9)", fill: "rgba(80,255,130,.15)" };
  if (type === "blocker") return { stroke: "rgba(255,160,75,.9)", fill: "rgba(255,160,75,.14)" };
  if (type === "start_zone") return { stroke: "rgba(255,65,75,.9)", fill: "rgba(255,65,75,.05)", dash: [6, 5] };
  return { stroke: "rgba(255,65,75,.92)", fill: "rgba(255,65,75,.1)" };
}

function rayStyle(ray: Dt35Ray): { color: string; dashed: boolean } {
  if (ray.state === "invalid") return { color: "rgba(160,160,160,.8)", dashed: true };
  if (ray.state === "floor_suspect") return { color: "#ff6b35", dashed: true };
  if (ray.state === "corner") return { color: "#ff4d4d", dashed: false };
  if (ray.state === "blocked") return { color: "#ff9955", dashed: false };
  if (ray.state === "ignored") return { color: "#b08cff", dashed: false };
  if (ray.state === "large_residual") return { color: "#ffcc33", dashed: false };
  return { color: "#00ffaa", dashed: false };
}

function filteredTrail(
  frames: readonly LocatorFrame[],
  xKey: "posXcm" | "calibXcm" | "lidarXcm",
  yKey: "posYcm" | "calibYcm" | "lidarYcm",
  requireLidar = false,
): LocatorFrame[] {
  const result: LocatorFrame[] = [];
  for (const frame of frames.slice(-5000)) {
    if (requireLidar && !frame.lidarValid) continue;
    const previous = result.at(-1);
    if (previous && Math.abs(frame[xKey] - previous[xKey]) + Math.abs(frame[yKey] - previous[yKey]) < 1) continue;
    result.push(frame);
  }
  return result;
}

function drawPolyline(
  ctx: CanvasRenderingContext2D,
  frames: readonly LocatorFrame[],
  view: MapViewport,
  xKey: "posXcm" | "calibXcm" | "lidarXcm",
  yKey: "posYcm" | "calibYcm" | "lidarYcm",
  color: string,
  requireLidar = false,
): void {
  const points = filteredTrail(frames, xKey, yKey, requireLidar);
  if (points.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((frame, index) => {
    const point = worldToCanvas({ x: frame[xKey], y: frame[yKey] }, view);
    if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
}

function drawFieldModel(ctx: CanvasRenderingContext2D, view: MapViewport): void {
  for (const rectangle of FIELD_RECTANGLES) {
    const style = targetStyle(rectangle.type);
    const topLeft = worldToCanvas({ x: rectangle.center.x - rectangle.width / 2, y: rectangle.center.y + rectangle.height / 2 }, view);
    const scale = fitScale(view) * view.zoom;
    ctx.strokeStyle = style.stroke; ctx.fillStyle = style.fill; ctx.lineWidth = 2; ctx.setLineDash(style.dash ?? []);
    ctx.fillRect(topLeft.x, topLeft.y, rectangle.width * scale, rectangle.height * scale);
    ctx.strokeRect(topLeft.x, topLeft.y, rectangle.width * scale, rectangle.height * scale);
  }
  for (const segment of FIELD_SEGMENTS) {
    if (segment.name.startsWith("field_")) continue;
    const style = targetStyle(segment.type);
    const a = worldToCanvas(segment.a, view); const b = worldToCanvas(segment.b, view);
    ctx.strokeStyle = style.stroke; ctx.lineWidth = 2.5; ctx.setLineDash(style.dash ?? []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
}

function featureAt(world: Point, view: MapViewport, rays: readonly Dt35Ray[], frame: LocatorFrame | null): string | null {
  const thresholdCm = 10 / (fitScale(view) * view.zoom);
  for (const ray of rays) {
    if (distanceToSegment(world, ray.sensor, ray.displayHit) <= thresholdCm || Math.hypot(world.x - ray.displayHit.x, world.y - ray.displayHit.y) <= thresholdCm * 1.5) {
      return dt35Tooltip(ray);
    }
    if (ray.expectedHit && distanceToSegment(world, ray.sensor, ray.expectedHit) <= thresholdCm * .7) return dt35Tooltip(ray);
  }
  if (frame) {
    const yaw = frame.posYawDeg * Math.PI / 180;
    const dx = world.x - frame.posXcm;
    const dy = world.y - frame.posYcm;
    const localX = dx * Math.cos(yaw) - dy * Math.sin(yaw);
    const localY = dx * Math.sin(yaw) + dy * Math.cos(yaw);
    if (Math.abs(localX) <= 41.5 && Math.abs(localY) <= 41.5) {
      return [
        "R1 机器人",
        `Final x=${frame.posXcm.toFixed(2)} cm · y=${frame.posYcm.toFixed(2)} cm`,
        `yaw=${frame.posYawDeg.toFixed(2)}° · H30=${frame.h30YawDeg.toFixed(2)}°`,
        `LiDAR ${frame.lidarOnline ? "在线" : "离线"} · DT35 ${frame.dt35_1Valid ? "1✓" : "1×"}/${frame.dt35_2Valid ? "2✓" : "2×"}`,
      ].join("\n");
    }
  }
  for (const rectangle of [...FIELD_RECTANGLES].reverse()) {
    if (Math.abs(world.x - rectangle.center.x) <= rectangle.width / 2 && Math.abs(world.y - rectangle.center.y) <= rectangle.height / 2) {
      return `${rectangle.name}\n类型 ${rectangle.type}${rectangle.visualOnly ? " · 仅显示" : ""}`;
    }
  }
  for (const segment of [...FIELD_SEGMENTS].reverse()) {
    if (!segment.name.startsWith("field_") && distanceToSegment(world, segment.a, segment.b) <= thresholdCm) return `${segment.name}\n类型 ${segment.type}`;
  }
  return null;
}

export function FieldMap({ frame, trails, initialFollow = true, initialLayers, onMousePositionChange }: FieldMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const raysRef = useRef<Dt35Ray[]>([]);
  const assets = useMapAssets();
  const [size, setSize] = useState({ width: 900, height: 650 });
  const [camera, setCamera] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [follow, setFollow] = useState(initialFollow);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [layers, setLayers] = useState(() => layerDefaults(initialLayers));
  const [hover, setHover] = useState<{ x: number; y: number; world: Point; detail: string | null } | null>(null);
  const viewport = useMemo<MapViewport>(() => ({ ...size, ...camera, padding: 24 }), [size, camera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => setSize({ width: Math.max(1, canvas.clientWidth), height: Math.max(1, canvas.clientHeight) });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!follow || !frame) return;
    setCamera((current) => {
      const next = followPoint({ ...size, ...current, padding: 24 }, { x: frame.posXcm, y: frame.posYcm });
      return { zoom: next.zoom, panX: next.panX, panY: next.panY };
    });
  }, [follow, frame, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio); canvas.height = Math.round(size.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = "#10151c"; ctx.fillRect(0, 0, size.width, size.height);
    const topLeft = worldToCanvas({ x: FIELD_BOUNDS.minX, y: FIELD_BOUNDS.maxY }, viewport);
    const scale = fitScale(viewport) * viewport.zoom;
    if (assets.background) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(assets.background, topLeft.x, topLeft.y, FIELD_WIDTH_CM * scale, FIELD_HEIGHT_CM * scale);
    } else {
      ctx.fillStyle = "#19212a"; ctx.fillRect(topLeft.x, topLeft.y, FIELD_WIDTH_CM * scale, FIELD_HEIGHT_CM * scale);
    }

    if (layers.grid) {
      ctx.strokeStyle = "rgba(120,130,145,.34)"; ctx.lineWidth = 1;
      for (let x = -600; x <= 600; x += 50) { const a = worldToCanvas({ x, y: FIELD_BOUNDS.minY }, viewport); const b = worldToCanvas({ x, y: FIELD_BOUNDS.maxY }, viewport); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      for (let y = -600; y <= 600; y += 50) { const a = worldToCanvas({ x: FIELD_BOUNDS.minX, y }, viewport); const b = worldToCanvas({ x: FIELD_BOUNDS.maxX, y }, viewport); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    if (layers.axes) {
      const x0 = worldToCanvas({ x: FIELD_BOUNDS.minX, y: 0 }, viewport); const x1 = worldToCanvas({ x: FIELD_BOUNDS.maxX, y: 0 }, viewport);
      const y0 = worldToCanvas({ x: 0, y: FIELD_BOUNDS.minY }, viewport); const y1 = worldToCanvas({ x: 0, y: FIELD_BOUNDS.maxY }, viewport);
      ctx.lineWidth = 1.5; ctx.strokeStyle = "#ff6b6b"; ctx.beginPath(); ctx.moveTo(x0.x, x0.y); ctx.lineTo(x1.x, x1.y); ctx.stroke();
      ctx.strokeStyle = "#4dabf7"; ctx.beginPath(); ctx.moveTo(y0.x, y0.y); ctx.lineTo(y1.x, y1.y); ctx.stroke();
    }
    if (layers.field_model) drawFieldModel(ctx, viewport);
    if (layers.pos) drawPolyline(ctx, trails.final, viewport, "posXcm", "posYcm", "rgba(0,255,170,.82)");
    if (layers.calib) drawPolyline(ctx, trails.calib, viewport, "calibXcm", "calibYcm", "rgba(255,192,0,.72)");
    if (layers.lidar) drawPolyline(ctx, trails.lidar, viewport, "lidarXcm", "lidarYcm", "rgba(70,160,255,.76)", true);

    const rays = frame ? [
      computeDt35Ray(frame, DT35_MOUNTS[0], frame.dt35_1mm, frame.dt35_1Valid),
      computeDt35Ray(frame, DT35_MOUNTS[1], frame.dt35_2mm, frame.dt35_2Valid),
    ] : [];
    raysRef.current = rays;
    if (layers.dt35) {
      for (const ray of rays) {
        const style = rayStyle(ray); const a = worldToCanvas(ray.sensor, viewport); const b = worldToCanvas(ray.displayHit, viewport);
        ctx.strokeStyle = style.color; ctx.fillStyle = style.color; ctx.lineWidth = 2; ctx.setLineDash(style.dashed ? [7, 5] : []);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(a.x, a.y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = style.color; ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
        if (ray.expectedHit) {
          const expected = worldToCanvas(ray.expectedHit, viewport);
          const expectedColor = ray.targetType === "ignore" ? "#b08cff" : ray.targetType === "solid_obstacle" ? "#ffa94d" : "#4aa3ff";
          ctx.strokeStyle = expectedColor; ctx.lineWidth = 1.5; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(expected.x, expected.y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = expectedColor; ctx.beginPath(); ctx.arc(expected.x, expected.y, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    if (frame) {
      const pose = { x: frame.posXcm, y: frame.posYcm, yawDeg: frame.posYawDeg };
      const center = worldToCanvas(pose, viewport);
      const sizePx = 83 * scale;
      if (assets.robot) {
        ctx.save(); ctx.translate(center.x, center.y); ctx.rotate((frame.posYawDeg - 90) * Math.PI / 180); ctx.globalAlpha = .94;
        ctx.drawImage(assets.robot, -sizePx / 2, -sizePx / 2, sizePx, sizePx); ctx.restore();
      }
      const corners = [[-41.5, -41.5], [41.5, -41.5], [41.5, 41.5], [-41.5, 41.5]] as const;
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath();
      corners.forEach(([x, y], index) => { const point = worldToCanvas(bodyToWorld(pose, x, y), viewport); if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); }); ctx.closePath(); ctx.stroke();
      const right = worldToCanvas(bodyToWorld(pose, 45.65, 0), viewport);
      const front = worldToCanvas(bodyToWorld(pose, 0, 62.25), viewport);
      ctx.strokeStyle = "#ff6b6b"; ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(right.x, right.y); ctx.stroke();
      ctx.strokeStyle = "#00ffaa"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(center.x, center.y); ctx.lineTo(front.x, front.y); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#10151c"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(center.x, center.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.strokeStyle = "#d0d7de"; ctx.lineWidth = 1.5; ctx.strokeRect(topLeft.x, topLeft.y, FIELD_WIDTH_CM * scale, FIELD_HEIGHT_CM * scale);
  }, [assets.background, assets.robot, frame, trails, layers, viewport, size.width, size.height]);

  const pointerPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const next = zoomViewportAt(viewport, event.deltaY < 0 ? 1.15 : 1 / 1.15, pointerPoint(event));
    setCamera({ zoom: next.zoom, panX: next.panX, panY: next.panY });
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointerPoint(event);
    dragRef.current = { pointerId: event.pointerId, x: point.x, y: point.y, panX: camera.panX, panY: camera.panY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointerPoint(event);
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      setCamera((current) => ({ ...current, panX: drag.panX + point.x - drag.x, panY: drag.panY + point.y - drag.y }));
      return;
    }
    const world = canvasToWorld(point, viewport);
    onMousePositionChange?.(world);
    setHover({ ...point, world, detail: featureAt(world, viewport, layers.dt35 ? raysRef.current : [], frame) });
  };
  const endPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resetView = () => {
    const base = { zoom: 1, panX: 0, panY: 0 };
    if (follow && frame) {
      const next = followPoint({ ...viewport, ...base }, { x: frame.posXcm, y: frame.posYcm });
      setCamera({ zoom: 1, panX: next.panX, panY: next.panY });
    } else setCamera(base);
  };

  return <div className="field-map" style={{ position: "relative", width: "100%", height: "100%", minHeight: 430, overflow: "hidden", background: "#10151c" }}>
    <canvas
      className="field-canvas" ref={canvasRef} aria-label="R1 定位场地图"
      onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={endPointer} onPointerCancel={endPointer} onPointerLeave={() => { if (!dragRef.current) setHover(null); }}
      style={{ cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
    />
    <div className={`map-layer-controls${controlsOpen ? "" : " collapsed"}`} style={{ ...overlayStyle, right: 10, top: 10, display: "grid", gap: 4 }}>
      <div className="map-control-head"><strong>图层</strong><button type="button" className="ghost" aria-expanded={controlsOpen} onClick={() => setControlsOpen((value) => !value)}>{controlsOpen ? "收起" : "展开"}</button></div>
      {controlsOpen && <>{ALL_LAYERS.map((layer) => <label key={layer} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={layers[layer]} onChange={(event) => setLayers((current) => ({ ...current, [layer]: event.target.checked }))} />{LAYER_LABELS[layer]}
      </label>)}
      <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", borderTop: "1px solid #304459", paddingTop: 4 }}>
        <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />跟随机器人
      </label>
      <button className="ghost" type="button" onClick={resetView} style={{ padding: "5px 7px", fontSize: 11 }}>重置视图</button></>}
    </div>
    <div className="map-coordinate-status" style={{ ...overlayStyle, left: 10, bottom: 10, pointerEvents: "none", whiteSpace: "pre-line", maxWidth: 390 }}>
      {hover ? <><strong>X {hover.world.x.toFixed(1)} cm · Y {hover.world.y.toFixed(1)} cm</strong>{hover.detail && <div style={{ color: "#aec5d6", marginTop: 4 }}>{hover.detail}</div>}</> : <span>滚轮缩放 · 拖拽平移 · 悬停查看坐标/模型/DT35</span>}
    </div>
    <div className="map-zoom-status" style={{ ...overlayStyle, right: 10, bottom: 10, pointerEvents: "none" }}>{camera.zoom.toFixed(2)}×</div>
  </div>;
}
