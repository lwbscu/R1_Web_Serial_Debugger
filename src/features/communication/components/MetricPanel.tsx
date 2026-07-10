import type { DiagnosticStatus, MetricContext, MetricSpec } from "../metrics";
import { STATUS_COLORS, STATUS_LABELS } from "../metrics";
import { MetricRow } from "./MetricRow";

export interface MetricPanelProps {
  title: string;
  subtitle: string;
  specs: readonly MetricSpec[];
  context: MetricContext;
  status: DiagnosticStatus;
  initiallyVisible?: number;
}

export function MetricPanel({ title, subtitle, specs, context, status, initiallyVisible }: MetricPanelProps) {
  const primary = initiallyVisible === undefined ? specs : specs.slice(0, initiallyVisible);
  const advanced = initiallyVisible === undefined ? [] : specs.slice(initiallyVisible);
  return (
    <section className={`panel diagnostic-panel panel-${status}`} aria-label={title}>
      <header className="diagnostic-panel-header">
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        <span
          className="diagnostic-status-badge"
          style={{ background: STATUS_COLORS[status], color: "#061019" }}
        >{STATUS_LABELS[status]}</span>
      </header>
      <div className="diagnostic-metric-list">
        {primary.map((spec) => <MetricRow key={spec.key} spec={spec} context={context} />)}
      </div>
      {advanced.length > 0 && (
        <details className="diagnostic-advanced">
          <summary>高级字段（{advanced.length}）</summary>
          <div className="diagnostic-metric-list">
            {advanced.map((spec) => <MetricRow key={spec.key} spec={spec} context={context} />)}
          </div>
        </details>
      )}
    </section>
  );
}
