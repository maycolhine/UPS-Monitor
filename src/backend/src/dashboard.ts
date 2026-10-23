/**
 * Serviço de consulta: transforma os endpoints GET da API de telemetria em um
 * payload único para a interface, preservando os nomes de campo do contrato.
 *
 * O que este módulo faz:
 *  - descobre o equipamento (configuração ou `GET /api/v1/ups`);
 *  - valida o contrato de cada resposta e separa disponibilidade, frescor e comunicação;
 *  - reporta falhas de transporte (timeout, rede, JSON inválido) sem inventar dados;
 *  - mantém um cache curto em memória (sem persistência) para não repetir consultas
 *    em cada ciclo de atualização da interface.
 *
 * Contrato 3.0 — teste de bateria: este módulo também **repassa** as três ações do
 * teste (`POST .../tests`, `GET .../tests/{id}`, `POST .../tests/{id}/abort`). A
 * escrita é exclusivamente o pedido de teste — `duration_10s` (janela fixa de ~10 s)
 * ou `discharge_20pct` (descarga até o alvo ou o teto de tempo), conforme o `type`
 * enviado pela interface e declarado em `capabilities.battery_test.test_types`; a
 * telemetria continua somente leitura. Quem executa o comando no nobreak é o
 * coletor da API de origem.
 *
 * O que este módulo NÃO faz: ler/abrir porta serial, enviar comandos ao nobreak,
 * gravar histórico ou alterar a API de origem.
 */
import { UpstreamApiClient, type UpstreamResult } from "./apiClient.js";
import {
  parseBatteryTestAbort,
  parseBatteryTestAccept,
  parseBatteryTestReport,
  parseDevices,
  parseErrorPayload,
  parseHealth,
  parseIdentity,
  parseTelemetry,
  parseTestsList,
  type BatteryTestAbort,
  type BatteryTestAccept,
  type BatteryTestReport,
  type DevicesPayload,
  type HealthPayload,
  type IdentityPayload,
  type TelemetryPayload,
  type TestsListPayload,
} from "./contract.js";

export const VIEWER_VERSION = "1.0.0";

export type ViewerErrorCode =
  | "upstream_unreachable"
  | "upstream_timeout"
  | "upstream_invalid_json"
  | "upstream_unexpected_status"
  | "upstream_method_not_allowed"
  | "upstream_contract_mismatch"
  | "device_not_found"
  | "no_devices_configured"
  | "viewer_internal_error";

export interface SourceStatus {
  ok: boolean;
  http_status: number | null;
  duration_ms: number | null;
  url: string | null;
  error: { code: ViewerErrorCode; message: string } | null;
  warnings: string[];
}

export interface ViewerSection {
  name: string;
  version: string;
  read_only: true;
  generated_at_utc: string;
  refresh_interval_ms: number;
  upstream: {
    base_url: string;
    reachable: boolean;
    http_status: number | null;
    duration_ms: number | null;
    error: { code: ViewerErrorCode; message: string } | null;
  };
  device_id: string | null;
  device_discovered: boolean;
  /** Versões declaradas pela API na resposta consumida (quando disponível). */
  upstream_contract: { api_version: string; contract_version: string } | null;
  warnings: string[];
  sources: {
    health: SourceStatus;
    devices: SourceStatus;
    telemetry: SourceStatus;
    identity: SourceStatus;
    tests: SourceStatus;
  };
}

export interface DashboardPayload {
  viewer: ViewerSection;
  health: HealthPayload | null;
  devices: DevicesPayload | null;
  telemetry: TelemetryPayload | null;
  identity: IdentityPayload | null;
  /** Histórico recente do teste de bateria (`GET .../tests?limit=N`). */
  tests: TestsListPayload | null;
}

export interface DevicesResponsePayload {
  viewer: ViewerSection;
  devices: DevicesPayload | null;
}

/** Aceite do pedido de teste (`POST .../tests` → 202). */
export interface BatteryTestAcceptPayload {
  viewer: ViewerSection;
  accept: BatteryTestAccept;
}

