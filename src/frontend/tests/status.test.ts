import { describe, expect, it } from "vitest";

import type { DashboardPayload, TelemetryPayload } from "../src/model/contract.js";
import {
  buildFlagViews,
  buildUnknownFlagViews,
  communicationLevel,
  describeCommunication,
  describeCommunicationState,
} from "../src/model/status.js";

function telemetry(overrides: Partial<TelemetryPayload> = {}): TelemetryPayload {
  return {
    api_version: "v1",
    contract_version: "2.0",
    device_id: "tsshara-3200va-01",
    telemetry_valid: true,
    stale: false,
    data_available: true,
    data: {
      captured_at_utc: "2026-10-21T12:00:00.000Z",
      measurements: { input_voltage_v: 219 },
      status: { raw_bits: "00001000", active: ["STANDBY", "BEEP"] },
    },
    communication: { state: "ok", telemetry_valid: true, stale: false, age_seconds: 3 },
    ...overrides,
  };
}

function dashboard(upstreamError: { code: string; message: string } | null): DashboardPayload {
  return {
    viewer: {
      name: "UPS Monitor — Web Viewer",
      version: "1.0.0",
      read_only: true,
      generated_at_utc: "2026-10-21T12:00:00.000Z",
      refresh_interval_ms: 5000,
      upstream: {
        base_url: "http://api:8080",
        reachable: upstreamError === null,
        http_status: upstreamError === null ? 200 : null,
        duration_ms: 10,
        error: upstreamError,
      },
      device_id: "tsshara-3200va-01",
      device_discovered: true,
      upstream_contract: { api_version: "v1", contract_version: "2.0" },
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
    telemetry: null,
    identity: null,
    tests: null,
  };
}

describe("Q1 flags", () => {
  it("marks only the reported flags as active", () => {
    const views = buildFlagViews(
      { OB: false, LB: false, STANDBY: true, BEEP: true },
      ["STANDBY", "BEEP"],
    );
    // The grid order is fixed (cold → hot), not the order of the active array:
    // the test checks which flags are active, not their position.
    expect(
      views
        .filter((view) => view.active)
        .map((view) => view.id)
        .sort(),
    ).toEqual(["BEEP", "STANDBY"]);
    expect(views.find((view) => view.id === "OB")?.active).toBe(false);
  });

  it("marks low battery and fault as critical", () => {
    const views = buildFlagViews(undefined, ["LB", "FAULT"]);
    expect(views.find((view) => view.id === "LB")?.severity).toBe("critical");
    expect(views.find((view) => view.id === "FAULT")?.severity).toBe("critical");
  });

  it("lists undocumented flags (other models) without inventing a label", () => {
    const unknown = buildUnknownFlagViews({ XYZ: true }, ["XYZ"]);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.id).toBe("XYZ");
    expect(unknown[0]?.description).toContain("not documented");
  });

  it("does not classify any flag as active when the status brings no flags", () => {
    expect(buildFlagViews(undefined, undefined).every((view) => !view.active)).toBe(true);
  });
});

describe("flags per protocol (contract 2.0)", () => {
  it("uses the sms-1phase table when data.source is sms-1phase", () => {
    const views = buildFlagViews(
      { BYPASS: true, UPSOK: true, BEEP: true },
      ["BYPASS", "UPSOK", "BEEP"],
      "sms-1phase",
    );
    const ids = views.map((view) => view.id);
    expect(ids).toContain("BYPASS");
    expect(ids).toContain("UPSOK");
    // The SMS does not publish FAULT/STANDBY (those bits have another meaning in it).
    expect(ids).not.toContain("FAULT");
    expect(views.find((view) => view.id === "BYPASS")?.active).toBe(true);
  });

  it("does not list BYPASS/UPSOK as 'undocumented' in the SMS", () => {
    const unknown = buildUnknownFlagViews(
      { BYPASS: true, UPSOK: true },
      ["BYPASS", "UPSOK"],
      "sms-1phase",
    );
    expect(unknown).toEqual([]);
  });

  it("keeps the Q1 table for a missing or unknown protocol", () => {
    expect(buildFlagViews(undefined, ["FAULT"]).map((view) => view.id)).toContain("FAULT");
    const unknown = buildUnknownFlagViews({ BYPASS: true }, ["BYPASS"]);
    expect(unknown.map((view) => view.id)).toContain("BYPASS");
  });
});

describe("communication state", () => {
  it("translates the documented states", () => {
    expect(describeCommunicationState("ok").label).toBe("Connected");
    expect(describeCommunicationState("stale").label).toBe("Stale");
    expect(describeCommunicationState("permission_denied").label).toBe("Permission denied");
  });

  it("translates the new checksum_error state (SMS protocol)", () => {
    expect(describeCommunicationState("checksum_error").label).toBe("Corrupted frame");
    expect(communicationLevel("checksum_error")).toBe("down");
  });

  it("does not invent a label for an unknown state", () => {
    expect(describeCommunicationState("estado_novo").label).toBe("estado_novo");
  });

  it("maps the severity of the state", () => {
    expect(communicationLevel("ok")).toBe("ok");
    expect(communicationLevel("stale")).toBe("stale");
    expect(communicationLevel("starting")).toBe("warning");
    expect(communicationLevel("timeout")).toBe("down");
  });

  it("distinguishes an unavailable API from stale telemetry", () => {
    const unreachable = describeCommunication(null, dashboard({ code: "upstream_unreachable", message: "no route" }));
    expect(unreachable.level).toBe("down");
    expect(unreachable.label).toContain("No communication");

    const stale = describeCommunication(telemetry({ stale: true }), dashboard(null));
    expect(stale.level).toBe("stale");
    expect(stale.label).toBe("Stale");
    expect(stale.description).toContain("stale");
  });

  it("indicates connected when the reading is valid and recent", () => {
    const view = describeCommunication(telemetry(), dashboard(null));
    expect(view.level).toBe("ok");
    expect(view.label).toBe("Connected");
  });

  it("handles the absence of telemetry without a transport error", () => {
    const view = describeCommunication(null, dashboard(null));
    expect(view.level).toBe("down");
    expect(view.label).toBe("No data from the device");
  });

  it("marks as warning when collection is active but there is no valid reading", () => {
    const view = describeCommunication(telemetry({ data_available: false }), dashboard(null));
    expect(view.level).toBe("warning");
  });

  it("propagates the collector failure state", () => {
    const view = describeCommunication(
      telemetry({ communication: { state: "permission_denied" } }),
      dashboard(null),
    );
    expect(view.level).toBe("down");
    expect(view.label).toBe("Permission denied");
  });
});
