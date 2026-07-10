import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
const base = (props: IconProps) => ({ width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...props });

export function LinkIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M8.5 7.5 6 5a3.5 3.5 0 0 0-5 5l3 3a3.5 3.5 0 0 0 5 0l1-1"/><path d="m15.5 16.5 2.5 2.5a3.5 3.5 0 0 0 5-5l-3-3a3.5 3.5 0 0 0-5 0l-1 1"/><path d="m8 16 8-8"/></svg>;
}

export function MapIcon(props: IconProps) {
  return <svg {...base(props)}><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/><circle cx="15" cy="11" r="2"/></svg>;
}

export function WaveIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M2 12h3l2-7 4 14 3-10 2 6h6"/><path d="M2 21h20M3 3v18" opacity=".38"/></svg>;
}

export function ShieldIcon(props: IconProps) {
  return <svg {...base(props)}><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z"/><path d="m9 12 2 2 4-5"/></svg>;
}

export function RecordIcon(props: IconProps) {
  return <svg {...base(props)}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg>;
}

export function InfoIcon(props: IconProps) {
  return <svg {...base(props)}><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></svg>;
}