/** Relatório do teste (`GET .../tests/{test_id}` → 200, parcial enquanto `running`). */
export interface BatteryTestReportPayload {
  viewer: ViewerSection;
  report: BatteryTestReport;
}

export interface BatteryTestAbortPayload {
  viewer: ViewerSection;
  abort: BatteryTestAbort;
}

export interface ViewerErrorPayload {
  viewer: ViewerSection;
  /**
   * `code` preserva o código da API de origem quando o erro vem dela (ex.:
   * `test_cooldown`, `battery_too_low`), para a interface explicar o motivo real.
   */
  error: { code: string; message: string };
}

export type ViewerResponse<T> = { status: number; body: T };

interface CacheEntry {
  expiresAt: number;
  result: UpstreamResult;
}

interface ServiceOptions {
  client: UpstreamApiClient;
  cacheTtlMs: number;
  identityTtlMs: number;
  deviceId: string;
  refreshIntervalMs: number;
  now?: () => number;
}

const IDENTITY_PATH = (deviceId: string): string => `/api/v1/ups/${encodeURIComponent(deviceId)}/identity`;
const TELEMETRY_PATH = (deviceId: string): string => `/api/v1/ups/${encodeURIComponent(deviceId)}/telemetry`;
const TESTS_PATH = (deviceId: string): string => `/api/v1/ups/${encodeURIComponent(deviceId)}/tests`;
const TEST_PATH = (deviceId: string, testId: string): string =>
  `${TESTS_PATH(deviceId)}/${encodeURIComponent(testId)}`;
const TEST_ABORT_PATH = (deviceId: string, testId: string): string => `${TEST_PATH(deviceId, testId)}/abort`;
/** Histórico em memória da API: alguns itens bastam para a tendência. */
const TESTS_LIMIT = 10;
const DEFAULT_TEST_TYPE = "duration_10s";

const STATUS_FOR_CODE: Record<string, number> = {
  upstream_timeout: 502,
  upstream_unreachable: 502,
  upstream_invalid_json: 502,
  upstream_unexpected_status: 502,
  upstream_method_not_allowed: 502,
  upstream_contract_mismatch: 502,
  device_not_found: 404,
  no_devices_configured: 404,
  viewer_internal_error: 500,
};

export class ViewerService {
  private readonly client: UpstreamApiClient;
  private readonly cacheTtlMs: number;
  private readonly identityTtlMs: number;
  private readonly configuredDeviceId: string;
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<UpstreamResult>>();

  constructor(options: ServiceOptions) {
    this.client = options.client;
    this.cacheTtlMs = options.cacheTtlMs;
    this.identityTtlMs = options.identityTtlMs;
    this.configuredDeviceId = options.deviceId;
    this.refreshIntervalMs = options.refreshIntervalMs;
    this.now = options.now ?? (() => Date.now());
  }

  async getDashboard(
    requestedDeviceId?: string | null,
  ): Promise<ViewerResponse<DashboardPayload | ViewerErrorPayload>> {
    try {
      return await this.buildDashboard(requestedDeviceId ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        body: {
          viewer: this.viewerSection({ deviceId: null, discovered: false }),
          error: { code: "viewer_internal_error", message },
        },
      };
    }
  }

  async getDevices(): Promise<ViewerResponse<DevicesResponsePayload | ViewerErrorPayload>> {
    const result = await this.fetch("/api/v1/ups", this.identityTtlMs);
    const viewer = this.viewerSection({ deviceId: null, discovered: false });
    viewer.sources.devices = this.sourceStatus(result);
    viewer.upstream = this.upstreamStatus(result);

    if (!result.ok) {
      const code = result.code === "viewer_invalid_method" ? "viewer_internal_error" : result.code;
      return { status: STATUS_FOR_CODE[code] ?? 502, body: { viewer, error: { code, message: result.message } } };
    }
    const parsed = parseDevices(result.payload);
    viewer.warnings.push(...parsed.problems);
    viewer.sources.devices.warnings = parsed.problems;

    if (result.status === 503 && parsed.ok) {
      return { status: 200, body: { viewer, devices: parsed.value } };
    }
    if (!parsed.ok) {
      return {
        status: 502,
        body: {
          viewer,
          error: {
            code: "upstream_contract_mismatch",
            message: parsed.problems.join("; ") || "resposta de /api/v1/ups fora do contrato",
          },
        },
      };
    }
    return { status: 200, body: { viewer, devices: parsed.value } };
  }

