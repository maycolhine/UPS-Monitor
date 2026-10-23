import { afterEach, describe, expect, it } from "vitest";

import { UpstreamApiClient } from "../src/apiClient.js";
import { respondJson, startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";
import { deviceNotFound, telemetryOk } from "./helpers/fixtures.js";

let upstream: FakeUpstream | null = null;

afterEach(async () => {
  if (upstream) {
    await upstream.close();
    upstream = null;
  }
});

function makeClient(baseUrl: string, timeoutMs = 500): UpstreamApiClient {
  return new UpstreamApiClient({ baseUrl, timeoutMs });
}

describe("UpstreamApiClient", () => {
  it("lê JSON válido e sempre usa GET", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, telemetryOk));
    const client = makeClient(upstream.baseUrl);

    const result = await client.get("/api/v1/ups/x/telemetry");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({ contract_version: "3.0" });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.method).toBe("GET");
  });

  it("devolve o corpo em respostas 404 e 405 (o contrato descreve o erro)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      respondJson(res, req.url?.includes("naoexiste") ? 404 : 405, deviceNotFound);
    });
    const client = makeClient(upstream.baseUrl);

    const notFound = await client.get("/api/v1/ups/naoexiste/telemetry");
    expect(notFound.ok).toBe(true);
    if (!notFound.ok) return;
    expect(notFound.status).toBe(404);
  });

  it("devolve 503 sem tratar como falha de transporte", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 503, telemetryOk));
    const client = makeClient(upstream.baseUrl);

    const result = await client.get("/api/v1/ups/x/telemetry");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(503);
  });

  it("classifica timeout", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      setTimeout(() => respondJson(res, 200, telemetryOk), 400);
    });
    const client = makeClient(upstream.baseUrl, 60);

    const result = await client.get("/health");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("upstream_timeout");
  });

  it("classifica rede indisponível", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, telemetryOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    const result = await makeClient(baseUrl).get("/health");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("upstream_unreachable");
  });

  it("classifica JSON inválido", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>nao e json</html>");
    });

    const result = await makeClient(upstream.baseUrl).get("/health");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("upstream_invalid_json");
  });

  it("recusa métodos de escrita antes de tocar a rede (só GET e POST nas rotas de teste)", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, telemetryOk));
    const client = makeClient(upstream.baseUrl);

    // Acesso ao método interno apenas para provar a trava de método.
    const raw = client as unknown as { request(m: string, p: string): Promise<any> };
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const result = await raw.request(method, "/api/v1/ups/x/telemetry");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("viewer_invalid_method");
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("aceita POST (teste de bateria) enviando o método e o corpo JSON", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 202, { test_id: "abc", status: "running" }));
    const client = makeClient(upstream.baseUrl);

    const result = await client.post("/api/v1/ups/x/tests", { type: "duration_10s" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(202);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.method).toBe("POST");
    expect(upstream.requests[0]?.body).toContain("duration_10s");
  });
});
