export const BUILD_INFO = {
  commit: import.meta.env.VITE_GIT_COMMIT || "development",
  builtAt: import.meta.env.VITE_BUILD_TIME || new Date().toISOString(),
  remoteSource: "cd0b796e392493c7c1acc46b5059f37c46bd0a66",
  locatorSource: "e6850444fdc3872951a64f8af035b1cffc099a94",
  parsers: { remote: "2.0.0", chassis: "2.0.0", locator: "3.0.0" },
} as const;
