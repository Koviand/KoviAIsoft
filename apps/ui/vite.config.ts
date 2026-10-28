import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@kovi/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
