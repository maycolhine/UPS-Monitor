/**
 * Cliente HTTP do frontend.
 *
 * O navegador conversa SOMENTE com o backend do próprio Web Viewer
 * (`/api/config` e `/api/dashboard`, na mesma origem). Quem fala com a API de
 * telemetria é o backend do container — isso elimina CORS e mantém o endereço
 * da API fora do navegador (escopo §7.1).
 *
 * A leitura é somente `GET`. A ÚNICA escrita admitida é o pedido de teste de
 * bateria do contrato 3.0 (`POST /api/tests...`), que o backend apenas repassa à
 * API de origem — o comando no nobreak continua sendo disparado por ela, nunca
 * pelo navegador nem de forma autônoma.
 */
import type {
  BatteryTestAbortPayload,
  BatteryTestAcceptPayload,
  BatteryTestReportPayload,
  DashboardPayload,
  ViewerConfigPayload,
  ViewerErrorPayload,
} from "../model/contract.js";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: { code: string; message: string } | null;
}

interface RequestOptions {
  method: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  /**
   * `GET /api/dashboard` responde 503 com payload de telemetria utilizável; nesse
   * caso o corpo ainda vale e `ok` permanece verdadeiro. As ações do teste não
   * têm esse tratamento: 403/409/422 são falhas que a interface precisa mostrar.
   */
  degradedOk?: boolean;
}

async function requestJson<T>(path: string, options: RequestOptions): Promise<ApiResult<T>> {
  const { method, body, signal, degradedOk = false } = options;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : { Accept: "application/json", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, status: 0, data: null, error: { code: "aborted", message: "Consulta cancelada." } };
    }
    return {
      ok: false,
      status: 0,
      data: null,
      error: {
        code: "network_error",
        message: "Não foi possível falar com o serviço do Web Viewer (mesma origem).",
      },
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: {
        code: "invalid_json",
        message: `O serviço respondeu HTTP ${response.status} sem JSON válido.`,
      },
    };
  }

  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: { code: "invalid_json", message: "Resposta em formato inesperado." },
    };
  }

  if (!response.ok) {
    const envelope = payload as Partial<ViewerErrorPayload>;
    const code = envelope.error?.code ?? `http_${response.status}`;
    const message =
      envelope.error?.message ?? `O serviço respondeu HTTP ${response.status}.`;
    return {
      ok: degradedOk && response.status === 503,
      status: response.status,
      data: payload as T,
      error: { code, message },
    };
  }

  return { ok: true, status: response.status, data: payload as T, error: null };
}

/** `GET /api/config` — definição dos gauges e parâmetros de atualização. */
export function fetchConfig(signal?: AbortSignal): Promise<ApiResult<ViewerConfigPayload>> {
  return requestJson<ViewerConfigPayload>("/api/config", { method: "GET", signal });
}

/**
 * `GET /api/dashboard` — instantâneo validado da API de telemetria.
 *
 * `deviceId` (opcional) escolhe qual nobreak exibir; sem ele o backend decide
 * (variável de ambiente, primeiro válido ou primeiro da lista). Em HTTP 503 o
 * corpo ainda é útil (payload com estado degradado), por isso `ok` continua
 * verdadeiro e o estado é derivado do próprio conteúdo.
 */
export function fetchDashboard(
  deviceId?: string | null,
  signal?: AbortSignal,
): Promise<ApiResult<DashboardPayload>> {
  return requestJson<DashboardPayload>(`/api/dashboard${deviceQuery(deviceId)}`, {
    method: "GET",
    signal,
    degradedOk: true,
  });
}

// ------------------------- ações do teste de bateria ------------------------

function deviceQuery(deviceId?: string | null): string {
  return deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
}

/**
 * `POST /api/tests` — pede o teste de bateria ao nobreak selecionado.
 *
 * `type` é o tipo declarado em `capabilities.battery_test.test_types`
 * (`duration_10s` ou `discharge_20pct`): quem decide o que oferecer é a API, não
 * o protocolo. O `POST` é ASSÍNCRONO: a resposta `202` traz o `test_id` e o
 * `report_url`, e não o resultado. Quem executa o comando é a API de origem, no
 * próximo ciclo do coletor — o Web Viewer nunca dispara teste por conta própria.
 */
export function startBatteryTest(
  deviceId?: string | null,
  type = "duration_10s",
  signal?: AbortSignal,
): Promise<ApiResult<BatteryTestAcceptPayload>> {
  return requestJson<BatteryTestAcceptPayload>(`/api/tests${deviceQuery(deviceId)}`, {
    method: "POST",
    body: { type },
    signal,
  });
}

/** `GET /api/tests/{id}` — acompanha o relatório (parcial enquanto `running`). */
export function fetchBatteryTestReport(
  testId: string,
  deviceId?: string | null,
  signal?: AbortSignal,
): Promise<ApiResult<BatteryTestReportPayload>> {
  return requestJson<BatteryTestReportPayload>(
    `/api/tests/${encodeURIComponent(testId)}${deviceQuery(deviceId)}`,
    { method: "GET", signal },
  );
}

/**
 * `POST /api/tests/{id}/abort` — cancela o teste em andamento.
 *
 * Só aparece na interface quando `capabilities.battery_test.abort_supported` é
 * verdadeiro; no `megatec-q1` o cancelamento apenas interrompe a amostragem.
 */
export function abortBatteryTest(
  testId: string,
  deviceId?: string | null,
  signal?: AbortSignal,
): Promise<ApiResult<BatteryTestAbortPayload>> {
  return requestJson<BatteryTestAbortPayload>(
    `/api/tests/${encodeURIComponent(testId)}/abort${deviceQuery(deviceId)}`,
    { method: "POST", body: {}, signal },
  );
}

/**
 * Distingue a falha do PRÓPRIO serviço do Web Viewer (transporte ou JSON
 * ilegível) de um envelope de erro que descreve a API de origem (`502`/`404`
 * com `error.code`). Só o primeiro caso deve ser tratado como "serviço
 * inacessível"; o segundo é apresentado a partir do próprio payload.
 */
export function isViewerLevelFailure(result: ApiResult<unknown>): boolean {
  if (result.error === null) return false;
  return result.status === 0 || result.error.code === "invalid_json";
}
