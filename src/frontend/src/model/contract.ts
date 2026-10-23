/**
 * Types of the payload published by the Web Viewer backend (`GET /api/dashboard`,
 * `GET /api/config`, `GET /api/devices`).
 *
 * The `telemetry` block reproduces literally the telemetry API contract
 * (v1/3.0, multi-device and multiprotocol): the field names below are the API
 * ones, not aliases of the interface.
 *
 * Contract 3.0 adds the battery test: `capabilities.battery_test` in the
 * discovery (`GET /api/v1/ups`) and the predictability report
 * (`GET .../tests/{test_id}`). The read remains identical; the only write is the
 * test request, forwarded by the viewer backend.
 */

export interface ViewerSourceStatus {
  ok: boolean;
  http_status: number | null;
  duration_ms: number | null;
  url: string | null;
  error: { code: string; message: string } | null;
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
    error: { code: string; message: string } | null;
  };
  device_id: string | null;
  device_discovered: boolean;
  upstream_contract: { api_version: string; contract_version: string } | null;
  warnings: string[];
  sources: {
    health: ViewerSourceStatus;
    devices: ViewerSourceStatus;
    telemetry: ViewerSourceStatus;
    identity: ViewerSourceStatus;
    /** Battery test history (`GET .../tests?limit=N`, contract 3.0). */
    tests: ViewerSourceStatus;
  };
}

export interface CommunicationLastError {
  code?: string;
  message?: string;
  at_utc?: string | null;
}

export interface CommunicationState {
  state: string;
  telemetry_valid?: boolean;
  stale?: boolean;
  last_attempt_utc?: string | null;
  last_success_utc?: string | null;
  age_seconds?: number | null;
  consecutive_failures?: number;
  total_attempts?: number;
  total_successes?: number;
  last_error?: CommunicationLastError | null;
  serial_port?: string | null;
  poll_interval_s?: number;
  stale_after_s?: number;
}

/** Battery block of `megatec-q1` (percent ESTIMATED by interpolation). */
export interface BatteryCharge {
  percent: number | null;
  estimated?: boolean;
  method?: string;
  calibration?: { voltage_low_v?: number | null; voltage_high_v?: number | null };
}

/**
 * Battery block of `sms-1phase`: percent **reported by the device** and voltage
 * **derived** by the API (`voltage_derived`). It is not an estimate.
 */
export interface BatteryReported {
  charge_percent: number | null;
  charge_source?: string;
  voltage_v?: number | null;
  voltage_derived?: boolean;
  voltage_nominal_v?: number | null;
  packs?: number | null;
}

export interface StatusBlock {
  raw_bits?: string;
  /** `sms-1phase` also publishes the state byte in decimal. */
  raw_byte?: number;
  active?: string[];
  flags?: Record<string, boolean>;
}

export interface TelemetryData {
  captured_at_utc?: string | null;
  /** Protocol that produced the frame (`megatec-q1`, `sms-1phase`, ...). */
  source?: string;
  measurements: Record<string, number | null>;
  battery_charge?: BatteryCharge;
  battery?: BatteryReported;
  status?: StatusBlock;
  raw_frame?: string;
  age_seconds?: number | null;
}

export interface TelemetryPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  telemetry_valid: boolean;
  stale: boolean;
  data_available: boolean;
  data: TelemetryData | null;
  communication: CommunicationState;
}

export interface IdentityPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  identity_available: boolean;
  data: {
    captured_at_utc?: string | null;
    device?: {
      manufacturer?: string | null;
      model?: string | null;
      firmware?: string | null;
      raw_frame?: string | null;
    };
    nominal?: {
      voltage_label?: string | null;
      voltage_v?: number | null;
      input_current_a?: number | null;
      battery_voltage_v?: number | null;
      frequency_hz?: number | null;
      raw_frame?: string | null;
    };
  } | null;
  configured?: Record<string, unknown>;
  communication?: CommunicationState;
}

