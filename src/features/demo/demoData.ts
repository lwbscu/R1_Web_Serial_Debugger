import type { ChassisFrame, LocatorFrame, RemoteFrame, RemoteTxEvent } from "../../protocols";

function wave(t: number, period: number, amplitude = 1, offset = 0): number {
  return offset + Math.sin(t / period) * amplitude;
}

export function demoRemoteFrame(atMs = Date.now()): RemoteFrame {
  const t = atMs / 1000;
  const weak = Math.sin(t / 5) < -0.72;
  return {
    observedAtMs: atMs,
    rawLine: "RDBG,DEMO",
    ms: Math.floor(atMs % 0xFFFFFFFF),
    seq: Math.floor(t * 20) % 65536,
    packetType: "ADC",
    rfCh: 76,
    txRet: weak ? 0 : 1,
    ackLen: weak ? 0 : 8,
    failCount: weak ? Math.max(1, Math.round(wave(t, 0.7, 4, 4))) : 0,
    ackOkCount: Math.floor(t * 18) % 1_000_000,
    signalBars: weak ? 2 : Math.round(wave(t, 2.8, 0.5, 3.5)),
    linkReady: 1,
    linkOnline: 1,
    noAckMs: weak ? Math.round(wave(t, 0.55, 55, 135)) : Math.round(wave(t, 1.2, 8, 18)),
    lost: 0,
    retry: weak ? 4 : 0,
    rxScore: Math.round(wave(t, 3.2, 6, weak ? 68 : 92)),
    localPresent: 1,
    xReason: "none",
  };
}

export function demoRemoteTxEvent(atMs = Date.now()): RemoteTxEvent {
  const t = atMs / 1000;
  const phase = Math.floor(t) % 6;
  const adc = [
    Math.round(wave(t, 1.4, 600, 2048)),
    Math.round(wave(t, 1.9, 520, 2048)),
    Math.round(wave(t, 2.4, 420, 2048)),
    Math.round(wave(t, 2.8, 380, 2048)),
  ];
  const type = phase === 0 ? "MODE" : phase === 1 ? "KEY" : phase === 2 ? "ACT" : "ADC";
  const txBytes = type === "ACT"
    ? [0x5B, 0x02, 0x01, 0x01, 0x01]
    : type === "KEY"
      ? [0x4B, 0x07, 0, 0, 0, 0, 0xA5, 0x5A, 0x33]
      : type === "MODE"
        ? [0x50, 0x01, 0x64, 0, 0x9C, 0xFF, 0, 0xA5, 0x5A]
        : [0x02, adc[0]! & 0xff, adc[0]! >> 8, adc[1]! & 0xff, adc[1]! >> 8, adc[2]! & 0xff, adc[2]! >> 8, adc[3]! & 0xff, adc[3]! >> 8];
  const ackBytes = type === "ACT" ? [0x87, 0x5C, 0x02, 0x01, 0x01, 0x01] : [0x92];
  const args: [number, number, number, number] = type === "ACT" ? [2, 1, 1, 1]
    : type === "KEY" ? [7, 0, 0, 0]
      : type === "MODE" ? [1, 100, -100, 0]
        : [adc[0]!, adc[1]!, adc[2]!, adc[3]!];
  const hex = (items: readonly number[]) => items.map((item) => (item & 0xff).toString(16).toUpperCase().padStart(2, "0")).join("");
  return {
    observedAtMs: atMs,
    rawLine: "RDBG_TX,1,DEMO",
    protocolVersion: 1,
    ms: Math.floor(atMs % 0xFFFFFFFF),
    seq: Math.floor(t * 10) % 65536,
    packetType: type,
    txLen: txBytes.length,
    txHex: hex(txBytes),
    txBytes,
    txRet: 1,
    ackLen: ackBytes.length,
    ackHex: hex(ackBytes),
    ackBytes,
    lost: 0,
    retry: phase === 4 ? 2 : 0,
    args,
  };
}