  /**
   * Pede o teste de bateria (`POST .../tests` → 202), com o `type` escolhido pela
   * interface (padrão `duration_10s`). A API enfileira o
   * pedido e só o executa no próximo ciclo do coletor; o acompanhamento é feito
   * por `getBatteryTestReport`. Recusas da API (403/409/422/404/400) são
   * repassadas com o MESMO HTTP e `error.code`, para a interface explicar o
   * motivo real (ex.: `test_cooldown`, `unsupported_test_type`).
   */
  async startBatteryTest(
    requestedDeviceId?: string | null,
    type: string = DEFAULT_TEST_TYPE,
  ): Promise<ViewerResponse<BatteryTestAcceptPayload | ViewerErrorPayload>> {
    const viewer = this.viewerSection({ deviceId: null, discovered: false });
    const deviceId = await this.resolveActionDeviceId(requestedDeviceId ?? null);
    viewer.device_id = deviceId;
    if (!deviceId) {
      return {
        status: 404,
        body: {
          viewer,
          error: {
            code: "no_devices_configured",
            message: "nenhum equipamento disponível para o teste (configure UPS_DEVICE_ID)",
          },
        },
      };
    }

    const result = await this.client.post(TESTS_PATH(deviceId), { type });
    viewer.sources.tests = this.sourceStatus(result);
    const gate = this.actionFailure(result, viewer);
    if ("failure" in gate) return gate.failure;

    const parsed = parseBatteryTestAccept(gate.payload);
    viewer.sources.tests.warnings = parsed.problems;
    if (!parsed.ok) {
      return {
        status: 502,
        body: {
          viewer,
          error: {
            code: "upstream_contract_mismatch",
            message: parsed.problems.join("; ") || "aceite do teste fora do contrato",
          },
        },
      };
    }
    // 202 como a API: o pedido foi aceito, não concluído.
    return { status: 202, body: { viewer, accept: parsed.value } };
  }

  /** Acompanha o relatório (`GET .../tests/{test_id}`), parcial enquanto `running`. */
  async getBatteryTestReport(
    testId: string,
    requestedDeviceId?: string | null,
  ): Promise<ViewerResponse<BatteryTestReportPayload | ViewerErrorPayload>> {
    const viewer = this.viewerSection({ deviceId: null, discovered: false });
    const deviceId = await this.resolveActionDeviceId(requestedDeviceId ?? null);
    viewer.device_id = deviceId;
    if (!deviceId) {
      return {
        status: 404,
        body: {
          viewer,
          error: { code: "device_not_found", message: "equipamento não informado para consultar o teste" },
        },
      };
    }

    const result = await this.client.get(TEST_PATH(deviceId, testId));
    viewer.sources.tests = this.sourceStatus(result);
    const gate = this.actionFailure(result, viewer);
    if ("failure" in gate) return gate.failure;

    const parsed = parseBatteryTestReport(gate.payload);
    viewer.sources.tests.warnings = parsed.problems;
    if (!parsed.ok) {
      return {
        status: 502,
        body: {
          viewer,
          error: {
            code: "upstream_contract_mismatch",
            message: parsed.problems.join("; ") || "relatório do teste fora do contrato",
          },
        },
      };
    }
    return { status: 200, body: { viewer, report: parsed.value } };
  }

