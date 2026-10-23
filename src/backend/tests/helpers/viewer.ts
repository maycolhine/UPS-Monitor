/**
 * Starts the Web Viewer server on a free port, pointing to a fake upstream.
 */
import type { AddressInfo } from "node:net";

import { UpstreamApiClient } from "../../src/apiClient.js";
import type { ViewerConfig } from "../../src/config.js";
import { ViewerService } from "../../src/dashboard.js";
import { applyGaugeOverrides } from "../../src/gaugeConfig.js";
import { createLogger } from "../../src/logger.js";
import { createApp } from "../../src/server.js";

export interface StartViewerOptions {
  upstreamBaseUrl: string;
  deviceId?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  identityTtlMs?: number;
  refreshIntervalMs?: number;
  staticDir?: string | null;
  now?: () => number;
}

export interface StartedViewer {
  baseUrl: string;
  service: ViewerService;
  close(): Promise<void>;
}

export async function startViewer(options: StartViewerOptions): Promise<StartedViewer> {
  const config: ViewerConfig = {
    httpHost: "127.0.0.1",
    httpPort: 0,
    staticDir: options.staticDir ?? null,
    apiBaseUrl: options.upstreamBaseUrl,
    apiTimeoutMs: options.timeoutMs ?? 1000,
    apiCacheTtlMs: options.cacheTtlMs ?? 0,
    apiIdentityTtlMs: options.identityTtlMs ?? 0,
    deviceId: options.deviceId ?? "",
    refreshIntervalMs: options.refreshIntervalMs ?? 5000,
    logLevel: "error",
    gaugeThresholdsRaw: undefined,
  };

  const client = new UpstreamApiClient({ baseUrl: config.apiBaseUrl, timeoutMs: config.apiTimeoutMs });
  const service = new ViewerService({
    client,
    cacheTtlMs: config.apiCacheTtlMs,
    identityTtlMs: config.apiIdentityTtlMs,
    deviceId: config.deviceId,
    refreshIntervalMs: config.refreshIntervalMs,
    ...(options.now ? { now: options.now } : {}),
  });

  const gauges = applyGaugeOverrides(config.gaugeThresholdsRaw);
  const app = createApp({
    service,
    config,
    gauges: gauges.gauges,
    gaugeProblems: gauges.problems,
    logger: createLogger("error", "viewer-test"),
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    service,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function getJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}