export function demoChassisFrame(atMs = Date.now()): ChassisFrame {
  const t = atMs / 1000;
  const steering = wave(t, 1.9, 18);
  const frame: ChassisFrame = {
    observedAtMs: atMs,
    rawLine: "CDBG,DEMO",
    protocolVersion: 5,
    fieldCount: 175,
    ms: Math.floor(atMs % 0xFFFFFFFF), seq: Math.floor(t * 20) % 65536,
    locSrc: 1, posX: wave(t, 7, 180), posY: wave(t, 9, 140), yaw: (t * 8) % 360,
    locaterX: wave(t, 7, 180), locaterY: wave(t, 9, 140), locaterYaw: (t * 8) % 360,
    lidarX: wave(t, 7, 181), lidarY: wave(t, 9, 139), lidarYaw: (t * 8) % 360,
    encoderX: wave(t, 7, 178), encoderY: wave(t, 9, 142), h30Yaw: (t * 8) % 360,
    dt35_1: wave(t, 2.3, 80, 860), dt35_2: wave(t, 2.8, 110, 1240),
    nrfScanState: 1, nrfCh: 76, lastSigAgeMs: Math.round(wave(t, 1.1, 8, 16)),
    lastRawAgeMs: Math.round(wave(t, 1.2, 7, 14)), ackScore: Math.round(wave(t, 2.7, 4, 94)),
    packetLossRate: Math.max(0, wave(t, 4, 0.012, 0.018)), packetLostWin: 1, packetTotalWin: 100,
    nrfUpdateMaxMs: 21, nrfAckMaxMs: 18, scanWaitMaxMs: 25, ackWriteCount: Math.floor(t * 19) % 1_000_000, linkReason: 0,
    joyAgeMs: 20, joyValid: 1, joyLx: wave(t, 1.5, 0.8), joyLy: wave(t, 2.1, 0.7), joyRx: 0, joyRy: 0,
    cmdVx: wave(t, 1.5, 1.4), cmdVy: wave(t, 2.1, 1.2), cmdWz: wave(t, 3, 0.6),
    remoteMode: 0, modeAgeMs: 12, modeX: 0, modeY: 0, motionSource: 1, activeMode: 0, autoActive: 0,
    pointQ: 0, threeZoneQ: 0, actionQ: 0, lastModeExecMs: 0, audioCount: 0, audioLastReason: 0,
    audioLastHeader: 0, audioLastData: 0, audioAgeMs: 0, locFrameAgeMs: 18, locRxOk: Math.floor(t * 20) % 1_000_000,
    locRxBad: 0, locChecksumErr: 0, motorFaultMask: 0, canRxCount: Math.floor(t * 80) % 1_000_000, canTxErr: 0, diagDropCount: 0,
    resetFlags: 0, linkAlive: 1, rawScore: 94, chassisState: 0, activeRemoteModeLive: 0,
    stateQ: 0, stateEnqueueDropCount: 0, lastStateApplyAgeMs: 20, lastFrameType: 1,
    validFrameCount: Math.floor(t * 50), badFrameCount: 0, rxWidthErrorCount: 0,
    adcAgeMs: 20, adcCount: Math.floor(t * 40), modeFrameAgeMs: 120,
    modeFrameCount: Math.floor(t * 2), keyAgeMs: 80, keyCount: Math.floor(t),
    taskFrameAgeMs: 100, taskFrameCount: Math.floor(t), nrfUpdateHeartbeatAgeMs: 4,
    nrfAckHeartbeatAgeMs: 6, chassisUpdateHeartbeatAgeMs: 8, communHeartbeatAgeMs: 9,
    ackWriteAgeMs: 22, ackLockFailCount: 0, ackNotifyTimeoutCount: 0, linkRawLostCount: 0,
    linkScanTimeoutCount: 0, linkWeakScanCount: 0, linkRecoverCount: 0, scoreZeroMs: 0,
    nrfSpiErrorCount: 0, nrfSpiLastErrorAgeMs: null, nrfRegAgeMs: 250,
    nrfRegMismatchMask: 0, nrfRegPack0: 0x03_01_01_0f, nrfRegPack1: 0x01_06_0f_4c,
    nrfRegPack2: 0x03_09_11_0e, actionEnqueueOkCount: 0, actionEnqueueDropCount: 0,
    actionDequeueCount: 0, actionDequeueAgeMs: null, mechTxStartCount: 0, mechTxOkCount: 0,
    mechTxFailCount: 0, mechTxInFlightAgeMs: null, mechTxLastDurationMs: null,
    mechTxLastStatus: null, uart1GState: 0, uart1RxState: 0, uart1ErrorCode: 0,
    mechFeedbackOkCount: 0, mechFeedbackBadCount: 0, mechFeedbackQueueDropCount: 0,
    mechFeedbackAgeMs: null, uart1ErrorCount: 0, uart1RearmOkCount: 1,
    uart1RearmFailCount: 0, uart1RxByteCount: 0, uart1RxByteAgeMs: null,
    pointDistanceM: Math.abs(wave(t, 3.1, 0.45, 0.55)),
    pointYawErrorDeg: wave(t, 2.6, 9),
    pointPidOut: wave(t, 3.1, 0.38),
    pointSpeedOutput: wave(t, 3.1, 0.55),
  };
  for (let index = 1; index <= 4; index += 1) {
    frame[`mAge${index}`] = 11 + index;
    frame[`drvCmd${index}`] = wave(t, 1.5 + index * 0.03, 1.2);
    frame[`drvFb${index}`] = Number(frame[`drvCmd${index}`]) * 0.96;
    frame[`steerCmd${index}`] = steering + index * 0.4;
    frame[`steerFb${index}`] = steering + index * 0.4 - wave(t, 1.1, 1.2);
    frame[`steerErr${index}`] = wave(t, 1.1, 1.2);
    frame[`drvPidOut${index}`] = Number(frame[`drvCmd${index}`]);
    frame[`steerPidOut${index}`] = wave(t, 8 + index * 0.4, 900);
    frame[`dgmRecoverCount${index}`] = 0;
    frame[`steerPosPidOut${index}`] = wave(t, 2 + index * 0.2, 120);
    frame[`steerRotorSpeedRpm${index}`] = wave(t, 2.4 + index * 0.2, 180);
  }
  return frame;
}