  /** Cancela um teste em andamento (`POST .../tests/{test_id}/abort` → 202). */
  async abortBatteryTest(
    testId: string,
    requestedDeviceId?: string | null,
  ): Promise<ViewerResponse<BatteryTestAbortPayload | ViewerErrorPayload>> {
    const viewer = this.viewerSection({ deviceId: null, discovered: false });
    const deviceId = await this.resolveActionDeviceId(requestedDeviceId ?? null);
    viewer.device_id = deviceId;
    if (!deviceId) {
      return {
        status: 404,
        body: {
          viewer,
          error: { code: "device_not_found", message: "equipamento não informado para cancelar o teste" },
        },
      };
    }

    const result = await this.client.post(TEST_ABORT_PATH(deviceId, testId), {});
    viewer.sources.tests = this.sourceStatus(result);
    const gate = this.actionFailure(result, viewer);
    if ("failure" in gate) return gate.failure;

    const parsed = parseBatteryTestAbort(gate.payload);
    viewer.sources.tests.warnings = parsed.problems;
    if (!parsed.ok) {
      return {
        status: 502,
        body: {
          viewer,
          error: {
            code: "upstream_contract_mismatch",
            message: parsed.problems.join("; ") || "resposta de cancelamento fora do contrato",
          },
        },
      };
    }
    return { status: 202, body: { viewer, abort: parsed.value } };
  }

  /**
   * Portão das ações de teste: devolve a resposta de falha (transporte ou
   * envelope `error` da própria API) ou o `payload` utilizável. O HTTP e o
   * `error.code` da API são preservados (ex.: 409 `test_cooldown`).
   */
  private actionFailure(
    result: UpstreamResult,
    viewer: ViewerSection,
  ): { failure: ViewerResponse<ViewerErrorPayload> } | { payload: unknown } {
    if (!result.ok) {
      const code: ViewerErrorCode =
        result.code === "viewer_invalid_method" ? "viewer_internal_error" : result.code;
      return {
        failure: {
          status: STATUS_FOR_CODE[code] ?? 502,
          body: { viewer, error: { code, message: result.message } },
        },
      };
    }
    const asError = parseErrorPayload(result.payload);
    if (asError.ok) {
      return {
        failure: {
          status: result.status,
          body: {
            viewer,
            error: { code: asError.value.error.code, message: asError.value.error.message },
          },
        },
      };
    }
    return { payload: result.payload };
  }

  /**
   * Resolve o equipamento para uma ação de teste: `?device_id=` → `UPS_DEVICE_ID`
   * → primeiro válido/primeiro de `GET /api/v1/ups`. Sem candidato, `null`.
   */
  private async resolveActionDeviceId(requestedDeviceId: string | null): Promise<string | null> {
    if (requestedDeviceId && requestedDeviceId !== "") return requestedDeviceId;
    if (this.configuredDeviceId !== "") return this.configuredDeviceId;

    const result = await this.fetch("/api/v1/ups", this.identityTtlMs);
    if (!result.ok) return null;
    const parsed = parseDevices(result.payload);
    if (!parsed.ok) return null;
    const entry = parsed.value.devices.find((item) => item.telemetry_valid === true) ?? parsed.value.devices[0];
    return entry?.device_id ?? null;
  }

