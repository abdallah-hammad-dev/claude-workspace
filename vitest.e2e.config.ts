import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { obsidian: fileURLToPath(new URL("./test/stubs/obsidian.ts", import.meta.url)) } },
  test: { include: ["test/e2e/**/*.e2e.ts"], testTimeout: 240_000, environment: "node" },
});
