import { describe, expect, it } from "vitest";

import { buildNotices } from "../src/components/Notices.js";
import { formatAge, formatNumber, formatPercent, formatText } from "../src/model/format.js";
import type { DashboardPayload } from "../src/model/contract.js";

describe("en-US formatting without inventing values", () => {
  it("uses a period as the decimal separator", () => {
    expect(formatNumber(27.4, 1)).toBe("27.4");
    expect(formatNumber(1500, 0)).toBe("1,500");
  });

  it("shows a dash for a missing value (never 0)", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatPercent(null)).toBe("—");
    expect(formatText("")).toBe("—");
    expect(formatText(null)).toBe("—");
  });

  it("formats age in seconds, minutes, and hours", () => {
    expect(formatAge(3.2)).toBe("3.2 s");
    expect(formatAge(64)).toBe("1 min 4 s");
    expect(formatAge(120)).toBe("2 min");
    expect(formatAge(7500)).toBe("2 h 5 min");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(-1)).toBe("—");
  });
});

function dashboardWith(telemetry: DashboardPayload["telemetry"], error: { code: string; message: string } | null): DashboardPayload {
  return {
    viewer: {
      name: "UPS Monitor — Web Viewer",
      version: "1.0.0",
      read_only: true,
      generated_at_utc: "2026-10-21T12:00:00.000Z",
      refresh_interval_ms: 5000,
      upstream: { base_url: "http://api:8080", reachable: error === null, http_status: 200, duration_ms: 10, error },
      device_id: "tsshara-3200va-01",
      device_discovered: true,
      upstream_contract: null,
      warnings: [],
      sources: {
        health: { ok: true, http_status: 200, duration_ms: 5, url: "/health", error: null, warnings: [] },
        devices: { ok: true, http_status: 200, duration_ms: 5, url: "/api/v1/ups", error: null, warnings: [] },
        telemetry: { ok: true, http_status: 200, duration_ms: 5, url: "/telemetry", error: null, warnings: [] },
        identity: { ok: true, http_status: 200, duration_ms: 5, url: "/identity", error: null, warnings: [] },
        tests: { ok: true, http_status: 200, duration_ms: 5, url: "/tests?limit=10", error: null, warnings: [] },
      },
    },
    health: null,
    devices: null,
    telemetry,
    identity: null,
    tests: null,
  };
}

describe("buildNotices", () => {
  it("warns that the data is simulated in demo mode", () => {
    const notices = buildNotices({ demo: true, fetchError: null, dashboard: null, thresholdProblems: [] });
    expect(notices.map((notice) => notice.id)).toContain("demo");
    expect(notices[0]?.title).toContain("DEMO");
  });

  it("reports the telemetry API as unavailable with the error code", () => {
    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: dashboardWith(null, { code: "upstream_unreachable", message: "no route to the host" }),
      thresholdProblems: [],
    });
    const notice = notices.find((item) => item.id === "upstream_unreachable");
    expect(notice?.level).toBe("critical");
    expect(notice?.message).toContain("upstream_unreachable");
  });

  it("distinguishes 'no telemetry' from 'stale telemetry'", () => {
    const noTelemetry = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: dashboardWith(null, null),
      thresholdProblems: [],
    });
    expect(noTelemetry.map((notice) => notice.id)).toEqual(["no_telemetry"]);

    const stale = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: dashboardWith(
        {
          api_version: "v1",
          contract_version: "2.0",
          device_id: "d1",
          telemetry_valid: true,
          stale: true,
          data_available: true,
          data: { captured_at_utc: "2026-10-21T11:59:00.000Z", measurements: {}, age_seconds: 120 },
          communication: { state: "stale", stale: true, age_seconds: 120 },
        },
        null,
      ),
      thresholdProblems: [],
    });
    expect(stale.map((notice) => notice.id)).toEqual(["stale"]);
    expect(stale[0]?.title).toBe("Stale reading");
  });

  it("handles an origin API error coming in the envelope, without blaming the Web Viewer", () => {
    const deviceMissing = dashboardWith(null, null);
    deviceMissing.error = { code: "device_not_found", message: "device 'x' is not configured" };

    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: deviceMissing,
      thresholdProblems: [],
    });

    expect(notices.map((notice) => notice.id)).toEqual(["device_not_found"]);
    expect(notices[0]?.title).toBe("Device not found in the API");
    expect(notices[0]?.message).toContain("device_not_found");
  });

  it("distinguishes a Web Viewer service failure from API unavailability", () => {
    const viewerDown = buildNotices({
      demo: false,
      fetchError: {
        code: "network_error",
        message: "Could not reach the Web Viewer service (same origin).",
      },
      dashboard: null,
      thresholdProblems: [],
    });

    expect(viewerDown.map((notice) => notice.id)).toEqual(["viewer_fetch"]);
    expect(viewerDown[0]?.title).toBe("Web Viewer service unreachable");
  });

  it("warns about provisional bands that have not been validated", () => {
    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: null,
      thresholdProblems: ["Provisional bands."],
    });
    const notice = notices.find((item) => item.id === "thresholds");
    expect(notice?.level).toBe("info");
  });

  it("does not generate notices when everything is normal", () => {
    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: dashboardWith(
        {
          api_version: "v1",
          contract_version: "2.0",
          device_id: "d1",
          telemetry_valid: true,
          stale: false,
          data_available: true,
          data: { captured_at_utc: "2026-10-21T12:00:00.000Z", measurements: {} },
          communication: { state: "ok", age_seconds: 2 },
        },
        null,
      ),
      thresholdProblems: [],
    });
    expect(notices).toEqual([]);
  });
});
