export interface RemoteFrame {
  observedAtMs: number;
  rawLine: string;
  ms: number;
  seq: number;
  packetType: string;
  rfCh: number;
  txRet: number;
  ackLen: number;
  failCount: number;
  ackOkCount: number;
  signalBars: number;
  linkReady: number;
  linkOnline: number;
  noAckMs: number;
  lost: number;
  retry: number;
  rxScore: number;
  localPresent: number;
  xReason: string;
}

export interface RemoteTxEvent {
  observedAtMs: number;
  rawLine: string;
  protocolVersion: 1;
  ms: number;
  seq: number;
  packetType: string;
  txLen: number;
  txHex: string;
  txBytes: number[];
  txRet: number;
  ackLen: number;
  ackHex: string;
  ackBytes: number[];
  lost: number;
  retry: number;
  args: [number, number, number, number];
}

export interface ChassisFrame {
  observedAtMs: number;
  rawLine: string;
  protocolVersion: number;
  fieldCount: number;
  [field: string]: string | number | null;
}

export interface LocatorFrame {
  observedAtMs: number;
  rawLine: string;
  protocol: "r1m" | "r1_csv_v2" | "r1_csv_v3" | "legacy_csv";
  sourceTimeMs: number;
  seq: number;
  posXcm: number;
  posYcm: number;
  posYawDeg: number;
  calibXcm: number;
  calibYcm: number;
  calibYawDeg: number;
  encoderXcm: number;
  encoderYcm: number;
  h30Xcm: number;
  h30Ycm: number;
  h30YawDeg: number;
  lidarXcm: number;
  lidarYcm: number;
  lidarYawDeg: number;
  dt35_1mm: number;
  dt35_2mm: number;
  status: number;
  h30Valid: boolean;
  h30HasAttitude: boolean;
  h30HasAccel: boolean;
  lidarValid: boolean;
  lidarOnline: boolean;
  dt35_1Valid: boolean;
  dt35_2Valid: boolean;
  xPulseSeen: boolean;
  yPulseSeen: boolean;
  crcOk: boolean;
  crcState: "ok" | "no_crc";
  diagnostics: Record<string, number | boolean>;
}
