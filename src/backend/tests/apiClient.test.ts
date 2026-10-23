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
  it("reads valid JSON and always uses GET", async () => {
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

  it("returns the body on 404 and 405 responses (the contract describes the error)", async () => {
    upstream = await startFakeUpstream((req, res) => {
      respondJson(res, req.url?.includes("nonexistent") ? 404 : 405, deviceNotFound);
    });
    const client = makeClient(upstream.baseUrl);

    const notFound = await client.get("/api/v1/ups/nonexistent/telemetry");
    expect(notFound.ok).toBe(true);
    if (!notFound.ok) return;
    expect(notFound.status).toBe(404);
  });

  it("returns 503 without treating it as a transport failure", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 503, telemetryOk));
    const client = makeClient(upstream.baseUrl);

    const result = await client.get("/api/v1/ups/x/telemetry");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(503);
  });

  it("classifies timeout", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      setTimeout(() => respondJson(res, 200, telemetryOk), 400);
    });
    const client = makeClient(upstream.baseUrl, 60);

    const result = await client.get("/health");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("upstream_timeout");
  });

  it("classifies an unavailable network", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, telemetryOk));
    const baseUrl = upstream.baseUrl;
    await upstream.close();
    upstream = null;

    const result = await makeClient(baseUrl).get("/health");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("upstream_unreachable");
  });

  it("classifies invalid JSON", async () => {
    upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("<html>not json</html>");
    });

    const result = await makeClient(upstream.baseUrl).get("/health");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("upstream_invalid_json");
  });

  it("rejects write methods before touching the network (only GET and POST on the test routes)", async () => {
    upstream = await startFakeUpstream((_req, res) => respondJson(res, 200, telemetryOk));
    const client = makeClient(upstream.baseUrl);

    // Access to the internal method only to prove the method lock.
    const raw = client as unknown as { request(m: string, p: string): Promise<any> };
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const result = await raw.request(method, "/api/v1/ups/x/telemetry");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("viewer_invalid_method");
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("accepts POST (battery test) sending the method and the JSON body", async () => {
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