export interface DevicesPayload {
  api_version: string;
  contract_version: string;
  count?: number;
  devices: Array<{
    device_id: string;
    brand?: string | null;
    model?: string | null;
    transport?: string | null;
    protocol?: string | null;
    serial_port?: string | null;
    communication_state?: string | null;
    /** `sms-1phase` and `megatec-q1` publish whether there is a fresh reading now. */
    telemetry_valid?: boolean;
    telemetry_endpoint?: string | null;
    identity_endpoint?: string | null;
    /** Contract 3.0: describes the battery test available on this device. */
    capabilities?: DeviceCapabilities;
  }>;
}

/** Availability of ONE device inside `GET /health` (contract 2.0). */
export interface HealthDeviceStatus {
  telemetry_valid?: boolean;
  stale?: boolean;
  state?: string;
  serial_port?: string | null;
  collector_thread?: string | null;
  telemetry_freshness?: string | null;
  communication?: string | null;
  identity?: string | null;
  last_success_utc?: string | null;
  age_seconds?: number | null;
}

/**
 * `GET /health` of contract 2.0 is **aggregated** by `device_id` in `devices`
 * (the `device_id`, `checks` and `collector` fields of contract 1.0 no longer exist).
 */
export interface HealthPayload {
  api_version: string;
  contract_version: string;
  status: string;
  checked_at_utc?: string | null;
  uptime_seconds?: number | null;
  devices_total?: number | null;
  devices_ok?: number | null;
  devices?: Record<string, HealthDeviceStatus>;
}

export interface DashboardPayload {
  viewer: ViewerSection;
  /**
   * Present when the backend responded with an error envelope (e.g., 502/404).
   * Describes the condition of the origin API — it is not a failure of the Web
   * Viewer service.
   */
  error?: { code: string; message: string } | null;
  health: HealthPayload | null;
  devices: DevicesPayload | null;
  telemetry: TelemetryPayload | null;
  identity: IdentityPayload | null;
  /**
   * Recent battery test history (`GET .../tests?limit=N`, contract 3.0) —
   * without the samples series. It is an extra of the panel: it may come as
   * `null` when the API does not expose the history.
   */
  tests: TestsListPayload | null;
}

// ------------------------ battery test (contract 3.0) -------------------

/**
 * Parameters of ONE test type, published in
 * `capabilities.battery_test.types.<type>`: it is what distinguishes the window
 * test (`duration_s`) from the target test (`target_percent` + `timeout_s`).
 */
export interface BatteryTestTypeParams {
  duration_s?: number | null;
  target_percent?: number | null;
  timeout_s?: number | null;
  sample_interval_s?: number | null;
}

/**
 * Test discovery contract. `enabled` decides whether the button can be
 * triggered; `abort_supported` whether cancellation exists; the remaining fields
 * are the effective device parameters (window, sampling cadence, cooldown and
 * minimum charge).
 */
export interface BatteryTestCapabilities {
  supported?: boolean;
  enabled?: boolean;
  /** Types accepted by THIS device — no type outside this list is offered. */
  test_types?: string[];
  /** Detail per type (window × target). */
  types?: Record<string, BatteryTestTypeParams>;
  duration_s?: number | null;
  sample_interval_s?: number | null;
  cooldown_s?: number | null;
  min_battery_percent?: number | null;
  abort_supported?: boolean;
}

export interface DeviceCapabilities {
  battery_test?: BatteryTestCapabilities;
}

/** Acceptance of the test request (`POST .../tests` → 202; asynchronous execution). */
export interface BatteryTestAccept {
  accepted_at_utc?: string | null;
  poll_interval_s?: number | null;
  test_id: string;
  device_id: string;
  type?: string;
  status: string;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  requested_duration_s?: number | null;
  /** Charge target of the discharge test; `null` in the window test. */
  target_percent?: number | null;
  /** Safety ceiling of the test. */
  timeout_s?: number | null;
  sample_interval_s?: number | null;
  report_url?: string | null;
}

/** Cancellation response (`POST .../tests/{id}/abort` → 202). */
export interface BatteryTestAbort {
  test_id: string;
  device_id: string;
  status: string;
}

/** Aggregation per metric inside the report (`deltas.metrics`). */
export interface BatteryTestMetricDelta {
  start?: number | null;
  end?: number | null;
  min?: number | null;
  max?: number | null;
  delta?: number | null;
  ripple?: number | null;
  max_abs_deviation?: number | null;
  count?: number | null;
}

