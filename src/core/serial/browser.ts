import type { SerialPortProvider } from "./types";

export function browserSerialProvider(): SerialPortProvider | null {
  const serial = (navigator as Navigator & { serial?: SerialPortProvider }).serial;
  return serial ?? null;
}

export function supportsWebSerial(): boolean {
  return browserSerialProvider() !== null && window.isSecureContext;
}
