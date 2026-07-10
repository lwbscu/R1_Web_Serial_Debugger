import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCdbg, parseLocator, parseRdbg } from "../../src/protocols";

const root = fileURLToPath(new URL("../fixtures/frozen/", import.meta.url));
const text = (name: string) => readFileSync(`${root}${name}`, "utf8").trim();
const expected = JSON.parse(text("expected.json")) as {
  remote: Record<string, unknown>;
  chassis: Record<string, unknown>;
  locator: Record<string, unknown>;
};

describe("frozen real-log compatibility", () => {
  it("matches the canonical Remote sample", () => {
    const outcome = parseRdbg(text("remote_rdbg.log"), 0);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind === "frame") expect(outcome.frame).toMatchObject(expected.remote);
  });

  it("matches the canonical Chassis v2 sample", () => {
    const outcome = parseCdbg(text("chassis_cdbg_v2.log"), 0);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind === "frame") expect(outcome.frame).toMatchObject(expected.chassis);
  });

  it("matches the canonical Locator v3 sample", () => {
    const outcome = parseLocator(text("locator_v3.log"), 0);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind === "frame") expect(outcome.frame).toMatchObject(expected.locator);
  });
});
