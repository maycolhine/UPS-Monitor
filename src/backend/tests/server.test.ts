import { afterEach, describe, expect, it } from "vitest";

import { respondJson, startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";
import {
  deviceId,
  deviceNotFound,
  devicesEmpty,
  devicesOk,
  healthOk,
  identityOk,
  identitySms,
  smsDeviceId,
  testAbort,
  testAccept,
  testCooldownError,
  testId,
  testReportCompleted,
  testReportRunning,
  telemetryNoData,
  telemetryOk,
  telemetrySms,
  telemetryStale,
  testsListOk,
} from "./helpers/fixtures.js";
import { getJson, startViewer, type StartedViewer } from "./helpers/viewer.js";

let upstream: FakeUpstream | null = null;
let viewer: StartedViewer | null = null;

afterEach(async () => {
  if (viewer) {
    await viewer.close();
    viewer = null;
  }
  if (upstream) {
    await upstream.close();
    upstream = null;
  }
});

const okRoutes = () => ({
  "/health": { status: 200, payload: healthOk },
  "/api/v1/ups": { status: 200, payload: devicesOk },
  [`/api/v1/ups/${deviceId}/telemetry`]: { status: 200, payload: telemetryOk },
  [`/api/v1/ups/${deviceId}/identity`]: { status: 200, payload: identityOk },
  [`/api/v1/ups/${deviceId}/tests?limit=10`]: { status: 200, payload: testsListOk },
});

const notFound = { status: 404, payload: deviceNotFound };

describe("GET /api/dashboard — happy path", () => {
  it("forwards the telemetry without renaming or reinterpreting fields", async () => {
    upstream = await startFakeUpstream((req, res, requests) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
      void requests;
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(200);
    expect(body.telemetry).toEqual(telemetryOk);
    expect(body.identity).toEqual(identityOk);
    expect(body.health).toEqual(healthOk);
    expect(body.devices).toEqual(devicesOk);
    expect(body.viewer.read_only).toBe(true);
    expect(body.viewer.upstream).toMatchObject({
      reachable: true,
      http_status: 200,
      error: null,
    });
    expect(body.viewer.upstream_contract).toEqual({ api_version: "v1", contract_version: "3.0" });
    expect(body.viewer.warnings).toEqual([]);
    expect(body.viewer.sources.telemetry).toMatchObject({ ok: true, http_status: 200, error: null });
    // The battery test history (contract 3.0) accompanies the dashboard.
    expect(body.tests).toEqual(testsListOk);
    expect(body.viewer.sources.tests).toMatchObject({ ok: true, http_status: 200, error: null });
  });

  it("does not bring down the dashboard when the test history does not exist (404 in the API)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url?.includes("/tests")) {
        respondJson(res, 404, { api_version: "v1", contract_version: "3.0", error: { code: "not_found", message: "no history" } });
        return;
      }
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(200);
    expect(body.tests).toBeNull();
    expect(body.viewer.sources.tests.ok).toBe(true);
    expect(body.viewer.sources.tests.error.code).toBe("upstream_unexpected_status");
    // The absence of the history does not contaminate the panel's global warnings.
    expect(body.viewer.warnings).toEqual([]);
  });

  it("discovers the device via /api/v1/ups when UPS_DEVICE_ID is empty", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(body.viewer.device_id).toBe(deviceId);
    expect(body.viewer.device_discovered).toBe(true);
    const telemetryRequest = upstream.requests.find((request) => request.url.endsWith("/telemetry"));
    expect(telemetryRequest?.url).toBe(`/api/v1/ups/${deviceId}/telemetry`);
  });

  it("uses the device_id from /health when the device list comes back empty", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === "/api/v1/ups") {
        respondJson(res, 200, devicesEmpty);
        return;
      }
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(200);
    expect(body.viewer.device_id).toBe(deviceId);
  });

  it("respects a pinned UPS_DEVICE_ID and does not query the device list", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(body.viewer.device_discovered).toBe(false);
    expect(upstream.requests.some((request) => request.url === "/api/v1/ups")).toBe(false);
  });

  it("?device_id= chooses which UPS is displayed (SMS, another protocol)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === `/api/v1/ups/${smsDeviceId}/telemetry`) {
        respondJson(res, 200, telemetrySms);
        return;
      }
      if (req.url === `/api/v1/ups/${smsDeviceId}/identity`) {
        respondJson(res, 200, identitySms);
        return;
      }
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard?device_id=${smsDeviceId}`);

    expect(status).toBe(200);
    expect(body.viewer.device_id).toBe(smsDeviceId);
    expect(body.telemetry).toEqual(telemetrySms);
    expect(body.telemetry.data.battery.charge_percent).toBe(100);
    expect(body.telemetry.data.status.raw_byte).toBe(41);
  });

  it("?device_id= unknown → 404 device_not_found (without querying blindly)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard?device_id=nonexistent`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("device_not_found");
    expect(upstream.requests.some((request) => request.url.includes("/nonexistent/"))).toBe(false);
  });

  it("uses only GET on the upstream API", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(upstream.requests.length).toBeGreaterThan(0);
    expect(upstream.requests.every((request) => request.method === "GET")).toBe(true);
  });
});

