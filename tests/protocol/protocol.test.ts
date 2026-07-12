import { describe, expect, it } from "vitest";

import { ChassisProtocolAdapter, parseCdbg, V3_EXTENSION_FIELDS, V4_EXTENSION_FIELDS, V5_EXTENSION_FIELDS, V6_FIELDS } from "../../src/protocols/cdbg";
import { crc16CcittFalse } from "../../src/protocols/crc16";
import { parseLocator } from "../../src/protocols/locator";
import { parseRdbg, parseRdbgTx, RDBG_TX_FIELD_COUNT, RDBG_TX_V2_FIELD_COUNT, RemoteProtocolAdapter } from "../../src/protocols/rdbg";

describe("protocol compatibility", () => {
  it("parses RDBG and reports trailing fields", () => {
    const line = "RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none,extra";
    const outcome = parseRdbg(line, 1234);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame).toMatchObject({ seq: 7, rfCh: 76, signalBars: 4, xReason: "none" });
    expect(outcome.warnings).toEqual(["trailing_fields"]);
  });

  it("parses RDBG_TX v1 payload and ACK bytes", () => {
    expect(RDBG_TX_FIELD_COUNT).toBe(16);
    const outcome = parseRdbgTx("RDBG_TX,1,100,8,ACT,5,5B02010101,1,6,875C02010101,0,1,2,1,1,1", 1234);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame).toMatchObject({
      packetType: "ACT",
      txLen: 5,
      txBytes: [0x5B, 0x02, 0x01, 0x01, 0x01],
      ackLen: 6,
      ackBytes: [0x87, 0x5C, 0x02, 0x01, 0x01, 0x01],
      args: [2, 1, 1, 1],
    });
  });

  it("parses RDBG_TX v2 payload, optional fields, and derived args", () => {
    expect(RDBG_TX_V2_FIELD_COUNT).toBe(19);
    const outcome = parseRdbgTx("RDBG_TX,2,19,100,8,ACT,5,5B02010101,0,MAX_RT,0,-,15,0x10,0x01,0x2f,0,3,4", 1234);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.frame).toMatchObject({
      protocolVersion: 2,
      packetType: "ACT",
      txRet: 0,
      failReason: "MAX_RT",
      retry: 15,
      statusReg: 0x10,
      fifoStatus: 0x01,
      observeTx: 0x2f,
      linkOnline: 0,
      noAckStreak: 3,
      dropTotal: 4,
      args: [2, 1, 1, 1],
    });
    expect(outcome.frame.ackBytes).toEqual([]);

    const optional = parseRdbgTx("RDBG_TX,2,19,100,9,KEY,2,4B07,1,NA,0,-,0,NA,unknown,-,N/A,unavailable,NA", 1234);
    expect(optional.kind).toBe("frame");
    if (optional.kind !== "frame") return;
    expect(optional.frame).toMatchObject({
      failReason: null,
      statusReg: null,
      fifoStatus: null,
      observeTx: null,
      linkOnline: null,
      noAckStreak: null,
      dropTotal: null,
      args: [7, 0, 0, 0],
    });
  });

  it("rejects malformed RDBG_TX frames", () => {
    expect(parseRdbgTx("RDBG_TX,1,100,8,ACT,5,5B02010101,1,0,-,0,1,2,1,1", 1234)).toMatchObject({ kind: "error", code: "incomplete_frame" });
    expect(parseRdbgTx("RDBG_TX,2,16,100,8,ACT,5,5B02010101,1,0,-,0,1,2,1,1", 1234)).toMatchObject({ kind: "error", code: "incomplete_frame" });
    expect(parseRdbgTx("RDBG_TX,3,100,8,ACT,5,5B02010101,1,0,-,0,1,2,1,1,1", 1234)).toMatchObject({ kind: "error", code: "unsupported_version" });
    expect(parseRdbgTx("RDBG_TX,1,100,8,ACT,5,5B020101ZZ,1,0,-,0,1,2,1,1,1", 1234)).toMatchObject({ kind: "error" });
  });

  it("surfaces RDBG_TX through the remote adapter without breaking RDBG", () => {
    const adapter = new RemoteProtocolAdapter();
    expect(adapter.parse("RDBG,100,7,T,76,0,32,1,20,4,1,1,10,0,2,88,1,none", 1234)).toMatchObject({ kind: "frame" });
    const event = adapter.parse("RDBG_TX,1,100,8,KEY,9,4B0700000000A55A33,2,0,-,0,0,7,0,0,0", 1234);
    expect(event).toMatchObject({ kind: "event", event: { eventKind: "RDBG_TX", sourceTimeMs: 100 } });
  });

  it("keeps RDBG_TX adapter event field order append-compatible", () => {
    const adapter = new RemoteProtocolAdapter();
    const event = adapter.parse("RDBG_TX,2,19,100,8,ACT,5,5B02010101,0,MAX_RT,0,-,15,0x10,0x01,0x2f,0,3,4", 1234);
    expect(event.kind).toBe("event");
    if (event.kind !== "event") return;
    expect(event.event.fields.slice(0, 14)).toEqual([2, 8, "ACT", 5, "5B02010101", 0, 0, "-", 1, 15, 2, 1, 1, 1]);
    expect(event.event.fields.slice(14)).toEqual(["MAX_RT", 0x10, 0x01, 0x2f, 0, 3, 4]);
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

  it("parses CDBG v4/159 motor id order and appended outputs", () => {
    expect(V4_EXTENSION_FIELDS).toEqual([
      "drvPidOut1", "drvPidOut2", "drvPidOut3", "drvPidOut4",
      "steerPidOut1", "steerPidOut2", "steerPidOut3", "steerPidOut4",
    ]);
    const prefix = Array.from({ length: 87 }, (_, index) => String(index + 1));
    const extension = Array.from({ length: 61 }, (_, index) => String(1001 + index));
    const outputs = ["2001", "2002", "2003", "2004", "3001", "3002", "3003", "3004"];
    const outcome = parseCdbg(["CDBG", "4", "159", ...prefix, ...extension, ...outputs].join(","), 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.protocolVersion).toBe("cdbg-v4");
    expect(outcome.frame).toMatchObject({
      protocolVersion: 4, fieldCount: 159, ms: 1, diagDropCount: 87,
      resetFlags: 1001, uart1RxByteAgeMs: 1061,
      drvPidOut1: 2001, drvPidOut4: 2004, steerPidOut1: 3001, steerPidOut4: 3004,
    });
  });

  it("parses CDBG v5/175 point, DGM, steering outer loop, and rotor speed fields", () => {
    expect(V5_EXTENSION_FIELDS).toEqual([
      "pointDistanceM", "pointYawErrorDeg",
      "dgmRecoverCount1", "dgmRecoverCount2", "dgmRecoverCount3", "dgmRecoverCount4",
      "steerPosPidOut1", "steerPosPidOut2", "steerPosPidOut3", "steerPosPidOut4",
      "steerRotorSpeedRpm1", "steerRotorSpeedRpm2", "steerRotorSpeedRpm3", "steerRotorSpeedRpm4",
      "pointPidOut", "pointSpeedOutput",
    ]);
    const prefix = Array.from({ length: 87 }, (_, index) => String(index + 1));
    const extension = Array.from({ length: 61 }, (_, index) => String(1001 + index));
    const v4 = ["2001", "2002", "2003", "2004", "3001", "3002", "3003", "3004"];
    const v5 = [
      "1.25", "-7.5",
      "11", "12", "13", "14",
      "401", "402", "403", "404",
      "501", "502", "503", "504",
      "-0.75", "0.5",
    ];
    const outcome = parseCdbg(["CDBG", "5", "175", ...prefix, ...extension, ...v4, ...v5].join(","), 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.protocolVersion).toBe("cdbg-v5");
    expect(outcome.frame).toMatchObject({
      protocolVersion: 5, fieldCount: 175, ms: 1, diagDropCount: 87,
      drvPidOut1: 2001, steerPidOut4: 3004,
      pointDistanceM: 1.25, pointYawErrorDeg: -7.5,
      dgmRecoverCount1: 11, dgmRecoverCount4: 14,
      steerPosPidOut1: 401, steerPosPidOut4: 404,
      steerRotorSpeedRpm1: 501, steerRotorSpeedRpm4: 504,
      pointPidOut: -0.75, pointSpeedOutput: 0.5,
    });
  });

  it("parses CDBG v6/179 named schema, aliases wheel IDs, and maps optional NA to null", () => {
    expect(V6_FIELDS).toHaveLength(176);
    const values = Array.from({ length: V6_FIELDS.length }, (_, index) => String(index + 1));
    values[V6_FIELDS.indexOf("side_profile")] = "blue";
    values[V6_FIELDS.indexOf("nrf_raw_age_ms")] = "NA";
    values[V6_FIELDS.indexOf("w1_drv_err")] = "-1.5";
    values[V6_FIELDS.indexOf("w4_steer_err")] = "12.25";
    values[V6_FIELDS.indexOf("wheel_id_order")] = "1RF-2RR-3LF-4LR";
    values[V6_FIELDS.indexOf("cdbg_format_version")] = "6";
    values[V6_FIELDS.indexOf("cdbg_declared_count")] = "179";
    values[V6_FIELDS.indexOf("end_token")] = "END";
    const outcome = parseCdbg(["CDBG", "6", "179", ...values].join(","), 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.protocolVersion).toBe("cdbg-v6");
    expect(outcome.frame).toMatchObject({
      protocolVersion: 6,
      fieldCount: 179,
      layoutVariant: "v6",
      declaredFieldCount: 179,
      actualFieldCount: 179,
      sideProfile: "blue",
      nrfRawAgeMs: null,
      lastRawAgeMs: null,
      drvErr1: -1.5,
      steerErr4: 12.25,
      wheelIdOrder: "1RF-2RR-3LF-4LR",
      wheelOrderDescription: "ID1=right-front, ID2=right-rear, ID3=left-front, ID4=left-rear",
    });
  });

  it("accepts legacy CDBG v4 declared 159 with 158 actual tokens as a compatibility layout", () => {
    const payload = Array.from({ length: 155 }, (_, index) => String(index + 1));
    const outcome = parseCdbg(["CDBG", "4", "159", ...payload].join(","), 2000);
    expect(outcome.kind).toBe("frame");
    if (outcome.kind !== "frame") return;
    expect(outcome.protocolVersion).toBe("cdbg-v4-legacy158");
    expect(outcome.warnings).toEqual(["legacy158_declared159_actual158"]);
    expect(outcome.frame).toMatchObject({
      protocolVersion: 4,
      fieldCount: 159,
      declaredFieldCount: 159,
      actualFieldCount: 158,
      layoutVariant: "legacy158",
      compatibilityWarnings: "declared159_actual158",
      dt35_2: null,
    });
  });

  it("does not misclassify an ordinary truncated v4 frame as the historical legacy158 formatter bug", () => {
    const parts = ["CDBG", "4", "159", ...Array.from({ length: 155 }, () => "0")];
    parts[20] = "1"; parts[21] = "76"; parts[24] = "80"; parts[25] = "1.5";
    parts[32] = "0"; parts[34] = "1";
    parts[35] = "0"; parts[36] = "0"; parts[37] = "0"; parts[38] = "0";
    expect(parseCdbg(parts.join(","), 2000)).toMatchObject({ kind: "error", code: "incomplete_frame" });
  });

  it("rejects invalid numeric and guard fields in strict CDBG v6", () => {
    const values = Array.from({ length: V6_FIELDS.length }, () => "0");
    for (const name of ["side_profile", "motion_state", "control_source", "build_short", "act_type", "nrf_last_reason", "uart1_last_error", "uart1_last_isr", "mech_fb_task_raw", "mech_fb_status", "mech_fb_error", "w1_control_owner", "w2_control_owner", "w3_control_owner", "w4_control_owner", "reserved0"]) values[V6_FIELDS.indexOf(name)] = "NA";
    values[V6_FIELDS.indexOf("wheel_id_order")] = "1RF-2RR-3LF-4LR";
    values[V6_FIELDS.indexOf("cdbg_format_version")] = "6";
    values[V6_FIELDS.indexOf("cdbg_declared_count")] = "179";
    values[V6_FIELDS.indexOf("end_token")] = "END";
    values[V6_FIELDS.indexOf("nrf_rx_total")] = "not-a-number";
    expect(parseCdbg(["CDBG", "6", "179", ...values].join(","), 2000)).toMatchObject({ kind: "error" });
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
    { label: "v4 wrong count", values: ["CDBG", "4", "151", ...Array.from({ length: 148 }, () => "0")], code: "unsupported_field_count" },
    { label: "v5 wrong count", values: ["CDBG", "5", "159", ...Array.from({ length: 156 }, () => "0")], code: "unsupported_field_count" },
  ])("rejects strict v3 $label frames", ({ values, code }) => {
    const outcome = parseCdbg(values.join(","), 2000);
    expect(outcome).toMatchObject({ kind: "error", code });
  });

  it("parses CDBG_BOOT v3/v4 and all seven v3 edge events", () => {
    const adapter = new ChassisProtocolAdapter();
    expect(adapter.parse("CDBG_BOOT,3,151,100,8", 2000)).toMatchObject({
      kind: "event", event: { eventKind: "CDBG_BOOT", sourceTimeMs: 100, fields: [3, 151, 8] },
    });
    expect(adapter.parse("CDBG_BOOT,4,159,100,8", 2000)).toMatchObject({
      kind: "event", event: { eventKind: "CDBG_BOOT", sourceTimeMs: 100, fields: [4, 159, 8] },
    });
    expect(adapter.parse("CDBG_BOOT,5,175,100,8", 2000)).toMatchObject({
      kind: "event", event: { eventKind: "CDBG_BOOT", sourceTimeMs: 100, fields: [5, 175, 8] },
    });
    expect(adapter.parse("CDBG_BOOT,6,179,100,8", 2000)).toMatchObject({
      kind: "event", event: { eventKind: "CDBG_BOOT", sourceTimeMs: 100, fields: [6, 179, 8] },
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

  it("parses DBG_META and CEVT v2 events with declared actual token count", () => {
    const adapter = new ChassisProtocolAdapter();
    expect(adapter.parse("DBG_META,1,19,100,chassis,9gongxunbao,JG,repo,branch,0123456789abcdef0123456789abcdef01234567,2026-07-12T00:00:00Z,debug,705953ec5e9d13e1,6,179,2,19,2,0", 2000)).toMatchObject({
      kind: "event",
      event: {
        source: "chassis",
        eventKind: "DBG_META",
        sourceTimeMs: 100,
      },
    });
    expect(adapter.parse("CEVT,2,NRF_LINK,14,101,1,online,RAW_TIMEOUT,101,90,11,1,3,0", 2000)).toMatchObject({
      kind: "event",
      event: {
        eventKind: "NRF_LINK",
        sourceTimeMs: 101,
      },
    });
    expect(adapter.parse("CEVT,2,MECH_FB,15,102,10,11,12,1,1,50,5,OK,NA,7", 2000)).toMatchObject({
      kind: "event",
      event: {
        eventKind: "MECH_FB",
        sourceTimeMs: 102,
        fields: [1, null, null, "OK", 1, null, null, 10, 11, 12, 50, 5, null, 7],
      },
    });
    expect(adapter.parse("CEVT,2,NRF_LINK,9,101,1,2,3,4,5", 2000)).toMatchObject({ kind: "error", code: "field_count" });
  });

  it("routes DBG_META by role and parses role-neutral CEVT in a bound remote adapter", () => {
    const meta = "DBG_META,1,19,100,remote,r1,remote,repo,branch,0123456789abcdef0123456789abcdef01234567,2026-07-12T00:00:00Z,debug,705953ec5e9d13e1,0,0,2,19,2,0";
    expect(new RemoteProtocolAdapter().parse(meta, 2000)).toMatchObject({ kind: "event", event: { source: "remote", eventKind: "DBG_META" } });
    expect(new RemoteProtocolAdapter().parse("CEVT,2,NRF_TX,14,101,1,7,1,OK,6,0,14,1,32", 2000)).toMatchObject({ kind: "event", event: { source: "remote", eventKind: "NRF_TX" } });
    expect(new ChassisProtocolAdapter().parse(meta, 2000)).toMatchObject({ kind: "error", code: "wrong_role" });
    expect(new RemoteProtocolAdapter().parse(meta.replace("705953ec5e9d13e1", "deadbeefdeadbeef"), 2000)).toMatchObject({ kind: "error", code: "contract_mismatch" });
    expect(new RemoteProtocolAdapter().parse("CEVT,2,NRF_TX,13,101,1,7,1,OK,6,0,14,1", 2000)).toMatchObject({ kind: "error", code: "field_count" });
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
