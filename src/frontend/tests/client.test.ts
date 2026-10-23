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

describe("frontend API client", () => {
  it("queries /api/dashboard via GET on its own origin", async () => {
    const mock = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ viewer: {}, telemetry: null }));
    vi.stubGlobal("fetch", mock);

    const result = await fetchDashboard();

    expect(result.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    const [path, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/dashboard");
    expect(init.method).toBe("GET");
  });

  it("sends ?device_id= when a UPS is selected (one at a time)", async () => {
    const mock = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ viewer: {}, telemetry: null }));
    vi.stubGlobal("fetch", mock);

    await fetchDashboard("sms-ups3200s-01");

    const [path] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/dashboard?device_id=sms-ups3200s-01");
  });

  it("queries /api/config via GET", async () => {
    const mock = vi.fn(async (_path: string, _init: RequestInit) => jsonResponse({ gauges: [] }));
    vi.stubGlobal("fetch", mock);

    await fetchConfig();

    const [path] = mock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/config");
  });

  it("keeps the useful body on HTTP 503 (degraded state, not a total failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ viewer: { device_id: null }, telemetry: null, error: { code: "no_devices_configured", message: "no devices" } }, 503),
      ),
    );

    const result = await fetchDashboard();

    expect(result.status).toBe(503);
    expect(result.ok).toBe(true);
    expect(result.data).not.toBeNull();
  });

  it("signals a network error without throwing", async () => {
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

  it("signals a response without valid JSON", async () => {
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

  it("propagates the envelope error code on 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ viewer: {}, error: { code: "upstream_timeout", message: "timed out" } }, 502),
      ),
    );

    const result = await fetchDashboard();

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: "upstream_timeout", message: "timed out" });
  });

  it("handles cancellation (AbortController) without treating it as a network failure", async () => {
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
  it("treats only transport and unreadable JSON as a Web Viewer failure", () => {
    expect(
      isViewerLevelFailure({ ok: false, status: 0, data: null, error: { code: "network_error", message: "no route" } }),
    ).toBe(true);
    expect(
      isViewerLevelFailure({ ok: false, status: 200, data: null, error: { code: "invalid_json", message: "html" } }),
    ).toBe(true);
  });

  it("does not classify origin API envelopes as a Web Viewer failure", () => {
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
