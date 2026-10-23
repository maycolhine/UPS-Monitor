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

describe("flags Q1", () => {
  it("marca como ativas apenas as flags informadas", () => {
    const views = buildFlagViews(
      { OB: false, LB: false, STANDBY: true, BEEP: true },
      ["STANDBY", "BEEP"],
    );
    // A ordem da grade é fixa (frias → quentes), não a ordem do array de ativas:
    // o teste verifica quais flags ficaram ativas, não a posição delas.
    expect(
      views
        .filter((view) => view.active)
        .map((view) => view.id)
        .sort(),
    ).toEqual(["BEEP", "STANDBY"]);
    expect(views.find((view) => view.id === "OB")?.active).toBe(false);
  });

  it("marca bateria baixa e falha como críticas", () => {
    const views = buildFlagViews(undefined, ["LB", "FAULT"]);
    expect(views.find((view) => view.id === "LB")?.severity).toBe("critical");
    expect(views.find((view) => view.id === "FAULT")?.severity).toBe("critical");
  });

  it("lista flags não documentadas (outros modelos) sem inventar rótulo", () => {
    const unknown = buildUnknownFlagViews({ XYZ: true }, ["XYZ"]);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.id).toBe("XYZ");
    expect(unknown[0]?.description).toContain("não documentado");
  });

  it("não classifica nenhuma flag como ativa quando o status não traz flags", () => {
    expect(buildFlagViews(undefined, undefined).every((view) => !view.active)).toBe(true);
  });
});

describe("flags por protocolo (contrato 2.0)", () => {
  it("usa a tabela do sms-1phase quando data.source é sms-1phase", () => {
    const views = buildFlagViews(
      { BYPASS: true, UPSOK: true, BEEP: true },
      ["BYPASS", "UPSOK", "BEEP"],
      "sms-1phase",
    );
    const ids = views.map((view) => view.id);
    expect(ids).toContain("BYPASS");
    expect(ids).toContain("UPSOK");
    // O SMS não publica FAULT/STANDBY (esses bits têm outro significado nele).
    expect(ids).not.toContain("FAULT");
    expect(views.find((view) => view.id === "BYPASS")?.active).toBe(true);
  });

  it("não lista BYPASS/UPSOK como 'não documentadas' no SMS", () => {
    const unknown = buildUnknownFlagViews(
      { BYPASS: true, UPSOK: true },
      ["BYPASS", "UPSOK"],
      "sms-1phase",
    );
    expect(unknown).toEqual([]);
  });

  it("mantém a tabela do Q1 para protocolo ausente ou desconhecido", () => {
    expect(buildFlagViews(undefined, ["FAULT"]).map((view) => view.id)).toContain("FAULT");
    const unknown = buildUnknownFlagViews({ BYPASS: true }, ["BYPASS"]);
    expect(unknown.map((view) => view.id)).toContain("BYPASS");
  });
});

describe("estado de comunicação", () => {
  it("traduz os estados documentados", () => {
    expect(describeCommunicationState("ok").label).toBe("Conectado");
    expect(describeCommunicationState("stale").label).toBe("Desatualizado");
    expect(describeCommunicationState("permission_denied").label).toBe("Sem permissão");
  });

  it("traduz o estado novo checksum_error (protocolo SMS)", () => {
    expect(describeCommunicationState("checksum_error").label).toBe("Quadro corrompido");
    expect(communicationLevel("checksum_error")).toBe("down");
  });

  it("não inventa rótulo para estado desconhecido", () => {
    expect(describeCommunicationState("estado_novo").label).toBe("estado_novo");
  });

  it("mapeia a severidade do estado", () => {
    expect(communicationLevel("ok")).toBe("ok");
    expect(communicationLevel("stale")).toBe("stale");
    expect(communicationLevel("starting")).toBe("warning");
    expect(communicationLevel("timeout")).toBe("down");
  });

  it("distingue API indisponível de telemetria desatualizada", () => {
    const unreachable = describeCommunication(null, dashboard({ code: "upstream_unreachable", message: "sem rota" }));
    expect(unreachable.level).toBe("down");
    expect(unreachable.label).toContain("Sem comunicação");

    const stale = describeCommunication(telemetry({ stale: true }), dashboard(null));
    expect(stale.level).toBe("stale");
    expect(stale.label).toBe("Desatualizado");
    expect(stale.description).toContain("desatualizada");
  });

  it("indica conectado quando a leitura é válida e recente", () => {
    const view = describeCommunication(telemetry(), dashboard(null));
    expect(view.level).toBe("ok");
    expect(view.label).toBe("Conectado");
  });

  it("trata ausência de telemetria sem erro de transporte", () => {
    const view = describeCommunication(null, dashboard(null));
    expect(view.level).toBe("down");
    expect(view.label).toBe("Sem dados do equipamento");
  });

  it("marca como atenção quando a coleta está ativa mas sem leitura válida", () => {
    const view = describeCommunication(telemetry({ data_available: false }), dashboard(null));
    expect(view.level).toBe("warning");
  });

  it("propaga o estado de falha do coletor", () => {
    const view = describeCommunication(
      telemetry({ communication: { state: "permission_denied" } }),
      dashboard(null),
    );
    expect(view.level).toBe("down");
    expect(view.label).toBe("Sem permissão");
  });
});
