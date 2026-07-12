import { describe, expect, it } from "vitest";

import { parseReplayText } from "../../src/core/replay";
import { displayReplayFrame } from "../../src/features/locator/replayDisplay";
import { LocatorProtocolAdapter } from "../../src/protocols";

describe("display frame replay compatibility", () => {
  const adapter = new LocatorProtocolAdapter();

  it("reads the website display_frames.csv schema as start-relative data", () => {
    const [record] = parseReplayText("1000,2000,3,1,2,3,4,5,6,7,8,9,10,11,127", { format: "csv" });
    const frame = displayReplayFrame(record!, adapter);
    expect(frame).toMatchObject({
      sourceTimeMs: 2000, seq: 3,
      posXcm: 1, posYcm: 2, posYawDeg: 3,
      calibXcm: 4, calibYcm: 5, calibYawDeg: 6,
      lidarXcm: 7, lidarYcm: 8, lidarYawDeg: 9,
      dt35_1mm: 10, dt35_2mm: 11, status: 127,
    });
  });

  it("reads named desktop display_frames.csv columns without shifting fields", () => {
    const csv = [
      "capture_elapsed_ms,source_time_ms,seq,pos_x_cm,pos_y_cm,pos_yaw_deg,calib_x_cm,calib_y_cm,calib_yaw_deg,encoder_x_cm,encoder_y_cm,h30_x_cm,h30_y_cm,h30_yaw_deg,lidar_x_cm,lidar_y_cm,lidar_yaw_deg,dt35_1_mm,dt35_2_mm,status",
      "0,2000,3,-555.7,549,12,-550,545,13,-552,547,1,2,14,-551,546,15,800,900,127",
    ].join("\n");
    const [record] = parseReplayText(csv, { format: "csv" });
    const frame = displayReplayFrame(record!, adapter);
    expect(frame).toMatchObject({
      posXcm: -555.7, posYcm: 549, posYawDeg: 12,
      calibXcm: -550, calibYcm: 545, calibYawDeg: 13,
      encoderXcm: -552, encoderYcm: 547,
      h30Xcm: 1, h30Ycm: 2, h30YawDeg: 14,
      lidarXcm: -551, lidarYcm: 546, lidarYawDeg: 15,
    });
  });
});
