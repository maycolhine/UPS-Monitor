/**
 * Query service: turns the telemetry API GET endpoints into a single
 * payload for the interface, preserving the contract field names.
 *
 * What this module does:
 *  - discovers the device (configuration or `GET /api/v1/ups`);
 *  - validates the contract of each response and separates availability, freshness and communication;
 *  - reports transport failures (timeout, network, invalid JSON) without inventing data;
 *  - keeps a short in-memory cache (no persistence) to avoid repeating queries
 *    on each interface refresh cycle.
 *
 * Contract 3.0 — battery test: this module also **relays** the three actions of the
 * test (`POST .../tests`, `GET .../tests/{id}`, `POST .../tests/{id}/abort`). The
 * write is exclusively the test request — `duration_10s` (fixed window of ~10 s)
 * or `discharge_20pct` (discharge down to the target or the time cap), according to the `type`
 * sent by the interface and declared in `capabilities.battery_test.test_types`; the
 * telemetry remains read-only. Who runs the command on the UPS is the
 * collector of the upstream API.
 *
 * What this module does NOT do: read/open the serial port, send commands to the UPS,
 * record history or change the upstream API.
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
  /** Versions declared by the API in the consumed response (when available). */
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
  /** Recent battery test history (`GET .../tests?limit=N`). */
  tests: TestsListPayload | null;
}

export interface DevicesResponsePayload {
  viewer: ViewerSection;
  devices: DevicesPayload | null;
}

/** Acceptance of the test request (`POST .../tests` → 202). */
export interface BatteryTestAcceptPayload {
  viewer: ViewerSection;
  accept: BatteryTestAccept;
}

