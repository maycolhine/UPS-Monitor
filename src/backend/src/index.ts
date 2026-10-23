/**
 * Entry point of the Web Viewer backend.
 *
 * Configuration via environment variables (see .env.example and docs/docker-operation.md).
 * Exit codes: 2 = invalid configuration, 1 = failure to listen on the port.
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
    logger.info("Web Viewer started", {
      url: `http://${config.httpHost}:${config.httpPort}`,
      upstream: config.apiBaseUrl,
      device_id: config.deviceId === "" ? "(discovery via /api/v1/ups)" : config.deviceId,
      refresh_interval_ms: config.refreshIntervalMs,
      static_dir: config.staticDir ?? "(none)",
      endpoints: ["GET /healthz", "GET /api/config", "GET /api/dashboard", "GET /api/devices"],
    });
  });

  server.on("error", (error: Error) => {
    logger.error("failed to listen on the HTTP port", { port: config.httpPort, message: error.message });
    process.exitCode = 1;
    process.exit(1);
  });

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info("shutting down", { signal });
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
    process.stderr.write(`invalid configuration: ${message}\n`);
    process.exit(2);
  }
  start(config);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.js") || entry.endsWith("index.ts")) {
  main();
}
