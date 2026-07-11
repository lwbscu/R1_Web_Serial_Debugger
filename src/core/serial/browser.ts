import type { AuthorizedSerialPortProvider, SerialPortProvider } from "./types";

export function browserSerialApi(): AuthorizedSerialPortProvider | null {
  const serial = (navigator as Navigator & { serial?: AuthorizedSerialPortProvider }).serial;
  return serial ?? null;
}

export function browserSerialProvider(): SerialPortProvider | null {
  return browserSerialApi();
}

export function supportsWebSerial(): boolean {
  return browserSerialProvider() !== null && window.isSecureContext;
}
