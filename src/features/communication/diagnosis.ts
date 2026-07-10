import type { ChassisFrame, RemoteFrame } from "../../protocols";
import type { DiagnosticStatus, MetricContext } from "./metrics";

export interface DiagnosisResult {
  text: string;
  status: DiagnosticStatus;
}

export function freshMetricContext(context: MetricContext, nowMs: number, staleAfterMs = 1500): MetricContext {
  return {
    remote: context.remote && nowMs - context.remote.observedAtMs <= staleAfterMs ? context.remote : null,
    chassis: context.chassis && nowMs - context.chassis.observedAtMs <= staleAfterMs ? context.chassis : null,
  };
}

const numberField = (frame: ChassisFrame | null, name: string): number | null => {
  const value = frame?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const maxAbs = (...values: Array<number | null>): number | null =>
  values.some((value) => value === null) ? null : Math.max(...values.map((value) => Math.abs(value!)));

export function remoteLinkStatus(remote: RemoteFrame | null): DiagnosticStatus {
  if (!remote) return "unknown";
  if (remote.signalBars === 0 || remote.xReason !== "none" || remote.noAckMs >= 300) return "error";
  if (remote.signalBars <= 2 || remote.noAckMs >= 100 || remote.failCount > 0) return "warn";
  return "normal";
}

export function chassisNrfStatus({ remote, chassis }: MetricContext): DiagnosticStatus {
  if (!chassis) return "unknown";
  const signalAge = numberField(chassis, "lastSigAgeMs");
  const rawAge = numberField(chassis, "lastRawAgeMs");
  const joyAge = numberField(chassis, "joyAgeMs");
  if ([signalAge, rawAge, joyAge].some((value) => value !== null && value > 500)) return "error";
  const channel = numberField(chassis, "nrfCh");
  const channelMismatch = remote !== null && channel !== null && channel < 250 && remote.rfCh !== channel;
  if (
    channelMismatch || numberField(chassis, "nrfScanState") === 0 ||
    (signalAge !== null && signalAge > 300) || (joyAge !== null && joyAge > 300) ||
    (numberField(chassis, "scanWaitMaxMs") ?? 0) > 45 ||
    (numberField(chassis, "nrfAckMaxMs") ?? 0) > 100
  ) return "warn";
  return "normal";
}

export function locationStatus(chassis: ChassisFrame | null): DiagnosticStatus {
  if (!chassis) return "unknown";
  const pose = ["posX", "posY", "yaw"].map((name) => numberField(chassis, name));
  if (pose.some((value) => value === null)) return "unknown";
  if (
    (numberField(chassis, "locFrameAgeMs") ?? 0) > 500 ||
    (numberField(chassis, "motorFaultMask") ?? 0) > 0 ||
    (numberField(chassis, "canTxErr") ?? 0) > 0
  ) return "error";
  const steerError = maxAbs(
    numberField(chassis, "steerErr1"), numberField(chassis, "steerErr2"),
    numberField(chassis, "steerErr3"), numberField(chassis, "steerErr4"),
  );
  if (
    (numberField(chassis, "locFrameAgeMs") ?? 0) > 200 ||
    (numberField(chassis, "locRxBad") ?? 0) > 0 ||
    (numberField(chassis, "locChecksumErr") ?? 0) > 0 ||
    (steerError !== null && steerError > 30)
  ) return "warn";
  return "normal";
}

const motionName = (value: number): string => ({
  0: "none", 1: "remote", 2: "lock", 3: "point", 4: "merlin", 5: "three_zone", 6: "test_spin",
} as Record<number, string>)[value] ?? "unknown";

const audioReason = (value: number): string => ({
  0: "none", 1: "key8", 2: "remote_v_key", 3: "three_zone_sound", 4: "three_zone_display",
} as Record<number, string>)[value] ?? "unknown";

/** Exact Web equivalent of the frozen Python GUI's `_diagnosis_summary`. */
export function diagnoseLink({ remote, chassis }: MetricContext): DiagnosisResult {
  if (!remote && !chassis) return { text: "Waiting for remote RDBG and chassis CDBG.", status: "unknown" };
  if (!chassis) {
    return remoteLinkStatus(remote) === "normal"
      ? { text: "Remote link looks normal but no chassis CDBG: check chassis USART2, firmware branch, wiring, and GND.", status: "warn" }
      : { text: "No chassis CDBG yet: connect chassis USART2 before judging the chassis NRF path.", status: "warn" };
  }
  const signalAge = numberField(chassis, "lastSigAgeMs");
  const rawAge = numberField(chassis, "lastRawAgeMs");
  if (!remote) {
    return signalAge !== null && signalAge <= 300
      ? { text: "Chassis receives remote packets; remote debug port is not connected or is occupied.", status: "warn" }
      : { text: "Only chassis CDBG is present; remote RDBG is needed to compare TX/ACK behavior.", status: "warn" };
  }

  const remoteStatus = remoteLinkStatus(remote);
  const chassisFresh = signalAge !== null && signalAge <= 300 && rawAge !== null && rawAge <= 300;
  const chassisLost = (signalAge !== null && signalAge > 500) || (rawAge !== null && rawAge > 500);
  if (remoteStatus === "normal" && chassisLost) {
    return { text: "Remote says link is normal but chassis packet age is high: check chassis NRF receive/scan state and CDBG firmware.", status: "error" };
  }
  const joyAge = numberField(chassis, "joyAgeMs");
  if (joyAge !== null && joyAge > 500) {
    return { text: "Chassis is not receiving continuous joystick packets: inspect NRF packet flow before tuning motion logic.", status: "error" };
  }
  const motionSource = numberField(chassis, "motionSource");
  if (motionSource !== null && motionSource !== 0 && motionSource !== 1) {
    return { text: `Wheels are not under direct remote control: motion_source=${motionName(motionSource)} (${motionSource}).`, status: "warn" };
  }
  const audioCount = numberField(chassis, "audioCount");
  const reason = numberField(chassis, "audioLastReason");
  if (audioCount !== null && audioCount > 0 && reason !== null && ![0, 1, 2].includes(reason)) {
    return { text: `Audio was triggered by ${audioReason(reason)} (${reason}); check mode packets or three-zone logic.`, status: "warn" };
  }
  const steerError = maxAbs(
    numberField(chassis, "steerErr1"), numberField(chassis, "steerErr2"),
    numberField(chassis, "steerErr3"), numberField(chassis, "steerErr4"),
  );
  if (steerError !== null && steerError > 30) {
    return { text: "Large steering error: wheel direction is not reaching target, so motion can stutter or twist sideways.", status: "error" };
  }
  const driveCommand = maxAbs(
    numberField(chassis, "drvCmd1"), numberField(chassis, "drvCmd2"),
    numberField(chassis, "drvCmd3"), numberField(chassis, "drvCmd4"),
  );
  const driveFeedback = maxAbs(
    numberField(chassis, "drvFb1"), numberField(chassis, "drvFb2"),
    numberField(chassis, "drvFb3"), numberField(chassis, "drvFb4"),
  );
  if (driveCommand !== null && driveFeedback !== null) {
    if (driveCommand > 0.2 && driveFeedback < 0.05) {
      return { text: "Drive command exists but feedback is still: check CAN, motor power, or driver enable state.", status: "error" };
    }
    if (driveCommand < 0.05 && driveFeedback > 0.2) {
      return { text: "Drive feedback moves while command is zero: check stale command or wrong control source.", status: "error" };
    }
  }
  const locAge = numberField(chassis, "locFrameAgeMs");
  if (locAge !== null && locAge > 500) {
    return { text: "NRF may be OK but locater frame age is high: check chassis-locater USART3 PG frame path.", status: "warn" };
  }
  if ((numberField(chassis, "diagDropCount") ?? 0) > 0) {
    return { text: "CDBG frames were dropped because USART2 was busy; raw logs are still usable but telemetry rate is limited.", status: "warn" };
  }
  if (remoteStatus === "normal" && chassisFresh) {
    return { text: "Remote and chassis NRF look normal; use wheel and audio fields for remaining symptoms.", status: "normal" };
  }
  return { text: "Link is unstable; inspect fail_count, no_ack_ms, last_sig_age_ms, packet_loss_rate, and scan state.", status: "warn" };
}

export const diagnosisInternals = { numberField, maxAbs };