describe("GET /api/dashboard — degraded states and failures", () => {
  it("stale telemetry (503 + stale) → 200 with an explicit warning and data preserved", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === `/api/v1/ups/${deviceId}/telemetry`) {
        respondJson(res, 503, telemetryStale);
        return;
      }
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(200);
    expect(body.telemetry.stale).toBe(true);
    expect(body.telemetry.telemetry_valid).toBe(false);
    expect(body.telemetry.communication.state).toBe("stale");
    expect(body.telemetry.communication.last_error.code).toBe("timeout");
    expect(body.telemetry.data.measurements.input_voltage_v).toBe(219);
    expect(body.viewer.sources.telemetry.http_status).toBe(503);
  });

  it("collector with no reading (503 + data null) → 200 without fictitious values", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === `/api/v1/ups/${deviceId}/telemetry`) {
        respondJson(res, 503, telemetryNoData);
        return;
      }
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(200);
    expect(body.telemetry.data).toBeNull();
    expect(body.telemetry.data_available).toBe(false);
    expect(body.telemetry.communication.state).toBe("starting");
  });

  it("API unavailable (network refused) → 502 upstream_unreachable", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    viewer = await startViewer({ upstreamBaseUrl: baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_unreachable");
    expect(body.viewer.upstream.reachable).toBe(false);
    expect(body.telemetry).toBeUndefined();
  });

  it("a discovery failure records the error in viewer.upstream (it does not stay null)", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    // Without UPS_DEVICE_ID: discovery via /api/v1/ups is the only path.
    viewer = await startViewer({ upstreamBaseUrl: baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_unreachable");
    expect(body.viewer.device_id).toBeNull();
    expect(body.viewer.upstream.reachable).toBe(false);
    expect(body.viewer.upstream.error.code).toBe("upstream_unreachable");
  });

  it("slow API → 502 upstream_timeout", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      setTimeout(() => respondJson(res, 200, healthOk), 400);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId, timeoutMs: 60 });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_timeout");
  });

  it("a response that is not JSON → 502 upstream_invalid_json", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>portal</html>");
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_invalid_json");
  });

  it("JSON outside the contract → 502 upstream_contract_mismatch", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, { status: "ok" }));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_contract_mismatch");
    expect(body.viewer.warnings.length).toBeGreaterThan(0);
  });

  it("nonexistent device in the API → 404 device_not_found", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 404, deviceNotFound));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId: "nonexistent" });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("device_not_found");
    expect(body.viewer.sources.telemetry.error.code).toBe("device_not_found");
  });

  it("with no device available → 404 no_devices_configured", async () => {
    const healthWithoutDevices = { ...healthOk, devices: {} };
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === "/api/v1/ups") {
        respondJson(res, 200, devicesEmpty);
        return;
      }
      if (req.url === "/health") {
        respondJson(res, 200, healthWithoutDevices);
        return;
      }
      respondJson(res, notFound.status, notFound.payload);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("no_devices_configured");
  });
});