/**
 * Runtime estimate: first-order linear extrapolation, always
 * `confidence: "low"`. When `available` is `false`, the `reason` field explains —
 * the interface NEVER converts this into a number.
 */
export interface BatteryTestEstimate {
  available: boolean;
  method?: string;
  window_s?: number | null;
  start_charge_percent?: number | null;
  drop_percent_in_window?: number | null;
  discharge_rate_pp_per_min?: number | null;
  estimated_runtime_min?: number | null;
  capped_at_min?: number | null;
  confidence?: string;
  reason?: string;
}

/**
 * One sample of the timeline. `normalized` is the standardized mirror of the
 * metrics across protocols and is the basis of the charts; `measurements` keeps
 * the raw names of each model.
 */
export interface BatteryTestSample {
  offset_s?: number | null;
  normalized?: Record<string, number | null>;
  measurements?: Record<string, number | null>;
  status?: StatusBlock;
  battery?: { charge_percent?: number | null; voltage_v?: number | null };
}

/** Full report of a test (partial while `status = "running"`). */
export interface BatteryTestReport {
  test_id: string;
  device_id?: string;
  type?: string;
  status: string;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  ended_at_utc?: string | null;
  requested_duration_s?: number | null;
  duration_s?: number | null;
  sample_interval_s?: number | null;
  /** Charge target of the discharge test; `null` in the window test. */
  target_percent?: number | null;
  /** Safety ceiling of the test. */
  timeout_s?: number | null;
  finish_reason?: string | null;
  /** `true` if the UPS raised the `TEST` flag (confirms the test occurred). */
  test_flag_observed?: boolean;
  flags_seen?: string[];
  baseline?: Record<string, number | null>;
  final?: Record<string, number | null>;
  deltas?: {
    window_s?: number | null;
    sample_count?: number | null;
    metrics?: Record<string, BatteryTestMetricDelta>;
  };
  estimate?: BatteryTestEstimate | null;
  samples_count?: number | null;
  error?: { code: string; message: string } | null;
  samples?: BatteryTestSample[];
}

/** History item (`GET .../tests`): report without the samples series. */
export interface BatteryTestListItem {
  test_id: string;
  type?: string;
  status: string;
  started_at_utc?: string | null;
  expected_end_at_utc?: string | null;
  ended_at_utc?: string | null;
  duration_s?: number | null;
  finish_reason?: string | null;
  samples_count?: number | null;
  flags_seen?: string[];
  estimate?: BatteryTestEstimate | null;
  error?: { code: string; message: string } | null;
}

export interface TestsListPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  count?: number;
  tests: BatteryTestListItem[];
}

/** Responses of the test actions published by the viewer backend. */
export interface BatteryTestAcceptPayload {
  viewer: ViewerSection;
  accept: BatteryTestAccept;
}

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
  error: { code: string; message: string };
}

export interface GaugeBand {
  level: "critical" | "warning" | "good";
  from: number;
  to: number;
  label: string;
}

/** Complementary measurement displayed next to the gauge (e.g., battery voltage). */
export interface GaugeSecondarySource {
  label: string;
  path: string;
  unit: string;
  decimals: number;
}

/**
 * Source of a value in the telemetry payload — **one path per protocol**.
 * The `sources` list is the order of preference: the first path present wins.
 */
export interface GaugeSource {
  /** Exact path in the telemetry payload (contract names, without renaming). */
  path: string;
  /** Label displayed when this path is used (default: the gauge label). */
  label?: string;
  /** Origin badge ("estimate", "reported by the device", ...). */
  origin_note?: string;
  secondary?: GaugeSecondarySource;
}

export interface GaugeDefinition {
  id: string;
  label: string;
  unit: string;
  /** Paths in the telemetry payload, in order of preference. */
  sources: GaugeSource[];
  scale: { min: number; max: number; ticks: number[] };
  bands: GaugeBand[];
  decimals: number;
  order: number;
}

export interface ViewerConfigPayload {
  viewer: {
    name: string;
    version: string;
    read_only: true;
    refresh_interval_ms: number;
  };
  upstream: { base_url: string };
  device_id: string | null;
  gauges: GaugeDefinition[];
  threshold_problems: string[];
}
