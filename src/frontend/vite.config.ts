import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The frontend always calls its own origin (same host/port) and lets the Web
// Viewer backend talk to the telemetry API. This eliminates CORS and keeps the
// API address out of the browser.
const backendUrl = process.env["VIEWER_BACKEND_URL"] ?? "http://127.0.0.1:8181";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backendUrl, changeOrigin: true },
      "/healthz": { target: backendUrl, changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
