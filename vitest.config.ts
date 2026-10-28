import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@kovi/shared": path.resolve(__dirname, "packages/shared/src/index.ts"),
      "@kovi/core": path.resolve(__dirname, "packages/core/src/index.ts"),
    },
  },
});
