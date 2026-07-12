export const BUILD_INFO = {
  commit: import.meta.env.VITE_GIT_COMMIT || "development",
  builtAt: import.meta.env.VITE_BUILD_TIME || new Date().toISOString(),
  remoteSource: "142d46257b156826393273290d0f574e53a3f19b",
  locatorSource: "e6850444fdc3872951a64f8af035b1cffc099a94",
  parsers: { remote: "2.1.0", chassis: "5.0.0", locator: "3.0.0" },
} as const;
