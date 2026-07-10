import { useEffect, useRef } from "react";

export interface TrendPoint { at: number; value: number }

export function TrendChart({ label, points, color }: { label: string; points: readonly TrendPoint[]; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#243247";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();
    if (points.length < 2) return;
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(1e-6, max - min);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = (index / Math.max(1, points.length - 1)) * width;
      const y = height - 5 - ((point.value - min) / range) * (height - 10);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [points, color]);
  return <figure className="trend"><figcaption>{label}<strong>{numberText(points.at(-1)?.value)}</strong></figcaption><canvas ref={canvasRef} /></figure>;
}

function numberText(value: number | undefined): string {
  return Number.isFinite(value) ? String(Math.round((value ?? 0) * 100) / 100) : "—";
}
