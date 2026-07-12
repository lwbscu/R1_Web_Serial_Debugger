export const BUILD_INFO = {
  commit: import.meta.env.VITE_GIT_COMMIT || "development",
  builtAt: import.meta.env.VITE_BUILD_TIME || new Date().toISOString(),
  contractSha256: "705953ec5e9d13e141cee61f0a9a00109ba433b4bf79a1c177011246c3aa27c3",
  expectedSources: {
    remoteDebug: "a2c0c5ad5eec271ab06c7c130297892569b60228",
    chassis9gongDebug: "715d31c5af27180bf8932fb5bb425db769dd7bf4",
    chassisChongwuRedDebug: "3163b95fd56c01bb7f04f25d21c200a9fbc8830f",
    chassisChongwuBlueDebug: "38f646132496b17030996764eddb16c1744feb50",
    locator: "697b539ed90ceed33ab391b11361d8fba8a43b8d",
    mechanism: "d4cf721d3627a9b8909c1a9b82a1377895eb493d",
  },
  parsers: { remote: "3.0.0", chassis: "6.0.0", locator: "3.1.0" },
} as const;