/** Test report (`GET .../tests/{test_id}` → 200, partial while `running`). */
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
   * `code` preserves the upstream API code when the error comes from it (e.g.:
   * `test_cooldown`, `battery_too_low`), so the interface can explain the real reason.
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
/** In-memory history of the API: a few items are enough for the trend. */
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
            message: parsed.problems.join("; ") || "/api/v1/ups response outside the contract",
          },
        },
      };
    }
    return { status: 200, body: { viewer, devices: parsed.value } };
  }

  /**
   * Requests the battery test (`POST .../tests` → 202), with the `type` chosen by the
   * interface (default `duration_10s`). The API queues the
   * request and only runs it on the collector's next cycle; tracking is done
   * by `getBatteryTestReport`. API refusals (403/409/422/404/400) are
   * relayed with the SAME HTTP and `error.code`, so the interface can explain the
   * real reason (e.g.: `test_cooldown`, `unsupported_test_type`).
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
            message: "no device available for the test (configure UPS_DEVICE_ID)",
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
            message: parsed.problems.join("; ") || "test acceptance outside the contract",
          },
        },
      };
    }
    // 202 like the API: the request was accepted, not completed.
    return { status: 202, body: { viewer, accept: parsed.value } };
  }

  /** Tracks the report (`GET .../tests/{test_id}`), partial while `running`. */
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
          error: { code: "device_not_found", message: "device not provided to query the test" },
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
            message: parsed.problems.join("; ") || "test report outside the contract",
          },
        },
      };
    }
    return { status: 200, body: { viewer, report: parsed.value } };
  }

  /** Cancels a test in progress (`POST .../tests/{test_id}/abort` → 202). */
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
          error: { code: "device_not_found", message: "device not provided to cancel the test" },
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
            message: parsed.problems.join("; ") || "cancellation response outside the contract",
          },
        },
      };
    }
    return { status: 202, body: { viewer, abort: parsed.value } };
  }

  /**
   * Gate for the test actions: returns the failure response (transport or the API's
   * own `error` envelope) or the usable `payload`. The HTTP and the
   * API `error.code` are preserved (e.g.: 409 `test_cooldown`).
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
   * Resolves the device for a test action: `?device_id=` → `UPS_DEVICE_ID`
   * → first valid/first of `GET /api/v1/ups`. With no candidate, `null`.
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

    // Without an identifier there is no way to query telemetry: explicit degraded state.
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
              "the API reported no device in GET /api/v1/ups (configure UPS_DEVICE_ID to pin the identifier)",
          },
        },
      };
    }

    const [telemetryResult, identityResult, testsResult] = await Promise.all([
      this.fetch(TELEMETRY_PATH(resolution.deviceId), this.cacheTtlMs),
      this.fetch(IDENTITY_PATH(resolution.deviceId), this.identityTtlMs),
      // Battery test history (contract 3.0): feeds the runtime/depletion
      // forecast shown by the panel. A failure here does NOT bring down the
      // dashboard — the query status is recorded in `viewer.sources.tests`.
      this.fetch(`${TESTS_PATH(resolution.deviceId)}?limit=${TESTS_LIMIT}`, this.cacheTtlMs),
    ]);

    viewer.sources.telemetry = this.sourceStatus(telemetryResult);
    viewer.sources.identity = this.sourceStatus(identityResult);
    viewer.sources.tests = this.sourceStatus(testsResult);
    viewer.upstream = this.upstreamStatus(telemetryResult);

    let telemetry: TelemetryPayload | null = null;
    let contractError: { code: string; message: string } | null = null;

    if (telemetryResult.ok) {
      // The API answers errors with the same envelope (`error.code`), including 404/405.
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

    // Battery test history (contract 3.0). It is an extra of the panel: when the
    // API does not expose it (404/error), the status is recorded in `viewer.sources.tests`
    // without becoming a global warning — the test panel reports the absence on its own.
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

    // Happy path (200) and degraded case of the API (503 with missing/stale telemetry):
    // both carry valid information for the interface, so we answer 200 and let
    // `telemetry_valid`, `stale` and `communication.state` explain the real state.
    if (telemetry) {
      return { status: 200, body: { viewer, health, devices, telemetry, identity, tests } };
    }

    // Error responses from the API contract itself (404/405 and the like).
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

    // Answered JSON, but outside the expected contract.
    const problems = viewer.sources.telemetry.warnings;
    return {
      status: 502,
      body: {
        viewer,
        error: {
          code: "upstream_contract_mismatch",
          message: problems.join("; ") || `telemetry response with HTTP ${telemetryResult.status} without usable data`,
        },
      },
    };
  }

  /**
   * Decides WHICH device feeds the panel. The unified API publishes N
   * devices in `GET /api/v1/ups`; the choice obeys, in this order:
   *   1. `?device_id=` of the query (explicit selection of the interface);
   *   2. `UPS_DEVICE_ID` set in the configuration;
   *   3. the first device in the list with `telemetry_valid: true`;
   *   4. the first item of `GET /api/v1/ups`;
   *   5. the first `device_id` of `/health` (when the list is empty).
   * A requested `device_id` that is not in the list becomes `device_not_found` —
   * it is never queried blindly nor silently replaced by another.
   */
  private async resolveDeviceId(
    health: HealthPayload | null,
    requestedDeviceId: string | null,
  ): Promise<{
    deviceId: string | null;
    discovered: boolean;
    devices: DevicesPayload | null;
    deviceStatus: SourceStatus | null;
    /** Upstream state when the discovery itself failed (otherwise `null`). */
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
    // With no device discovered there is no telemetry query; the network failure
    // of the discovery must be recorded so the interface can distinguish
    // "telemetry API unavailable" from "no device registered".
    const upstream = result.ok ? null : this.upstreamStatus(result);

    if (result.ok) {
      const parsed = parseDevices(result.payload);
      deviceStatus.warnings = parsed.problems;
      if (parsed.ok) devices = parsed.value;
    }
    const list = devices?.devices ?? [];

    if (requested !== null) {
      const found = list.some((entry) => entry.device_id === requested);
      // List unavailable (API down) → trust the request and let the
      // telemetry query itself reveal the real error.
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
          message: `device '${requested}' is not present in GET /api/v1/ups (available: ${available})`,
        },
      };
    }

    // Prefers a device with a valid reading now (the interface may have
    // selected another device that is without a cable).
    const preferred = list.find((entry) => entry.telemetry_valid === true) ?? list[0];
    if (preferred) {
      return { deviceId: preferred.device_id, discovered: true, devices, deviceStatus, upstream, failure: null };
    }

    // Documented alternative: /health publishes the configured keys in `devices`.
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

  /** GET with short in-memory cache + deduplication of concurrent requests. */
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
        // Failures are not cached: the interface returns to normal as soon as the API responds.
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
