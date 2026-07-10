export class ProtocolParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolParseError";
  }
}

export function integer(value: string, field: string): number {
  const text = value.trim();
  const parsed = /^[-+]?0x[\da-f]+$/i.test(text)
    ? Number.parseInt(text.replace(/^([-+])?0x/i, "$1"), 16)
    : Number(text);
  if (!Number.isInteger(parsed)) {
    throw new ProtocolParseError("invalid_integer", `${field} is not an integer: ${value}`);
  }
  return parsed;
}

export function finite(value: string, field: string): number | null {
  const parsed = Number(value.trim());
  if (Number.isNaN(parsed)) {
    throw new ProtocolParseError("invalid_number", `${field} is not numeric: ${value}`);
  }
  return Number.isFinite(parsed) ? parsed : null;
}

export function requiredFinite(value: string, field: string): number {
  const parsed = finite(value, field);
  if (parsed === null) {
    throw new ProtocolParseError("non_finite_number", `${field} is not finite: ${value}`);
  }
  return parsed;
}

export function outcomeError(error: unknown): { kind: "error"; code: string; detail: string } {
  if (error instanceof ProtocolParseError) {
    return { kind: "error", code: error.code, detail: error.message };
  }
  return {
    kind: "error",
    code: "parse_error",
    detail: error instanceof Error ? error.message : String(error),
  };
}
