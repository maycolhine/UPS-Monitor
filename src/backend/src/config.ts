/**
 * Web Viewer (backend/proxy) configuration.
 *
 * All configuration comes from environment variables — no hardcoded IP in the code.
 * Inconsistent values terminate the process with exit code 2 (same behavior as the
 * acquisition service), so that a typo does not go unnoticed.
 */
import type { LogLevel } from "./logger.js";

export interface ViewerConfig {
  httpHost: string;
  httpPort: number;
  staticDir: string | null;
  apiBaseUrl: string;
  apiTimeoutMs: number;
  apiCacheTtlMs: number;
  apiIdentityTtlMs: number;
  deviceId: string;
  refreshIntervalMs: number;
  logLevel: LogLevel;
  gaugeThresholdsRaw: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return raw.trim();
}

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new ConfigError(`${key} must be numeric (received: '${raw}')`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max} (received: ${value})`);
  }
  return value;
}

function readBaseUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = readString(env, key, fallback);
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("protocol must be http or https");
    }
    return raw.replace(/\/+$/, "");
  } catch (error) {
    throw new ConfigError(`${key} invalid ('${raw}'): ${(error as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ViewerConfig {
  const logLevelRaw = readString(env, "VIEWER_LOG_LEVEL", "info").toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(`VIEWER_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (received: '${logLevelRaw}')`);
  }

  const staticDirRaw = readString(env, "VIEWER_STATIC_DIR", "");
  const thresholdsRaw = env["VIEWER_GAUGE_THRESHOLDS"];

  return {
    httpHost: readString(env, "VIEWER_HTTP_HOST", "0.0.0.0"),
    // 8080 is the default INSIDE the container; on the host publish another port (VIEWER_HTTP_PORT).
    httpPort: readNumber(env, "VIEWER_HTTP_PORT", 8080, { min: 1, max: 65535 }),
    staticDir: staticDirRaw === "" ? null : staticDirRaw,
    // Default for local use (API on the same machine). Inside the container use
    // host.docker.internal or the host network IP — `localhost` is the container.
    apiBaseUrl: readBaseUrl(env, "UPS_API_BASE_URL", "http://127.0.0.1:8080"),
    apiTimeoutMs: readNumber(env, "UPS_API_TIMEOUT_MS", 4000, { min: 200, max: 120000 }),
    apiCacheTtlMs: readNumber(env, "UPS_API_CACHE_TTL_MS", 1500, { min: 0, max: 60000 }),
    apiIdentityTtlMs: readNumber(env, "UPS_API_IDENTITY_TTL_MS", 60000, { min: 0, max: 3600000 }),
    deviceId: readString(env, "UPS_DEVICE_ID", ""),
    refreshIntervalMs: readNumber(env, "VIEWER_REFRESH_INTERVAL_MS", 5000, { min: 1000, max: 600000 }),
    logLevel: logLevelRaw as LogLevel,
    gaugeThresholdsRaw: thresholdsRaw && thresholdsRaw.trim() !== "" ? thresholdsRaw : undefined,
  };
}
