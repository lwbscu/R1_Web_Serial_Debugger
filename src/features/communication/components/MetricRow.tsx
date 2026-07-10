import { useEffect, useId, useState, type KeyboardEvent } from "react";
import type { MetricContext, MetricSpec } from "../metrics";
import { STATUS_COLORS, STATUS_LABELS } from "../metrics";

export interface MetricRowProps {
  spec: MetricSpec;
  context: MetricContext;
}

export function MetricRow({ spec, context }: MetricRowProps) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const tooltipId = useId();
  const value = spec.getter(context);
  const status = spec.evaluator?.(value, context) ?? "unknown";
  const expanded = pinned || hovered || focused;
  useEffect(() => {
    const closeOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tooltipId) setPinned(false);
    };
    window.addEventListener("r1-metric-tooltip-open", closeOther);
    return () => window.removeEventListener("r1-metric-tooltip-open", closeOther);
  }, [tooltipId]);
  const togglePinned = () => setPinned((current) => {
    const next = !current;
    if (next) window.dispatchEvent(new CustomEvent("r1-metric-tooltip-open", { detail: tooltipId }));
    return next;
  });
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePinned();
    } else if (event.key === "Escape") {
      setPinned(false);
      setFocused(false);
    }
  };
  return (
    <div
      className={`diagnostic-metric metric-${status}${expanded ? " tooltip-open" : ""}`}
      tabIndex={0}
      role="button"
      aria-controls={tooltipId}
      aria-describedby={tooltipId}
      aria-expanded={expanded}
      onClick={togglePinned}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ position: "relative", borderLeft: `3px solid ${STATUS_COLORS[status]}` }}
    >
      <div className="diagnostic-metric-heading">
        <span>{spec.title}</span>
        <small>{spec.variable}</small>
      </div>
      <strong style={{ color: STATUS_COLORS[status] }}>{spec.formatter(value)}</strong>
      {spec.unit && <span className="diagnostic-metric-unit">{spec.unit}</span>}
      <span className="sr-only">，状态：{STATUS_LABELS[status]}</span>
      <div id={tooltipId} role="tooltip" className="diagnostic-tooltip" hidden={!expanded}>
        <dl>
          <div><dt>含义</dt><dd>{spec.tooltip.meaning}</dd></div>
          <div><dt>正常范围</dt><dd>{spec.tooltip.normal}</dd></div>
          <div><dt>异常判断</dt><dd>{spec.tooltip.abnormal}</dd></div>
          <div><dt>优先排查</dt><dd>{spec.tooltip.check}</dd></div>
          <div><dt>源码字段</dt><dd><code>{spec.tooltip.source}</code></dd></div>
        </dl>
      </div>
    </div>
  );
}