  private async buildDashboard(
    requestedDeviceId: string | null,
  ): Promise<ViewerResponse<DashboardPayload | ViewerErrorPayload>> {
    const healthResult = await this.fetch("/health", this.cacheTtlMs);
    const healthParsed = healthResult.ok ? parseHealth(healthResult.payload) : null;

    const resolution = await this.resolveDeviceId(
      healthParsed?.ok ? healthParsed.value : null,
      requestedDeviceId,
    );
    const viewer = this.viewerSection({
      deviceId: resolution.deviceId,
      discovered: resolution.discovered,
    });
    viewer.sources.health = this.sourceStatus(healthResult);
    if (healthParsed) {
      viewer.sources.health.warnings = healthParsed.problems;
      viewer.warnings.push(...healthParsed.problems);
    }

    if (resolution.deviceStatus) {
      viewer.sources.devices = resolution.deviceStatus;
      viewer.warnings.push(...resolution.deviceStatus.warnings);
    }
    if (resolution.upstream) viewer.upstream = resolution.upstream;

    // Sem identificador não há como consultar telemetria: estado degradado explícito.
    if (!resolution.deviceId) {
      const failure = resolution.failure;
      const code: ViewerErrorCode =
        failure?.code === "upstream_unreachable"
          ? "upstream_unreachable"
          : failure?.code === "device_not_found"
            ? "device_not_found"
            : "no_devices_configured";
      return {
        status: STATUS_FOR_CODE[code] ?? 502,
        body: {
          viewer,
          error: {
            code,
            message:
              failure?.message ??
              "a API não informou nenhum equipamento em GET /api/v1/ups (configure UPS_DEVICE_ID para fixar o identificador)",
          },
        },
      };
    }

    const [telemetryResult, identityResult, testsResult] = await Promise.all([
      this.fetch(TELEMETRY_PATH(resolution.deviceId), this.cacheTtlMs),
      this.fetch(IDENTITY_PATH(resolution.deviceId), this.identityTtlMs),
      // Histórico do teste de bateria (contrato 3.0): alimenta a previsão de
      // esgotamento/duração exibida pelo painel. Falha aqui NÃO derruba o
      // dashboard — o status da consulta fica registrado em `viewer.sources.tests`.
      this.fetch(`${TESTS_PATH(resolution.deviceId)}?limit=${TESTS_LIMIT}`, this.cacheTtlMs),
    ]);

    viewer.sources.telemetry = this.sourceStatus(telemetryResult);
    viewer.sources.identity = this.sourceStatus(identityResult);
    viewer.sources.tests = this.sourceStatus(testsResult);
    viewer.upstream = this.upstreamStatus(telemetryResult);

    let telemetry: TelemetryPayload | null = null;
    let contractError: { code: string; message: string } | null = null;

    if (telemetryResult.ok) {
      // A API responde erros com o mesmo envelope (`error.code`), inclusive 404/405.
      const asError = parseErrorPayload(telemetryResult.payload);
      if (asError.ok) {
        contractError = asError.value.error;
        viewer.sources.telemetry.error = {
          code:
            asError.value.error.code === "device_not_found" ? "device_not_found" : "upstream_unexpected_status",
          message: asError.value.error.message,
        };
      } else {
        const parsed = parseTelemetry(telemetryResult.payload);
        viewer.sources.telemetry.warnings = parsed.problems;
        viewer.warnings.push(...parsed.problems);
        if (parsed.ok) {
          telemetry = parsed.value;
          viewer.upstream_contract = {
            api_version: parsed.value.api_version,
            contract_version: parsed.value.contract_version,
          };
        }
      }
    }

    let identity: IdentityPayload | null = null;
    if (identityResult.ok) {
      const asError = parseErrorPayload(identityResult.payload);
      if (asError.ok) {
        viewer.sources.identity.error = {
          code:
            asError.value.error.code === "device_not_found" ? "device_not_found" : "upstream_unexpected_status",
          message: asError.value.error.message,
        };
      } else {
        const parsed = parseIdentity(identityResult.payload);
        viewer.sources.identity.warnings = parsed.problems;
        viewer.warnings.push(...parsed.problems);
        if (parsed.ok) identity = parsed.value;
      }
    }

    // Histórico do teste de bateria (contrato 3.0). É um extra do painel: quando a
    // API não o expõe (404/erro), o status fica registrado em `viewer.sources.tests`
    // sem virar aviso global — o painel do teste informa a ausência por conta própria.
    let tests: TestsListPayload | null = null;
    if (testsResult.ok) {
      const asError = parseErrorPayload(testsResult.payload);
      if (asError.ok) {
        viewer.sources.tests.error = {
          code: "upstream_unexpected_status",
          message: asError.value.error.message,
        };
      } else {
        const parsed = parseTestsList(testsResult.payload);
        viewer.sources.tests.warnings = parsed.problems;
        if (parsed.ok) tests = parsed.value;
        else viewer.warnings.push(...parsed.problems);
      }
    }

    const health = healthParsed?.ok ? healthParsed.value : null;
    const devices = resolution.devices;

    viewer.warnings = [...new Set(viewer.warnings)];

    // Caso feliz (200) e caso degradado da API (503 com telemetria ausente/desatualizada):
    // ambos trazem informação válida para a interface, então respondemos 200 e deixamos
    // `telemetry_valid`, `stale` e `communication.state` explicarem o estado real.
    if (telemetry) {
      return { status: 200, body: { viewer, health, devices, telemetry, identity, tests } };
    }

    // Respostas de erro do próprio contrato da API (404/405 e afins).
    if (contractError) {
      const code: ViewerErrorCode =
        contractError.code === "device_not_found" ? "device_not_found" : "upstream_unexpected_status";
      return {
        status: code === "device_not_found" ? 404 : 502,
        body: { viewer, error: { code, message: contractError.message } },
      };
    }

    if (!telemetryResult.ok) {
      const code: ViewerErrorCode =
        telemetryResult.code === "viewer_invalid_method" ? "viewer_internal_error" : telemetryResult.code;
      return {
        status: STATUS_FOR_CODE[code] ?? 502,
        body: { viewer, error: { code, message: telemetryResult.message } },
      };
    }

    // Respondeu JSON, mas fora do contrato esperado.
    const problems = viewer.sources.telemetry.warnings;
    return {
      status: 502,
      body: {
        viewer,
        error: {
          code: "upstream_contract_mismatch",
          message: problems.join("; ") || `resposta de telemetria com HTTP ${telemetryResult.status} sem dados utilizáveis`,
        },
      },
    };
  }

