import type { DiagnosisResult } from "./diagnosis";
import type { DiagnosticStatus } from "./metrics";

export interface DiagnosticReportMetric {
  panel: string;
  title: string;
  variable: string;
  value: string;
  status: DiagnosticStatus;
}

export interface DiagnosticReportEvent {
  observedAtMs: number;
  severity: "info" | "warn" | "error";
  kind: string;
  detail: string;
}

export interface DiagnosticReportInput {
  title?: string;
  generatedAtMs: number;
  sessionId?: string;
  diagnosis?: DiagnosisResult;
  metrics?: readonly DiagnosticReportMetric[];
  events?: readonly DiagnosticReportEvent[];
}

const markdownCell = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll(/\r?\n/g, "&lt;br&gt;");

const html = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const reportTitle = (input: DiagnosticReportInput) => input.title?.trim() || "R1 Link Debug Report";
const iso = (milliseconds: number) => Number.isFinite(milliseconds)
  ? new Date(milliseconds).toISOString() : "invalid-time";

export function generateMarkdownDiagnosticReport(input: DiagnosticReportInput): string {
  const lines = [`# ${markdownCell(reportTitle(input))}`, "", `Generated: ${markdownCell(iso(input.generatedAtMs))}`];
  if (input.sessionId) lines.push(`Session: ${markdownCell(input.sessionId)}`);
  if (input.diagnosis) {
    lines.push("", "## Diagnosis", "", `**${markdownCell(input.diagnosis.status)}** — ${markdownCell(input.diagnosis.text)}`);
  }
  if (input.metrics?.length) {
    lines.push("", "## Metrics", "", "| Panel | Metric | Variable | Value | Status |", "|---|---|---|---:|---|");
    input.metrics.forEach((metric) => lines.push(
      `| ${markdownCell(metric.panel)} | ${markdownCell(metric.title)} | ${markdownCell(metric.variable)} | ${markdownCell(metric.value)} | ${markdownCell(metric.status)} |`,
    ));
  }
  if (input.events?.length) {
    lines.push("", "## Events", "", "| Time | Severity | Event | Message |", "|---:|---|---|---|");
    input.events.forEach((event) => lines.push(
      `| ${markdownCell(iso(event.observedAtMs))} | ${markdownCell(event.severity)} | ${markdownCell(event.kind)} | ${markdownCell(event.detail)} |`,
    ));
  }
  return `${lines.join("\n")}\n`;
}

export function generateHtmlDiagnosticReport(input: DiagnosticReportInput): string {
  const metrics = input.metrics?.map((metric) => `<tr><td>${html(metric.panel)}</td><td>${html(metric.title)}</td><td><code>${html(metric.variable)}</code></td><td>${html(metric.value)}</td><td class="${html(metric.status)}">${html(metric.status)}</td></tr>`).join("") ?? "";
  const events = input.events?.map((event) => `<tr><td>${html(iso(event.observedAtMs))}</td><td class="${html(event.severity)}">${html(event.severity)}</td><td>${html(event.kind)}</td><td>${html(event.detail)}</td></tr>`).join("") ?? "";
  const diagnosis = input.diagnosis
    ? `<section class="diagnosis ${html(input.diagnosis.status)}"><h2>Diagnosis</h2><strong>${html(input.diagnosis.status)}</strong><p>${html(input.diagnosis.text)}</p></section>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(reportTitle(input))}</title><style>
:root{font-family:system-ui,sans-serif;color:#e7eef8;background:#0b1118}body{max-width:1200px;margin:auto;padding:28px}h1,h2{color:#fff}small{color:#91a4b7}.diagnosis{padding:16px;border-left:5px solid #91a4b7;background:#101b27}.normal{color:#32d583}.warn{color:#ffc240}.error{color:#ff5260}.unknown{color:#91a4b7}table{width:100%;border-collapse:collapse;margin:12px 0 28px}th,td{padding:8px;border:1px solid #263548;text-align:left}th{background:#132033}code{color:#9fc5eb}</style></head><body>
<h1>${html(reportTitle(input))}</h1><small>Generated: ${html(iso(input.generatedAtMs))}${input.sessionId ? ` · Session: ${html(input.sessionId)}` : ""}</small>
${diagnosis}
${metrics ? `<section><h2>Metrics</h2><table><thead><tr><th>Panel</th><th>Metric</th><th>Variable</th><th>Value</th><th>Status</th></tr></thead><tbody>${metrics}</tbody></table></section>` : ""}
${events ? `<section><h2>Events</h2><table><thead><tr><th>Time</th><th>Severity</th><th>Event</th><th>Message</th></tr></thead><tbody>${events}</tbody></table></section>` : ""}
</body></html>`;
}

export const reportEscaping = { html, markdownCell };
