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

describe("GET /api/dashboard — caminho feliz", () => {
  it("repassa a telemetria sem renomear nem reinterpretar campos", async () => {
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
    // O histórico do teste de bateria (contrato 3.0) acompanha o dashboard.
    expect(body.tests).toEqual(testsListOk);
    expect(body.viewer.sources.tests).toMatchObject({ ok: true, http_status: 200, error: null });
  });

  it("não derruba o dashboard quando o histórico do teste não existe (404 na API)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      if (req.url?.includes("/tests")) {
        respondJson(res, 404, { api_version: "v1", contract_version: "3.0", error: { code: "not_found", message: "sem histórico" } });
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
    // A ausência do histórico não contamina os avisos globais do painel.
    expect(body.viewer.warnings).toEqual([]);
  });

  it("descobre o equipamento por /api/v1/ups quando UPS_DEVICE_ID está vazio", async () => {
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

  it("usa o device_id de /health quando a lista de equipamentos vem vazia", async () => {
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

  it("respeita UPS_DEVICE_ID fixado e não consulta a lista de equipamentos", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(body.viewer.device_discovered).toBe(false);
    expect(upstream.requests.some((request) => request.url === "/api/v1/ups")).toBe(false);
  });

  it("?device_id= escolhe qual nobreak é exibido (SMS, outro protocolo)", async () => {
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

  it("?device_id= desconhecido → 404 device_not_found (sem consultar às cegas)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      const route = okRoutes()[req.url as keyof ReturnType<typeof okRoutes>];
      respondJson(res, route ? route.status : 404, route ? route.payload : deviceNotFound);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard?device_id=inexistente`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("device_not_found");
    expect(upstream.requests.some((request) => request.url.includes("/inexistente/"))).toBe(false);
  });

  it("usa exclusivamente GET na API de origem", async () => {
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

describe("GET /api/dashboard — estados degradados e falhas", () => {
  it("telemetria desatualizada (503 + stale) → 200 com aviso explícito e data preservado", async () => {
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

  it("coletor sem leitura (503 + data null) → 200 sem valores fictícios", async () => {
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

  it("API indisponível (rede recusada) → 502 upstream_unreachable", async () => {
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

  it("falha na descoberta registra o erro em viewer.upstream (não fica null)", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    // Sem UPS_DEVICE_ID: a descoberta por /api/v1/ups é o único caminho.
    viewer = await startViewer({ upstreamBaseUrl: baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_unreachable");
    expect(body.viewer.device_id).toBeNull();
    expect(body.viewer.upstream.reachable).toBe(false);
    expect(body.viewer.upstream.error.code).toBe("upstream_unreachable");
  });

  it("API lenta → 502 upstream_timeout", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      setTimeout(() => respondJson(res, 200, healthOk), 400);
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId, timeoutMs: 60 });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_timeout");
  });

  it("resposta que não é JSON → 502 upstream_invalid_json", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>portal</html>");
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_invalid_json");
  });

  it("JSON fora do contrato → 502 upstream_contract_mismatch", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, { status: "ok" }));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_contract_mismatch");
    expect(body.viewer.warnings.length).toBeGreaterThan(0);
  });

  it("equipamento inexistente na API → 404 device_not_found", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 404, deviceNotFound));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId: "inexistente" });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("device_not_found");
    expect(body.viewer.sources.telemetry.error.code).toBe("device_not_found");
  });

  it("sem nenhum equipamento disponível → 404 no_devices_configured", async () => {
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

describe("ações do teste de bateria (contrato 3.0)", () => {
  it("POST /api/tests repassa o pedido e devolve 202 com o aceite", async () => {
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
    // O POST é a ÚNICA escrita enviada à API de origem, e nada é disparado sem o pedido.
    const post = upstream.requests.find((request) => request.method === "POST");
    expect(post?.url).toBe(`/api/v1/ups/${deviceId}/tests`);
    expect(upstream.requests.every((request) => request.method === "POST" || request.method === "GET")).toBe(true);
  });

  it("preserva o 409 test_cooldown da API (a interface explica o motivo real)", async () => {
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

  it("GET /api/tests/{id} acompanha o relatório (parcial e completo)", async () => {
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

  it("POST /api/tests/{id}/abort devolve 202 com o cancelamento", async () => {
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

  it("teste inexistente → 404 test_not_found repassado da API", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      respondJson(res, 404, {
        api_version: "v1",
        contract_version: "3.0",
        error: { code: "test_not_found", message: "teste não encontrado" },
      });
    });
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests/inexistente`);

    expect(status).toBe(404);
    expect(body.error.code).toBe("test_not_found");
  });

  it("sem equipamento para resolver a ação → 404 no_devices_configured", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, devicesEmpty));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/tests`, { method: "POST" });

    expect(status).toBe(404);
    expect(body.error.code).toBe("no_devices_configured");
  });
});

describe("servidor do viewer", () => {
  it("GET /healthz responde 200 mesmo com a API indisponível", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    viewer = await startViewer({ upstreamBaseUrl: baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/healthz`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", read_only: true, service: "ups-web-viewer" });
  });

  it("GET /api/config publica métricas, faixas provisórias e intervalo de atualização", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, refreshIntervalMs: 5000 });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/config`);

    expect(status).toBe(200);
    expect(body.viewer.refresh_interval_ms).toBe(5000);
    expect(body.gauges.map((gauge: { id: string }) => gauge.id)).toContain("battery_charge_percent");
    expect(body.threshold_problems).toEqual([]);
  });

  it("recusa métodos de escrita com 405", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { status, body } = await getJson(`${viewer.baseUrl}/api/dashboard`, { method });
      expect(status).toBe(405);
      expect(body.error.code).toBe("method_not_allowed");
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("só admite escrita (POST) nas rotas do teste de bateria", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl, deviceId });

    // A escrita fora das rotas do teste continua bloqueada localmente.
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const { status, body } = await getJson(`${viewer.baseUrl}/api/tests`, { method });
      expect(status).toBe(405);
      expect(body.error.code).toBe("method_not_allowed");
    }
    const report = await getJson(`${viewer.baseUrl}/api/tests/abc`, { method: "POST" });
    expect(report.status).toBe(405);
    // Nenhum método recusado chega à API de origem.
    expect(upstream.requests).toHaveLength(0);
  });

  it("responde 404 para recurso inexistente em /api", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, healthOk));
    viewer = await startViewer({ upstreamBaseUrl: upstream.baseUrl });

    const { status, body } = await getJson(`${viewer.baseUrl}/api/inexistente`);
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("deduplica consultas dentro do TTL do cache", async () => {
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
