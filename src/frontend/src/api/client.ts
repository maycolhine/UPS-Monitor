/**
 * Frontend HTTP client.
 *
 * The browser talks ONLY to the Web Viewer backend itself (`/api/config` and
 * `/api/dashboard`, on the same origin). The one talking to the telemetry API is
 * the container backend — this eliminates CORS and keeps the API address out of
 * the browser (scope §7.1).
 *
 * Reading is `GET` only. The ONLY write allowed is the battery test request of
 * contract 3.0 (`POST /api/tests...`), which the backend merely forwards to the
 * origin API — the command on the UPS is still triggered by it, never by the
 * browser nor autonomously.
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
   * `GET /api/dashboard` responds 503 with a usable telemetry payload; in that
   * case the body is still valid and `ok` remains true. The test actions do not
   * get this treatment: 403/409/422 are failures the interface must show.
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
      return { ok: false, status: 0, data: null, error: { code: "aborted", message: "Request cancelled." } };
    }
    return {
      ok: false,
      status: 0,
      data: null,
      error: {
        code: "network_error",
        message: "Could not reach the Web Viewer service (same origin).",
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
        message: `The service responded HTTP ${response.status} without valid JSON.`,
      },
    };
  }

  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: { code: "invalid_json", message: "Unexpected response format." },
    };
  }

  if (!response.ok) {
    const envelope = payload as Partial<ViewerErrorPayload>;
    const code = envelope.error?.code ?? `http_${response.status}`;
    const message =
      envelope.error?.message ?? `The service responded HTTP ${response.status}.`;
    return {
      ok: degradedOk && response.status === 503,
      status: response.status,
      data: payload as T,
      error: { code, message },
    };
  }

  return { ok: true, status: response.status, data: payload as T, error: null };
}

/** `GET /api/config` — gauge definitions and refresh parameters. */
export function fetchConfig(signal?: AbortSignal): Promise<ApiResult<ViewerConfigPayload>> {
  return requestJson<ViewerConfigPayload>("/api/config", { method: "GET", signal });
}

/**
 * `GET /api/dashboard` — validated snapshot of the telemetry API.
 *
 * `deviceId` (optional) selects which UPS to display; without it the backend
 * decides (environment variable, first valid or first in the list). On HTTP 503
 * the body is still useful (payload with degraded state), so `ok` remains true
 * and the state is derived from the content itself.
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

// ------------------------- battery test actions ------------------------

function deviceQuery(deviceId?: string | null): string {
  return deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
}

/**
 * `POST /api/tests` — requests the battery test from the selected UPS.
 *
 * `type` is the type declared in `capabilities.battery_test.test_types`
 * (`duration_10s` or `discharge_20pct`): the one deciding what to offer is the
 * API, not the protocol. The `POST` is ASYNCHRONOUS: the `202` response carries
 * the `test_id` and the `report_url`, not the result. The one executing the
 * command is the origin API, on the next cycle of the collector — the Web Viewer
 * never triggers a test on its own.
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

/** `GET /api/tests/{id}` — follows the report (partial while `running`). */
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
 * `POST /api/tests/{id}/abort` — cancels the test in progress.
 *
 * It only appears in the interface when `capabilities.battery_test.abort_supported`
 * is true; on `megatec-q1` the cancellation merely stops the sampling.
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
 * Distinguishes a failure of the Web Viewer service ITSELF (transport or
 * unreadable JSON) from an error envelope describing the origin API (`502`/`404`
 * with `error.code`). Only the first case should be treated as "service
 * unreachable"; the second is presented from the payload itself.
 */
export function isViewerLevelFailure(result: ApiResult<unknown>): boolean {
  if (result.error === null) return false;
  return result.status === 0 || result.error.code === "invalid_json";
}