  /**
   * Decide QUAL equipamento alimenta o painel. A API unificada publica N
   * equipamentos em `GET /api/v1/ups`; a escolha obedece, nesta ordem:
   *   1. `?device_id=` da consulta (seleção explícita da interface);
   *   2. `UPS_DEVICE_ID` fixado na configuração;
   *   3. o primeiro equipamento da lista com `telemetry_valid: true`;
   *   4. o primeiro item de `GET /api/v1/ups`;
   *   5. o primeiro `device_id` de `/health` (quando a lista está vazia).
   * Um `device_id` pedido que não consta da lista vira `device_not_found` —
   * nunca é consultado às cegas nem substituído silenciosamente por outro.
   */
  private async resolveDeviceId(
    health: HealthPayload | null,
    requestedDeviceId: string | null,
  ): Promise<{
    deviceId: string | null;
    discovered: boolean;
    devices: DevicesPayload | null;
    deviceStatus: SourceStatus | null;
    /** Estado do upstream quando a própria descoberta falhou (senão `null`). */
    upstream: ViewerSection["upstream"] | null;
    failure: { code: ViewerErrorCode; message: string } | null;
  }> {
    const requested = requestedDeviceId && requestedDeviceId !== "" ? requestedDeviceId : null;
    if (requested === null && this.configuredDeviceId !== "") {
      return {
        deviceId: this.configuredDeviceId,
        discovered: false,
        devices: null,
        deviceStatus: null,
        upstream: null,
        failure: null,
      };
    }

    const result = await this.fetch("/api/v1/ups", this.identityTtlMs);
    let devices: DevicesPayload | null = null;
    const deviceStatus = this.sourceStatus(result);
    // Sem equipamento descoberto não há consulta de telemetria; a falha de rede
    // da descoberta precisa ficar registrada para a interface distinguir
    // "API de telemetria indisponível" de "sem equipamento cadastrado".
    const upstream = result.ok ? null : this.upstreamStatus(result);

    if (result.ok) {
      const parsed = parseDevices(result.payload);
      deviceStatus.warnings = parsed.problems;
      if (parsed.ok) devices = parsed.value;
    }
    const list = devices?.devices ?? [];

    if (requested !== null) {
      const found = list.some((entry) => entry.device_id === requested);
      // Lista indisponível (API fora do ar) → confia no pedido e deixa a própria
      // consulta de telemetria revelar o erro real.
      if (found || list.length === 0) {
        return { deviceId: requested, discovered: found, devices, deviceStatus, upstream, failure: null };
      }
      const available = list.map((entry) => entry.device_id).join(", ");
      return {
        deviceId: null,
        discovered: false,
        devices,
        deviceStatus,
        upstream,
        failure: {
          code: "device_not_found",
          message: `equipamento '${requested}' não consta em GET /api/v1/ups (disponíveis: ${available})`,
        },
      };
    }

    // Prefere um equipamento com leitura válida agora (a interface pode ter
    // selecionado outro dispositivo que está sem cabo).
    const preferred = list.find((entry) => entry.telemetry_valid === true) ?? list[0];
    if (preferred) {
      return { deviceId: preferred.device_id, discovered: true, devices, deviceStatus, upstream, failure: null };
    }

    // Alternativa documentada: /health publica as chaves configuradas em `devices`.
    const healthIds = health?.devices ? Object.keys(health.devices) : [];
    const firstFromHealth = healthIds[0];
    if (firstFromHealth) {
      return { deviceId: firstFromHealth, discovered: true, devices, deviceStatus, upstream, failure: null };
    }

    return {
      deviceId: null,
      discovered: false,
      devices,
      deviceStatus,
      upstream,
      failure: result.ok
        ? null
        : {
            code: result.code === "viewer_invalid_method" ? "viewer_internal_error" : (result.code as ViewerErrorCode),
            message: result.message,
          },
    };
  }

