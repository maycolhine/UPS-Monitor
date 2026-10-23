import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchConfig, fetchDashboard, isViewerLevelFailure } from "../src/api/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cliente de API do frontend", () => {
  it("consulta /api/dashboard por GET na própria origem", async () => {
    const mock = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ viewer: {}, telemetry: null }));
    vi.stubGlobal("fetch", mock);

    const result = await fetchDashboard();

    expect(result.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    const [path, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/dashboard");
    expect(init.method).toBe("GET");
  });

  it("envia ?device_id= quando um nobreak é escolhido (um por vez)", async () => {
    const mock = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ viewer: {}, telemetry: null }));
    vi.stubGlobal("fetch", mock);

    await fetchDashboard("sms-ups3200s-01");

    const [path] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/dashboard?device_id=sms-ups3200s-01");
  });

  it("consulta /api/config por GET", async () => {
    const mock = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ gauges: [] }));
    vi.stubGlobal("fetch", mock);

    await fetchConfig();

    const [path] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/config");
  });

  it("mantém o corpo útil em HTTP 503 (estado degradado, não falha total)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ viewer: { device_id: null }, telemetry: null, error: { code: "no_devices_configured", message: "sem dispositivos" } }, 503),
      ),
    );

    const result = await fetchDashboard();

    expect(result.status).toBe(503);
    expect(result.ok).toBe(true);
    expect(result.data).not.toBeNull();
  });

  it("sinaliza erro de rede sem lançar exceção", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await fetchDashboard();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("network_error");
    expect(result.data).toBeNull();
  });

  it("sinaliza resposta sem JSON válido", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })) as unknown as typeof fetch,
    );

    const result = await fetchDashboard();

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_json");
    expect(result.status).toBe(200);
  });

  it("propaga o código de erro do envelope em 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ viewer: {}, error: { code: "upstream_timeout", message: "tempo esgotado" } }, 502),
      ),
    );

    const result = await fetchDashboard();

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: "upstream_timeout", message: "tempo esgotado" });
  });

  it("trata cancelamento (AbortController) sem tratar como falha de rede", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );

    const result = await fetchDashboard();

    expect(result.error?.code).toBe("aborted");
  });
});

describe("isViewerLevelFailure", () => {
  it("considera falha do Web Viewer apenas transporte e JSON ilegível", () => {
    expect(
      isViewerLevelFailure({ ok: false, status: 0, data: null, error: { code: "network_error", message: "sem rota" } }),
    ).toBe(true);
    expect(
      isViewerLevelFailure({ ok: false, status: 200, data: null, error: { code: "invalid_json", message: "html" } }),
    ).toBe(true);
  });

  it("não classifica envelopes da API de origem como falha do Web Viewer", () => {
    for (const [status, code] of [
      [502, "upstream_unreachable"],
      [502, "upstream_timeout"],
      [404, "device_not_found"],
      [404, "no_devices_configured"],
    ] as const) {
      expect(isViewerLevelFailure({ ok: false, status, data: null, error: { code, message: "x" } })).toBe(false);
    }
    expect(isViewerLevelFailure({ ok: true, status: 200, data: null, error: null })).toBe(false);
  });
});
