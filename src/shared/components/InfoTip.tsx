import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./InfoTip.css";

export interface InfoTipProps {
  label: string;
  children: ReactNode;
}

export function InfoTip({ label, children }: InfoTipProps) {
  const tooltipId = useId();
  const rootRef = useRef<HTMLSpanElement>(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    if (!pinned) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPinned(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pinned]);

  return <span ref={rootRef} className={`info-tip${pinned ? " info-tip-pinned" : ""}`}>
    <button
      type="button"
      className="info-tip-trigger"
      aria-label={label}
      aria-expanded={pinned}
      aria-controls={tooltipId}
      aria-describedby={tooltipId}
      onClick={() => setPinned((value) => !value)}
    >i</button>
    <span id={tooltipId} role="tooltip" className="info-tip-content">{children}</span>
  </span>;
}
