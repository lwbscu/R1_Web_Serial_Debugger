export function numberText(value: unknown, digits = 1): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function clockText(value: number | null | undefined): string {
  return value == null ? "—" : new Date(value).toLocaleTimeString();
}

export function sessionId(prefix: string): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${crypto.randomUUID().slice(0, 6)}`;
}
