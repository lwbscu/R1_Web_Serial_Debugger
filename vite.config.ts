import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";

function gitCommit(): string {
  if (process.env.VITE_GIT_COMMIT) return process.env.VITE_GIT_COMMIT;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "development";
  }
}

const commit = gitCommit();
const builtAt = process.env.VITE_BUILD_TIME ?? new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(commit),
    "import.meta.env.VITE_BUILD_TIME": JSON.stringify(builtAt),
  },
  build: {
    rollupOptions: {
      plugins: [{
        name: "r1-version-manifest",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "version.json",
            source: JSON.stringify({ commit, builtAt }, null, 2),
          });
        },
      }],
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { reporter: ["text", "html"] },
  },
});
