import { describe, expect, it } from "vitest";

import { parseCdbg } from "../../src/protocols/cdbg";
import { crc16CcittFalse } from "../../src/protocols/crc16";
import { parseLocator } from "../../src/protocols/locator";
import { parseRdbg } from "../../src/protocols/rdbg";

describe("protocol compatibility", () => {
  it("parses RDBG and reports trailing fields", () => {
    const line = "RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none,extra";
    const outcome = parseRdbg(line, 1234);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame).toMatchObject({ seq: 7, rfCh: 76, signalBars: 4, xReason: "none" });
    expect(outcome.warnings).toEqual(["trailing_fields"]);
  });

  it.each([30, 35, 72])("parses CDBG %i-field layouts", (count) => {
    const line = ["CDBG", ...Array.from({ length: count - 1 }, (_, index) => String(index + 1))].join(",");
    const outcome = parseCdbg(line, 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame.fieldCount).toBe(count);
    expect(outcome.frame.ms).toBe(1);
  });

  it("parses strict CDBG v2/90", () => {
    const line = ["CDBG", "2", "90", ...Array.from({ length: 87 }, (_, index) => String(index + 1))].join(",");
    const outcome = parseCdbg(line, 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame).toMatchObject({ protocolVersion: 2, fieldCount: 90, ms: 1, diagDropCount: 87 });
  });

  it("parses locator CSV v3 status bits", () => {
    const outcome = parseLocator("1,2,3,4,5,6,7,8,9,190.5,5221.8,114", 3000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame).toMatchObject({
      protocol: "r1_csv_v3",
      posXcm: 1,
      dt35_1Valid: true,
      dt35_2Valid: true,
      h30Valid: true,
    });
  });

  it("validates R1M CRC16-CCITT-FALSE", () => {
    const fields = ["R1M", "1", "100", "7", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "190", "5222", "114"];
    const body = `${fields.join(",")},`;
    const crc = crc16CcittFalse(body).toString(16).toUpperCase().padStart(4, "0");
    const outcome = parseLocator(`$${body}*${crc}`, 4000, { allowNoCrc: false });
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame.crcOk).toBe(true);
    expect(outcome.frame.seq).toBe(7);
  });
});
