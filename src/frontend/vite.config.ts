import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// O frontend sempre chama a própria origem (mesmo host/porta) e deixa o backend
// do Web Viewer falar com a API de telemetria. Isso elimina CORS e mantém o
// endereço da API fora do navegador.
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
