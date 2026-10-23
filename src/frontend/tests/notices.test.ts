import { describe, expect, it } from "vitest";

import { buildNotices } from "../src/components/Notices.js";
import { formatAge, formatNumber, formatPercent, formatText } from "../src/model/format.js";
import type { DashboardPayload } from "../src/model/contract.js";

describe("formatação pt-BR sem inventar valores", () => {
  it("usa vírgula como separador decimal", () => {
    expect(formatNumber(27.4, 1)).toBe("27,4");
    expect(formatNumber(1500, 0)).toBe("1.500");
  });

  it("mostra traço para ausente (nunca 0)", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(undefined)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
    expect(formatPercent(null)).toBe("—");
    expect(formatText("")).toBe("—");
    expect(formatText(null)).toBe("—");
  });

  it("formata idade em segundos, minutos e horas", () => {
    expect(formatAge(3.2)).toBe("3,2 s");
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
  it("avisa que os dados são simulados em modo demonstração", () => {
    const notices = buildNotices({ demo: true, fetchError: null, dashboard: null, thresholdProblems: [] });
    expect(notices.map((notice) => notice.id)).toContain("demo");
    expect(notices[0]?.title).toContain("DEMONSTRAÇÃO");
  });

  it("reporta a API de telemetria como indisponível com o código do erro", () => {
    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: dashboardWith(null, { code: "upstream_unreachable", message: "sem rota até o host" }),
      thresholdProblems: [],
    });
    const notice = notices.find((item) => item.id === "upstream_unreachable");
    expect(notice?.level).toBe("critical");
    expect(notice?.message).toContain("upstream_unreachable");
  });

  it("distingue 'sem telemetria' de 'telemetria desatualizada'", () => {
    const semTelemetria = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: dashboardWith(null, null),
      thresholdProblems: [],
    });
    expect(semTelemetria.map((notice) => notice.id)).toEqual(["no_telemetry"]);

    const desatualizada = buildNotices({
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
    expect(desatualizada.map((notice) => notice.id)).toEqual(["stale"]);
    expect(desatualizada[0]?.title).toBe("Leitura desatualizada");
  });

  it("trata erro da API de origem vindo no envelope, sem culpar o Web Viewer", () => {
    const deviceMissing = dashboardWith(null, null);
    deviceMissing.error = { code: "device_not_found", message: "equipamento 'x' nao esta configurado" };

    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: deviceMissing,
      thresholdProblems: [],
    });

    expect(notices.map((notice) => notice.id)).toEqual(["device_not_found"]);
    expect(notices[0]?.title).toBe("Equipamento não encontrado na API");
    expect(notices[0]?.message).toContain("device_not_found");
  });

  it("distingue falha do serviço do Web Viewer de indisponibilidade da API", () => {
    const viewerDown = buildNotices({
      demo: false,
      fetchError: {
        code: "network_error",
        message: "Não foi possível falar com o serviço do Web Viewer (mesma origem).",
      },
      dashboard: null,
      thresholdProblems: [],
    });

    expect(viewerDown.map((notice) => notice.id)).toEqual(["viewer_fetch"]);
    expect(viewerDown[0]?.title).toBe("Serviço do Web Viewer inacessível");
  });

  it("avisa sobre faixas provisórias não validadas", () => {
    const notices = buildNotices({
      demo: false,
      fetchError: null,
      dashboard: null,
      thresholdProblems: ["Faixas provisórias."],
    });
    const notice = notices.find((item) => item.id === "thresholds");
    expect(notice?.level).toBe("info");
  });

  it("não gera avisos quando está tudo normal", () => {
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