export function demoLocatorFrame(atMs = Date.now(), elapsedMs = atMs): LocatorFrame {
  const t = atMs / 1000;
  // Hold the origin briefly so the initial (0,0,0) contract is visible and
  // deterministic before the demonstration begins moving.
  const elapsed = Math.max(0, elapsedMs - 2_000) / 1000;
  const angle = elapsed / 7;
  // The demo is deliberately start-relative and begins at (0, 0). Its small
  // footprint stays inside the fixed field when projected from either anchor.
  const x = Math.sin(angle) * 32;
  const y = -(1 - Math.cos(angle * 0.83)) * 55;
  const yaw = ((angle * 180 / Math.PI) * 1.15) % 360;
  return {
    observedAtMs: atMs,
    rawLine: "demo-locator",
    protocol: "r1_csv_v3",
    sourceTimeMs: Math.floor(atMs % 0xFFFFFFFF),
    seq: Math.floor(t * 20) % 65536,
    posXcm: x, posYcm: y, posYawDeg: yaw,
    calibXcm: x + wave(t, 2.1, 5), calibYcm: y + wave(t, 1.8, 4), calibYawDeg: yaw + wave(t, 2.6, 1.5),
    encoderXcm: x - wave(t, 2.7, 8), encoderYcm: y + wave(t, 2.2, 7),
    h30Xcm: 0, h30Ycm: 0, h30YawDeg: yaw + wave(t, 3, 0.8),
    lidarXcm: x + wave(t, 1.7, 3), lidarYcm: y - wave(t, 1.9, 3), lidarYawDeg: yaw + wave(t, 2.2, 1),
    dt35_1mm: 850 + wave(t, 1.3, 160), dt35_2mm: 1180 + wave(t, 1.8, 220), status: 0b1101110,
    h30Valid: true, h30HasAttitude: true, h30HasAccel: true,
    lidarValid: true, lidarOnline: true, dt35_1Valid: true, dt35_2Valid: true,
    xPulseSeen: true, yPulseSeen: true, crcOk: true, crcState: "ok",
    diagnostics: { fps: 20, intervalMs: 50, fusionValid: true },
  };
}
