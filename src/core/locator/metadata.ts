import {
  LOCATOR_COORDINATE_TRANSFORM_VERSION,
  contextForSide,
  type LocatorCoordinateContext,
  type LocatorMatchType,
  type LocatorSide,
} from "./coordinates";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/**
 * Parses persisted locator rendering metadata without coercion or fallback.
 * Unknown keys, stale transform versions, and anchors inconsistent with the
 * selected side are rejected so old field-space data cannot be shifted twice.
 */
export function parseLocatorCoordinateMetadata(value: unknown): LocatorCoordinateContext | null {
  if (!isRecord(value)) {
    return null;
  }

  const hasCurrentKeys = hasExactKeys(value, ["side", "matchType", "coordinateSpace", "transformVersion", "fieldAnchorCm"]);
  const hasLegacyKeys = hasExactKeys(value, ["side", "coordinateSpace", "transformVersion", "fieldAnchorCm"]);
  if (!hasCurrentKeys && !hasLegacyKeys) return null;
  if (value.side !== "red" && value.side !== "blue") return null;
  if (hasCurrentKeys && value.matchType !== "official" && value.matchType !== "preliminary") return null;
  if (value.coordinateSpace !== "start-relative") return null;
  if (hasCurrentKeys && value.transformVersion !== LOCATOR_COORDINATE_TRANSFORM_VERSION) return null;
  if (hasLegacyKeys && value.transformVersion !== "r1-start-relative-v1") return null;
  if (!isRecord(value.fieldAnchorCm) || !hasExactKeys(value.fieldAnchorCm, ["x", "y", "yawDeg"])) return null;

  const side = value.side as LocatorSide;
  const matchType = hasCurrentKeys ? value.matchType as LocatorMatchType : "official";
  const expected = contextForSide(side, matchType);
  if (
    value.fieldAnchorCm.x !== expected.fieldAnchorCm.x ||
    value.fieldAnchorCm.y !== expected.fieldAnchorCm.y ||
    value.fieldAnchorCm.yawDeg !== expected.fieldAnchorCm.yawDeg
  ) {
    return null;
  }

  return expected;
}