describe("battery test actions (contract 3.0)", () => {
  it("POST /api/tests forwards the request and returns 202 with the acceptance", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/tests")) {
        respondJson(res, 202, testAccept);
        return;
      }
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "duration_10s" }),
    });

    expect(status).toBe(202);
    expect(body.accept).toMatchObject({ test_id: testId, status: "running" });
    // The POST is the ONLY write sent to the upstream API, and nothing is triggered without the request.
    const post = upstream.requests.find((request) => request.method === "POST");
    expect(post?.url).toBe(`/api/v1/ups/${deviceId}/tests`);
    expect(upstream.requests.every((request) => request.method === "POST" || request.method === "GET")).toBe(true);
  });

  it("preserves the API's 409 test_cooldown (the interface explains the real reason)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/tests")) {
        respondJson(res, 409, testCooldownError);
        return;
      }
      respondJson(res, 404, deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests`, { method: "POST" });

    expect(status).toBe(409);
    expect(body.error.code).toBe("test_cooldown");
  });

  it("GET /api/tests/{id} follows the report (partial and complete)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url === `/api/v1/ups/${deviceId}/tests/${testId}`) {
        respondJson(res, 200, testReportRunning);
        return;
      }
      respondJson(res, 404, deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const running = await getJson(`${viewer.baseUrl}/api/tests/${testId}`);
    expect(running.status).toBe(200);
    expect(running.body.report.status).toBe("running");
    expect(running.body.report.deltas.metrics).toBeUndefined();

    upstream.setHandler((req, res) => {
      if (req.url === `/api/v1/ups/${deviceId}/tests/${testId}`) {
        respondJson(res, 200, testReportCompleted);
        return;
      }
      respondJson(res, 404, deviceNotFound);
    });

    const done = await getJson(`${viewer.baseUrl}/api/tests/${testId}`);
    expect(done.status).toBe(200);
    expect(done.body.report.status).toBe("completed");
    expect(done.body.report.test_flag_observed).toBe(true);
    expect(done.body.report.deltas.metrics.battery_charge_percent.delta).toBe(-7.5);
    expect(done.body.report.estimate.estimated_runtime_min).toBe(2.2);
  });

  it("POST /api/tests/{id}/abort returns 202 with the cancellation", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/abort")) {
        respondJson(res, 202, testAbort);
        return;
      }
      respondJson(res, 404, deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests/${testId}/abort`, {
      method: "POST",
    });

    expect(status).toBe(202);
    expect(body.abort).toMatchObject({ test_id: testId, status: "aborting" });
  });

  it("nonexistent test → 404 test_not_found forwarded from the API", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      respondJson(res, 404, {
        api_version: "v1",
        contract_version: "3.0",
        error: { code: "test_not_found", message: "test not found" },
      });
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests/nonexistent`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("test_not_found");
  });

  it("no device to resolve the action → 404 no_devices_configured", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, devicesEmpty));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests`, { method: "POST" });

    expect(status).toBe(404);
    expect(body.error.code).toBe("no_devices_configured");
  });
});

describe("viewer server", () => {
  it("GET /healthz responds 200 even with the API unavailable", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    viewer = await startViewer({ upstreamBaseUrl: baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/healthz`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", read_only: true, service: "ups-monitor-viewer" });
  });

  it("GET /api/config publishes metrics, provisional bands and the refresh interval", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, refreshIntervalMs: 5000 });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/config`);

    expect(status).toBe(200);
    expect(body.viewer.refresh_interval_ms).toBe(5000);
    expect(body.gauges.map((gauge: { id: string }) => gauge.id)).toContain("battery_charge_percent");
    expect(body.threshold_problems).toEqual([]);
  });

  it("rejects write methods with 405", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`, { method });
      expect(status).toBe(405);
      expect(body.error.code).toBe("method_not_allowed");
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("only accepts writes (POST) on the battery test routes", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    // Writes outside the test routes remain blocked locally.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const { status, body } = await getJson(`${viewer.baseUrl}/api/tests`, { method });
      expect(status).toBe(405);
      expect(body.error.code).toBe("method_not_allowed");
    }
    const report = await getJson(`${viewer.baseUrl}/api/tests/abc`, { method: "POST" });
    expect(report.status).toBe(405);
    // No rejected method reaches the upstream API.
    expect(upstream.requests).toHaveLength(0);
  });

  it("responds 404 for a nonexistent resource in /api", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/inexistente`);
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("deduplicates queries within the cache TTL", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({
      upstreamBaseUrl: upstream.baseUrl,
      deviceId,
      cacheTtlMs: 30000,
      identityTtlMs: 30000,
    });

    await getJson(`${viewer.baseUrl}/api/dashboard`);
    const afterFirst = upstream.requests.length;
    await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(afterFirst).toBeGreaterThan(0);
    expect(upstream.requests.length).toBe(afterFirst);
  });
});
