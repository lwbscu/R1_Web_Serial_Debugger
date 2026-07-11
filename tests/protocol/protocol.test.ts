import { describe, expect, it } from "vitest";

import { ChassisProtocolAdapter, parseCdbg, V3_EXTENSION_FIELDS } from "../../src/protocols/cdbg";
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

  it("parses the canonical strict CDBG v3/151 field order", () => {
    expect(V3_EXTENSION_FIELDS).toHaveLength(61);
    const prefix = Array.from({ length: 87 }, (_, index) => String(index + 1));
    const extension = Array.from({ length: 61 }, (_, index) => String(1001 + index));
    const outcome = parseCdbg(["CDBG", "3", "151", ...prefix, ...extension].join(","), 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.protocolVersion).toBe("cdbg-v3");
    expect(outcome.frame).toMatchObject({
      protocolVersion: 3, fieldCount: 151, ms: 1, diagDropCount: 87,
      resetFlags: 1001, uart1RxByteAgeMs: 1061,
    });
  });

  it("normalizes v3 unknown sentinels without touching cumulative counters", () => {
    const prefix = Array.from({ length: 87 }, () => "0");
    const extension = Array.from({ length: 61 }, () => "0");
    const put = (name: string, value: string) => { extension[V3_EXTENSION_FIELDS.indexOf(name as never)] = value; };
    put("lastStateApplyAgeMs", "4294967295");
    put("nrfRegPack0", "4294967295");
    put("lastFrameType", "255");
    put("nrfSpiErrorCount", "4294967295");
    prefix[30] = "4294967295"; // joyAgeMs
    prefix[39] = "255"; // remoteMode
    const outcome = parseCdbg(["CDBG", "3", "151", ...prefix, ...extension].join(","), 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame.lastStateApplyAgeMs).toBeNull();
    expect(outcome.frame.nrfRegPack0).toBeNull();
    expect(outcome.frame.lastFrameType).toBeNull();
    expect(outcome.frame.nrfSpiErrorCount).toBe(0xffffffff);
    expect(outcome.frame.joyAgeMs).toBeNull();
    expect(outcome.frame.remoteMode).toBeNull();
  });

  it.each([
    { label: "truncated", values: ["CDBG", "3", "151", ...Array.from({ length: 147 }, () => "0")], code: "incomplete_frame" },
    { label: "trailing", values: ["CDBG", "3", "151", ...Array.from({ length: 149 }, () => "0")], code: "trailing_fields" },
    { label: "wrong count", values: ["CDBG", "3", "150", ...Array.from({ length: 148 }, () => "0")], code: "unsupported_field_count" },
    { label: "unknown version", values: ["CDBG", "4", "151", ...Array.from({ length: 148 }, () => "0")], code: "unsupported_version" },
  ])("rejects strict v3 $label frames", ({ values, code }) => {
    const outcome = parseCdbg(values.join(","), 2000);
    expect(outcome).toMatchObject({ kind: "error", code });
  });

  it("parses CDBG_BOOT v3 and all seven v3 edge events", () => {
    const adapter = new ChassisProtocolAdapter();
    expect(adapter.parse("CDBG_BOOT,3,151,100,8", 2000)).toMatchObject({
      kind: "event", event: { eventKind: "CDBG_BOOT", sourceTimeMs: 100, fields: [3, 151, 8] },
    });
    const events = {
      NRF_LINK: [1, 2, 3, 4, 5, 6, 7],
      NRF_REG: [1, 2, 3, 4, 5, 6],
      MODE_SYNC: [1, 2, 3, 4, 5, 6],
      MECH_CMD: [1, 2, 3, 4, 5, 6],
      MECH_TX: [1, 2, 3, 4, 5, 6, 7],
      MECH_FB: [1, 2, 3, 4, 5, 6, 7],
      UART1_ERR: [1, 2, 3, 4, 5, 6, 7],
    } as const;
    for (const [kind, fields] of Object.entries(events)) {
      expect(adapter.parse(`CEVT,${kind},101,${fields.join(",")}`, 2000)).toMatchObject({
        kind: "event", event: { eventKind: kind, sourceTimeMs: 101, fields },
      });
    }
    expect(adapter.parse("CEVT,NRF_LINK,101,1,2", 2000)).toMatchObject({ kind: "error", code: "field_count" });
    expect(adapter.parse("CEVT,MECH_TX,101,1,255,255,255,255,255,4294967295", 2000)).toMatchObject({
      kind: "event", event: { fields: [1, null, null, null, null, null, null] },
    });
    expect(adapter.parse("CEVT,AUDIO,101,1,2,3", 2000)).toMatchObject({
      kind: "event", event: { eventKind: "AUDIO", sourceTimeMs: 101, fields: [1, 2, 3] },
    });
    expect(adapter.parse("CEVT,UNKNOWN,101,1", 2000)).toMatchObject({ kind: "error", code: "unsupported_event" });
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
