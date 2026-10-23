/**
 * Configuração do Web Viewer (backend/proxy).
 *
 * Toda a configuração vem de variáveis de ambiente — nada de IP fixo no código.
 * Valores incoerentes encerram o processo com código 2 (mesmo comportamento do
 * serviço de aquisição), para que um erro de digitação não passe em silêncio.
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
    throw new ConfigError(`${key} deve ser numérico (recebido: '${raw}')`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} deve estar entre ${min} e ${max} (recebido: ${value})`);
  }
  return value;
}

function readBaseUrl(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = readString(env, key, fallback);
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("protocolo deve ser http ou https");
    }
    return raw.replace(/\/+$/, "");
  } catch (error) {
    throw new ConfigError(`${key} inválido ('${raw}'): ${(error as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ViewerConfig {
  const logLevelRaw = readString(env, "VIEWER_LOG_LEVEL", "info").toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(`VIEWER_LOG_LEVEL deve ser um de ${LOG_LEVELS.join(", ")} (recebido: '${logLevelRaw}')`);
  }

  const staticDirRaw = readString(env, "VIEWER_STATIC_DIR", "");
  const thresholdsRaw = env["VIEWER_GAUGE_THRESHOLDS"];

  return {
    httpHost: readString(env, "VIEWER_HTTP_HOST", "0.0.0.0"),
    // 8080 é o padrão DENTRO do container; no host publique outra porta (VIEWER_HTTP_PORT).
    httpPort: readNumber(env, "VIEWER_HTTP_PORT", 8080, { min: 1, max: 65535 }),
    staticDir: staticDirRaw === "" ? null : staticDirRaw,
    // Padrão para uso local (API na própria máquina). Dentro do container use
    // host.docker.internal ou o IP de rede do host — `localhost` é o container.
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