  private viewerSection(input: { deviceId: string | null; discovered: boolean }): ViewerSection {
    return {
      name: "UPS Monitor — Web Viewer",
      version: VIEWER_VERSION,
      read_only: true,
      generated_at_utc: new Date(this.now()).toISOString(),
      refresh_interval_ms: this.refreshIntervalMs,
      upstream: {
        base_url: this.client.base,
        reachable: false,
        http_status: null,
        duration_ms: null,
        error: null,
      },
      device_id: input.deviceId,
      device_discovered: input.discovered,
      upstream_contract: null,
      warnings: [],
      sources: {
        health: emptySource(),
        devices: emptySource(),
        telemetry: emptySource(),
        identity: emptySource(),
        tests: emptySource(),
      },
    };
  }

  private upstreamStatus(result: UpstreamResult): ViewerSection["upstream"] {
    if (result.ok) {
      return {
        base_url: this.client.base,
        reachable: true,
        http_status: result.status,
        duration_ms: result.durationMs,
        error: null,
      };
    }
    const code = result.code === "viewer_invalid_method" ? "viewer_internal_error" : result.code;
    return {
      base_url: this.client.base,
      reachable: false,
      http_status: result.status,
      duration_ms: result.durationMs,
      error: { code: code as ViewerErrorCode, message: result.message },
    };
  }

  private sourceStatus(result: UpstreamResult): SourceStatus {
    if (result.ok) {
      return {
        ok: true,
        http_status: result.status,
        duration_ms: result.durationMs,
        url: result.url,
        error: null,
        warnings: [],
      };
    }
    const code = result.code === "viewer_invalid_method" ? "viewer_internal_error" : result.code;
    return {
      ok: false,
      http_status: result.status,
      duration_ms: result.durationMs,
      url: result.url,
      error: { code: code as ViewerErrorCode, message: result.message },
      warnings: [],
    };
  }

  /** GET com cache curto em memória + deduplicação de requisições simultâneas. */
  private fetch(path: string, ttlMs: number): Promise<UpstreamResult> {
    const now = this.now();
    const cached = this.cache.get(path);
    if (cached && cached.expiresAt > now) {
      return Promise.resolve(cached.result);
    }
    const pending = this.inFlight.get(path);
    if (pending) return pending;

    const request = this.client
      .get(path)
      .then((result) => {
        // Falhas não são cacheadas: a interface volta ao normal assim que a API responde.
        if (result.ok && ttlMs > 0) {
          this.cache.set(path, { expiresAt: this.now() + ttlMs, result });
        }
        return result;
      })
      .finally(() => {
        this.inFlight.delete(path);
      });

    this.inFlight.set(path, request);
    return request;
  }
}

function emptySource(): SourceStatus {
  return { ok: false, http_status: null, duration_ms: null, url: null, error: null, warnings: [] };
}
