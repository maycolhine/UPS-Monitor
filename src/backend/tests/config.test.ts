import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("usa padrões seguros sem variáveis de ambiente", () => {
    const config = loadConfig({});
    expect(config.httpPort).toBe(8080);
    expect(config.httpHost).toBe("0.0.0.0");
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:8080");
    expect(config.apiTimeoutMs).toBe(4000);
    expect(config.refreshIntervalMs).toBe(5000);
    expect(config.deviceId).toBe("");
    expect(config.staticDir).toBeNull();
    expect(config.gaugeThresholdsRaw).toBeUndefined();
  });

  it("lê todas as variáveis previstas", () => {
    const config = loadConfig({
      VIEWER_HTTP_HOST: "127.0.0.1",
      VIEWER_HTTP_PORT: "8090",
      VIEWER_STATIC_DIR: "/app/public",
      UPS_API_BASE_URL: "http://192.168.52.68:8080/",
      UPS_API_TIMEOUT_MS: "2500",
      UPS_API_CACHE_TTL_MS: "0",
      UPS_API_IDENTITY_TTL_MS: "120000",
      UPS_DEVICE_ID: "tsshara-3200va-01",
      VIEWER_REFRESH_INTERVAL_MS: "10000",
      VIEWER_LOG_LEVEL: "debug",
      VIEWER_GAUGE_THRESHOLDS: '{"load_percent":{"scale":{"min":0,"max":100}}}',
    });

    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.httpPort).toBe(8090);
    expect(config.staticDir).toBe("/app/public");
    expect(config.apiBaseUrl).toBe("http://192.168.52.68:8080");
    expect(config.apiTimeoutMs).toBe(2500);
    expect(config.apiCacheTtlMs).toBe(0);
    expect(config.apiIdentityTtlMs).toBe(120000);
    expect(config.deviceId).toBe("tsshara-3200va-01");
    expect(config.refreshIntervalMs).toBe(10000);
    expect(config.logLevel).toBe("debug");
    expect(config.gaugeThresholdsRaw).toContain("load_percent");
  });

  it("encerra a configuração com erro quando um valor numérico é inválido", () => {
    expect(() => loadConfig({ UPS_API_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ VIEWER_HTTP_PORT: "99999" })).toThrow(ConfigError);
    expect(() => loadConfig({ VIEWER_REFRESH_INTERVAL_MS: "10" })).toThrow(ConfigError);
  });

  it("recusa endereço-base inválido", () => {
    expect(() => loadConfig({ UPS_API_BASE_URL: "192.168.52.68:8080" })).toThrow(ConfigError);
    expect(() => loadConfig({ UPS_API_BASE_URL: "ftp://192.168.52.68" })).toThrow(ConfigError);
  });

  it("recusa nível de log desconhecido", () => {
    expect(() => loadConfig({ VIEWER_LOG_LEVEL: "verboso" })).toThrow(ConfigError);
  });

  it("trata VIEWER_GAUGE_THRESHOLDS vazio como ausente", () => {
    expect(loadConfig({ VIEWER_GAUGE_THRESHOLDS: "   " }).gaugeThresholdsRaw).toBeUndefined();
  });
});
