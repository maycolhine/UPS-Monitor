/**
 * Ponto de entrada do backend do Web Viewer.
 *
 * Configuração por variáveis de ambiente (ver .env.example e docs/operacao-docker.md).
 * Códigos de saída: 2 = configuração inválida, 1 = falha ao escutar a porta.
 */
import { UpstreamApiClient } from "./apiClient.js";
import { ConfigError, loadConfig, type ViewerConfig } from "./config.js";
import { ViewerService } from "./dashboard.js";
import { applyGaugeOverrides } from "./gaugeConfig.js";
import { createLogger } from "./logger.js";
import { createApp } from "./server.js";

export function start(config: ViewerConfig): { close: () => Promise<void> } {
  const logger = createLogger(config.logLevel, "viewer");
  const gauges = applyGaugeOverrides(config.gaugeThresholdsRaw);
  if (gauges.problems.length > 0) {
    for (const problem of gauges.problems) logger.warn(problem);
  }

  const client = new UpstreamApiClient({ baseUrl: config.apiBaseUrl, timeoutMs: config.apiTimeoutMs });
  const service = new ViewerService({
    client,
    cacheTtlMs: config.apiCacheTtlMs,
    identityTtlMs: config.apiIdentityTtlMs,
    deviceId: config.deviceId,
    refreshIntervalMs: config.refreshIntervalMs,
  });

  const app = createApp({
    service,
    config,
    gauges: gauges.gauges,
    gaugeProblems: gauges.problems,
    logger,
    startedAt: Date.now(),
  });

  const server = app.listen(config.httpPort, config.httpHost, () => {
    logger.info("Web Viewer iniciado", {
      url: `http://${config.httpHost}:${config.httpPort}`,
      upstream: config.apiBaseUrl,
      device_id: config.deviceId === "" ? "(descoberta via /api/v1/ups)" : config.deviceId,
      refresh_interval_ms: config.refreshIntervalMs,
      static_dir: config.staticDir ?? "(nenhum)",
      endpoints: ["GET /healthz", "GET /api/config", "GET /api/dashboard", "GET /api/devices"],
    });
  });

  server.on("error", (error: Error) => {
    logger.error("falha ao escutar a porta HTTP", { port: config.httpPort, message: error.message });
    process.exitCode = 1;
    process.exit(1);
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info("encerrando", { signal });
      void close().then(() => process.exit(0));
    });
  }

  return { close };
}

function main(): void {
  let config: ViewerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`configuração inválida: ${message}\n`);
    process.exit(2);
  }
  start(config);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.js") || entry.endsWith("index.ts")) {
  main();
}
