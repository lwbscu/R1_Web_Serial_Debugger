import type { ChassisFrame, RemoteFrame } from "../../protocols";

export interface DiagnosticEvent {
  observedAtMs: number;
  kind: string;
  severity: "info" | "warn" | "error";
  detail: string;
}

export function firmwareEventSeverity(kind: string): DiagnosticEvent["severity"] {
  if (/^(?:NRF_LOST|MOTOR_FAULT)$/i.test(kind)) return "error";
  if (/^AUDIO$/i.test(kind)) return "warn";
  return "info";
}

const numberField = (frame: ChassisFrame, name: string): number | null => {
  const value = frame[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const wrap180 = (value: number): number => {
  let result = value;
  while (result > 180) result -= 360;
  while (result <= -180) result += 360;
  return result;
};

export class DiagnosticEventDetector {
  private lastRemoteX = false;
  private lastRemoteCh: number | null = null;
  private lastChassisFast = false;
  private lastChassisYaw: number | null = null;
  private lastChassisAt: number | null = null;
  private latestRemote: RemoteFrame | null = null;
  private latestChassis: ChassisFrame | null = null;

  resetSource(source: "remote" | "chassis"): void {
    if (source === "remote") {
      this.lastRemoteX = false;
      this.lastRemoteCh = null;
      this.latestRemote = null;
      return;
    }
    this.lastChassisFast = false;
    this.lastChassisYaw = null;
    this.lastChassisAt = null;
    this.latestChassis = null;
  }

  reset(): void {
    this.resetSource("remote");
    this.resetSource("chassis");
  }

  acceptRemote(frame: RemoteFrame): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    const isX = frame.signalBars === 0;
    if (isX && !this.lastRemoteX) events.push({ observedAtMs: frame.observedAtMs, kind: "X_ENTER", severity: "error", detail: `remote X: ${frame.xReason}` });
    else if (!isX && this.lastRemoteX) events.push({ observedAtMs: frame.observedAtMs, kind: "X_EXIT", severity: "info", detail: "remote signal recovered" });
    this.lastRemoteX = isX;
    if (this.lastRemoteCh !== null && this.lastRemoteCh !== frame.rfCh) {
      events.push({ observedAtMs: frame.observedAtMs, kind: "RF_CH_CHANGE", severity: "warn", detail: `${this.lastRemoteCh} -> ${frame.rfCh}` });
    }
    this.lastRemoteCh = frame.rfCh;
    if (frame.noAckMs >= 300) events.push({ observedAtMs: frame.observedAtMs, kind: "ACK_TIMEOUT", severity: "warn", detail: `no_ack_ms=${frame.noAckMs}` });
    this.latestRemote = frame;
    return [...events, ...this.channelMismatch(frame.observedAtMs)];
  }

  acceptChassis(frame: ChassisFrame): DiagnosticEvent[] {
    const events: DiagnosticEvent[] = [];
    const scanState = numberField(frame, "nrfScanState");
    const isFast = scanState === 0;
    if (isFast && !this.lastChassisFast) events.push({ observedAtMs: frame.observedAtMs, kind: "CHASSIS_FAST_SCAN", severity: "warn", detail: "chassis entered fast scan" });
    this.lastChassisFast = isFast;
    const locAge = numberField(frame, "locFrameAgeMs");
    if (locAge !== null && locAge > 500) events.push({ observedAtMs: frame.observedAtMs, kind: "LOCATER_FRAME_LOST", severity: "error", detail: `age=${locAge}ms` });
    else if (locAge !== null && locAge > 200) events.push({ observedAtMs: frame.observedAtMs, kind: "LOCATER_FRAME_LOST", severity: "warn", detail: `age=${locAge}ms` });
    const yaw = numberField(frame, "yaw");
    if (yaw !== null && this.lastChassisYaw !== null && this.lastChassisAt !== null) {
      const dt = Math.max(frame.observedAtMs - this.lastChassisAt, 1);
      const step = Math.abs(wrap180(yaw - this.lastChassisYaw));
      if (dt <= 150 && step > 30) events.push({ observedAtMs: frame.observedAtMs, kind: "YAW_SPIKE", severity: "error", detail: `yaw step ${step.toFixed(1)} deg / ${dt.toFixed(0)}ms` });
    }
    this.lastChassisYaw = yaw;
    this.lastChassisAt = frame.observedAtMs;
    this.latestChassis = frame;
    return [...events, ...this.channelMismatch(frame.observedAtMs)];
  }

  private channelMismatch(observedAtMs: number): DiagnosticEvent[] {
    if (!this.latestRemote || !this.latestChassis) return [];
    if (Math.abs(this.latestRemote.observedAtMs - this.latestChassis.observedAtMs) > 1000) return [];
    const chassisChannel = numberField(this.latestChassis, "nrfCh");
    if (chassisChannel === null || chassisChannel >= 250 || chassisChannel === this.latestRemote.rfCh) return [];
    return [{ observedAtMs, kind: "CHANNEL_MISMATCH", severity: "error", detail: `remote=${this.latestRemote.rfCh}, chassis=${chassisChannel}` }];
  }
}
