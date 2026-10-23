/**
 * Telemetry API contract (v1 / contract_version 3.0) — reading, validation and
 * normalization.
 *
 * Rules applied here (see docs/api-contract.md and docs/technical-decisions.md):
 *  1. No field is renamed: the API names are preserved literally.
 *  2. `null` is preserved as `null`; it is never converted to 0 nor to a fictitious value.
 *  3. A missing field stays missing (it is not created with a default value).
 *  4. Divergences from what is documented become `problems` and are reported
 *     in the Web Viewer response (`viewer.warnings`), without silent adaptation.
 *  5. Extra fields (from other brands/models) are preserved in the original payload.
 *  6. Contract 3.0 adds the battery test: `capabilities.battery_test` in the
 *     equipment list and the predictability report. Reading remains
 *     identical; the only write is `POST .../tests` (see `apiClient`/`dashboard`).
 */

export const EXPECTED_API_VERSION = "v1";
/** Contract revision published by the unified multi-device API. */
export const EXPECTED_CONTRACT_VERSION = "3.0";

export type UnknownRecord = Record<string, unknown>;

export type Parsed<T> =
  | { ok: true; value: T; problems: string[]; raw: UnknownRecord }
  | { ok: false; problems: string[]; raw: UnknownRecord };

export interface ContractError {
  code: string;
  message: string;
}

export interface ErrorPayload {
  api_version: string;
  contract_version: string;
  error: ContractError;
}

export interface CommunicationLastError {
  code?: string;
  message?: string;
  at_utc?: string | null;
}

/** Collection metadata: `communication` in the contract. */
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

export interface BatteryCharge {
  percent: number | null;
  estimated?: boolean;
  method?: string;
  calibration?: { voltage_low_v?: number | null; voltage_high_v?: number | null };
}

/**
 * Battery block of the `sms-1phase` protocol: the percentage is **reported by the
 * device** (`charge_source: reported_by_device`) and the voltage is **derived**
 * (`nominal × percentage / 100`). It is not an estimate by interpolation — that is why
 * it does not carry the "estimate" mark in the interface.
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
  /** SMS also publishes the state byte in decimal. */
  raw_byte?: number;
  active?: string[];
  flags?: Record<string, boolean>;
}

export interface TelemetryData {
  captured_at_utc?: string | null;
  source?: string;
  /** Measurements with the API names and units (`input_voltage_v`, `load_percent`, ...). */
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

export interface IdentityData {
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
}

export interface IdentityPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  identity_available: boolean;
  data: IdentityData | null;
  configured?: UnknownRecord;
  communication?: CommunicationState;
}

/**
 * Parameters of ONE test type, published at
 * `capabilities.battery_test.types.<type>`. It is what distinguishes the window test
 * (`duration_s`) from the target test (`target_percent` + `timeout_s`).
 */
export interface BatteryTestTypeParams {
  /** Test window; `null` in the target test (no window). */
  duration_s?: number | null;
  /** Charge target of the discharge test (e.g.: 20 %); `null` in the window test. */
  target_percent?: number | null;
  /** Safety cap: when the test stops regardless. */
  timeout_s?: number | null;
  sample_interval_s?: number | null;
}

/**
 * Battery test discovery contract (contract 3.0). `enabled` decides whether
 * the button may be shown; `abort_supported` whether cancellation exists; the
 * remaining fields are the device's effective parameters.
 */
export interface BatteryTestCapabilities {
  supported?: boolean;
  enabled?: boolean;
  /** Types accepted by THIS device (`duration_10s`, `discharge_20pct`, ...). */
  test_types?: string[];
  /** Detail per type — the interface does not invent missing parameters. */
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

export interface DeviceEntry {
  device_id: string;
  brand?: string | null;
  model?: string | null;
  transport?: string | null;
  protocol?: string | null;
  serial_port?: string | null;
  communication_state?: string | null;
  telemetry_valid?: boolean;
  telemetry_endpoint?: string | null;
  identity_endpoint?: string | null;
  capabilities?: DeviceCapabilities;
}

export interface DevicesPayload {
  api_version: string;
  contract_version: string;
  count?: number;
  devices: DeviceEntry[];
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
 * `GET /health` of contract 2.0 is **aggregated**: it publishes a summary per
 * `device_id` in `devices` (the fields `device_id`, `checks` and `collector` of
 * contract 1.0 have disappeared).
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

// ------------------------ battery test (contract 3.0) ------------------------

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
  /** Safety cap of the test (`timeout_s`). */
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
 * Runtime estimate: linear first-order extrapolation, always
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
 * One sample of the timeline (`test.samples[]`).
 *
 * `normalized` is the standardized mirror of the metrics (same names in both
 * protocols) and is the ONLY basis for the charts: `measurements` keeps the raw
 * names of each protocol. A missing key in `normalized` means "series
 * unavailable on this device" — never zero.
 */
export interface BatteryTestSample {
  offset_s?: number | null;
  normalized?: Record<string, number | null>;
  measurements?: Record<string, number | null>;
  status?: StatusBlock;
  battery?: { charge_percent?: number | null; voltage_v?: number | null };
}

/** Complete report of a test (partial while `status = "running"`). */
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
  /** Safety cap of the test; `null` when the API does not publish it. */
  timeout_s?: number | null;
  finish_reason?: string | null;
  /** `true` if the UPS set the `TEST` flag (confirms that the test occurred). */
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
  error?: ContractError | null;
  samples?: BatteryTestSample[];
}

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
  error?: ContractError | null;
}

/** History (`GET .../tests?limit=N`): without the sample series. */
export interface TestsListPayload {
  api_version: string;
  contract_version: string;
  device_id: string;
  count?: number;
  tests: BatteryTestListItem[];
}

// ------------------------------- utilities ----------------------------------
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(source: UnknownRecord, key: string): boolean {
  return typeof source[key] === "string";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return asNumber(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Validates the common envelope (`api_version`, `contract_version`). */
function envelope(source: UnknownRecord, problems: string[]): boolean {
  let ok = true;
  if (!hasString(source, "api_version")) {
    problems.push("contract mismatch: 'api_version' missing or not textual");
    ok = false;
  } else if (source["api_version"] !== EXPECTED_API_VERSION) {
    problems.push(
      `contract mismatch: api_version received '${String(source["api_version"])}' (expected '${EXPECTED_API_VERSION}')`,
    );
  }
  if (!hasString(source, "contract_version")) {
    problems.push("contract mismatch: 'contract_version' missing or not textual");
    ok = false;
  } else if (source["contract_version"] !== EXPECTED_CONTRACT_VERSION) {
    problems.push(
      `contract mismatch: contract_version received '${String(source["contract_version"])}' (expected '${EXPECTED_CONTRACT_VERSION}')`,
    );
  }
  return ok;
}

function parseCommunication(value: unknown, problems: string[]): CommunicationState | null {
  if (!isRecord(value)) {
    problems.push("contract mismatch: 'communication' missing or not an object");
    return null;
  }
  const state = value["state"];
  if (typeof state !== "string") {
    problems.push("contract mismatch: 'communication.state' missing");
    return null;
  }
  const lastErrorRaw = value["last_error"];
  let lastError: CommunicationLastError | null = null;
  if (isRecord(lastErrorRaw)) {
    lastError = {
      ...(typeof lastErrorRaw["code"] === "string" ? { code: lastErrorRaw["code"] } : {}),
      ...(typeof lastErrorRaw["message"] === "string" ? { message: lastErrorRaw["message"] } : {}),
      ...(typeof lastErrorRaw["at_utc"] === "string" ? { at_utc: lastErrorRaw["at_utc"] } : {}),
    };
  } else if (lastErrorRaw !== null && lastErrorRaw !== undefined) {
    problems.push("contract mismatch: 'communication.last_error' is neither an object nor null");
  }

  const result: CommunicationState = { state };
  const telemetryValid = value["telemetry_valid"];
  if (typeof telemetryValid === "boolean") result.telemetry_valid = telemetryValid;
  const stale = value["stale"];
  if (typeof stale === "boolean") result.stale = stale;
  const lastAttempt = optionalString(value["last_attempt_utc"]);
  if (lastAttempt !== undefined) result.last_attempt_utc = lastAttempt;
  const lastSuccess = optionalString(value["last_success_utc"]);
  if (lastSuccess !== undefined) result.last_success_utc = lastSuccess;
  const age = optionalNumber(value["age_seconds"]);
  if (age !== undefined) result.age_seconds = age;
  const failures = optionalNumber(value["consecutive_failures"]);
  if (failures !== undefined && failures !== null) result.consecutive_failures = failures;
  const attempts = optionalNumber(value["total_attempts"]);
  if (attempts !== undefined && attempts !== null) result.total_attempts = attempts;
  const successes = optionalNumber(value["total_successes"]);
  if (successes !== undefined && successes !== null) result.total_successes = successes;
  const port = optionalString(value["serial_port"]);
  if (port !== undefined) result.serial_port = port;
  const pollInterval = optionalNumber(value["poll_interval_s"]);
  if (pollInterval !== undefined && pollInterval !== null) result.poll_interval_s = pollInterval;
  const staleAfter = optionalNumber(value["stale_after_s"]);
  if (staleAfter !== undefined && staleAfter !== null) result.stale_after_s = staleAfter;
  if (lastError !== null || lastErrorRaw === null) result.last_error = lastError;

  return result;
}

function parseMeasurements(value: unknown, problems: string[]): Record<string, number | null> {
  const measurements: Record<string, number | null> = {};
  if (!isRecord(value)) {
    problems.push("contract mismatch: 'data.measurements' missing or not an object");
    return measurements;
  }
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || typeof raw === "number") {
      measurements[key] = asNumber(raw);
    } else {
      problems.push(`measurement '${key}' with unexpected type (${typeof raw}); ignored`);
    }
  }
  return measurements;
}

// -------------------------------- parsers -----------------------------------
export function parseErrorPayload(payload: unknown): Parsed<ErrorPayload> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["error response is not a JSON object"], raw: {} };
  }
  envelope(payload, problems);
  const error = payload["error"];
  if (!isRecord(error) || typeof error["code"] !== "string") {
    return {
      ok: false,
      problems: [...problems, "error response without 'error.code'"],
      raw: payload,
    };
  }
  return {
    ok: true,
    value: {
      api_version: String(payload["api_version"] ?? ""),
      contract_version: String(payload["contract_version"] ?? ""),
      error: {
        code: error["code"],
        message: typeof error["message"] === "string" ? error["message"] : "",
      },
    },
    problems,
    raw: payload,
  };
}

export function parseTelemetry(payload: unknown): Parsed<TelemetryPayload> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["telemetry: response is not a JSON object"], raw: {} };
  }
  if (!envelope(payload, problems)) {
    return { ok: false, problems, raw: payload };
  }
  if (typeof payload["device_id"] !== "string") {
    return { ok: false, problems: [...problems, "telemetry without 'device_id'"], raw: payload };
  }
  const communication = parseCommunication(payload["communication"], problems);

  const dataRaw = payload["data"];
  let data: TelemetryData | null = null;
  if (dataRaw === null || dataRaw === undefined) {
    if (payload["data_available"] === true) {
      problems.push("contract mismatch: 'data_available' true with null 'data'");
    }
  } else if (!isRecord(dataRaw)) {
    problems.push("contract mismatch: 'data' is neither an object nor null");
  } else {
    data = {
      measurements: parseMeasurements(dataRaw["measurements"], problems),
    };
    const captured = optionalString(dataRaw["captured_at_utc"]);
    if (captured !== undefined) data.captured_at_utc = captured;
    const source = optionalString(dataRaw["source"]);
    if (source !== undefined && source !== null) data.source = source;
    const rawFrame = optionalString(dataRaw["raw_frame"]);
    if (rawFrame !== undefined && rawFrame !== null) data.raw_frame = rawFrame;
    const age = optionalNumber(dataRaw["age_seconds"]);
    if (age !== undefined) data.age_seconds = age;

    const chargeRaw = dataRaw["battery_charge"];
    if (isRecord(chargeRaw)) {
      const charge: BatteryCharge = { percent: asNumber(chargeRaw["percent"]) };
      if (typeof chargeRaw["estimated"] === "boolean") charge.estimated = chargeRaw["estimated"];
      if (typeof chargeRaw["method"] === "string") charge.method = chargeRaw["method"];
      const calibration = chargeRaw["calibration"];
      if (isRecord(calibration)) {
        charge.calibration = {
          voltage_low_v: optionalNumber(calibration["voltage_low_v"]) ?? null,
          voltage_high_v: optionalNumber(calibration["voltage_high_v"]) ?? null,
        };
      }
      data.battery_charge = charge;
    } else if (chargeRaw !== undefined) {
      problems.push("contract mismatch: 'data.battery_charge' is not an object");
    }

    // SMS battery block (percentage reported by the device).
    const batteryRaw = dataRaw["battery"];
    if (isRecord(batteryRaw)) {
      const battery: BatteryReported = { charge_percent: asNumber(batteryRaw["charge_percent"]) };
      if (typeof batteryRaw["charge_source"] === "string") {
        battery.charge_source = batteryRaw["charge_source"];
      }
      const voltage = optionalNumber(batteryRaw["voltage_v"]);
      if (voltage !== undefined) battery.voltage_v = voltage;
      if (typeof batteryRaw["voltage_derived"] === "boolean") {
        battery.voltage_derived = batteryRaw["voltage_derived"];
      }
      const nominal = optionalNumber(batteryRaw["voltage_nominal_v"]);
      if (nominal !== undefined) battery.voltage_nominal_v = nominal;
      const packs = optionalNumber(batteryRaw["packs"]);
      if (packs !== undefined) battery.packs = packs;
      data.battery = battery;
    } else if (batteryRaw !== undefined) {
      problems.push("contract mismatch: 'data.battery' is not an object");
    }

    const statusRaw = dataRaw["status"];
    if (isRecord(statusRaw)) {
      const status = parseStatusBlock(statusRaw);
      if (status) data.status = status;
    } else if (statusRaw !== undefined) {
      problems.push("contract mismatch: 'data.status' is not an object");
    }
  }

  if (typeof payload["telemetry_valid"] !== "boolean") {
    problems.push("contract mismatch: 'telemetry_valid' missing or not boolean");
  }
  if (typeof payload["stale"] !== "boolean") {
    problems.push("contract mismatch: 'stale' missing or not boolean");
  }
  if (!communication) {
    return { ok: false, problems, raw: payload };
  }

  return {
    ok: true,
    value: {
      api_version: payload["api_version"] as string,
      contract_version: payload["contract_version"] as string,
      device_id: payload["device_id"],
      telemetry_valid: payload["telemetry_valid"] === true,
      stale: payload["stale"] === true,
      data_available: payload["data_available"] === true,
      data,
      communication,
    },
    problems,
    raw: payload,
  };
}

export function parseIdentity(payload: unknown): Parsed<IdentityPayload> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["identity: response is not a JSON object"], raw: {} };
  }
  if (!envelope(payload, problems) || typeof payload["device_id"] !== "string") {
    return { ok: false, problems: [...problems, "identity without 'device_id'"], raw: payload };
  }
  const communication = parseCommunication(payload["communication"], problems) ?? undefined;
  const dataRaw = payload["data"];
  let data: IdentityData | null = null;
  if (isRecord(dataRaw)) {
    data = {};
    const captured = optionalString(dataRaw["captured_at_utc"]);
    if (captured !== undefined) data.captured_at_utc = captured;
    const deviceRaw = dataRaw["device"];
    if (isRecord(deviceRaw)) {
      data.device = {
        manufacturer: optionalString(deviceRaw["manufacturer"]) ?? null,
        model: optionalString(deviceRaw["model"]) ?? null,
        firmware: optionalString(deviceRaw["firmware"]) ?? null,
        raw_frame: optionalString(deviceRaw["raw_frame"]) ?? null,
      };
    }
    const nominalRaw = dataRaw["nominal"];
    if (isRecord(nominalRaw)) {
      data.nominal = {
        voltage_label: optionalString(nominalRaw["voltage_label"]) ?? null,
        voltage_v: optionalNumber(nominalRaw["voltage_v"]) ?? null,
        input_current_a: optionalNumber(nominalRaw["input_current_a"]) ?? null,
        battery_voltage_v: optionalNumber(nominalRaw["battery_voltage_v"]) ?? null,
        frequency_hz: optionalNumber(nominalRaw["frequency_hz"]) ?? null,
        raw_frame: optionalString(nominalRaw["raw_frame"]) ?? null,
      };
    }
  } else if (dataRaw !== null && dataRaw !== undefined) {
    problems.push("contract mismatch: 'data' of the identity is neither an object nor null");
  }

  return {
    ok: true,
    value: {
      api_version: payload["api_version"] as string,
      contract_version: payload["contract_version"] as string,
      device_id: payload["device_id"],
      identity_available: payload["identity_available"] === true,
      data,
      ...(isRecord(payload["configured"]) ? { configured: payload["configured"] } : {}),
      ...(communication ? { communication } : {}),
    },
    problems,
    raw: payload,
  };
}

export function parseDevices(payload: unknown): Parsed<DevicesPayload> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["devices: response is not a JSON object"], raw: {} };
  }
  if (!envelope(payload, problems)) {
    return { ok: false, problems, raw: payload };
  }
  const listRaw = payload["devices"];
  if (!Array.isArray(listRaw)) {
    return { ok: false, problems: [...problems, "devices: 'devices' missing"], raw: payload };
  }
  const devices: DeviceEntry[] = [];
  listRaw.forEach((item, index) => {
    if (!isRecord(item) || typeof item["device_id"] !== "string") {
      problems.push(`devices[${index}] without a textual 'device_id'; ignored`);
      return;
    }
    const capabilities = parseDeviceCapabilities(item["capabilities"]);
    devices.push({
      device_id: item["device_id"],
      brand: optionalString(item["brand"]) ?? null,
      model: optionalString(item["model"]) ?? null,
      transport: optionalString(item["transport"]) ?? null,
      protocol: optionalString(item["protocol"]) ?? null,
      serial_port: optionalString(item["serial_port"]) ?? null,
      communication_state: optionalString(item["communication_state"]) ?? null,
      ...(typeof item["telemetry_valid"] === "boolean"
        ? { telemetry_valid: item["telemetry_valid"] }
        : {}),
      telemetry_endpoint: optionalString(item["telemetry_endpoint"]) ?? null,
      identity_endpoint: optionalString(item["identity_endpoint"]) ?? null,
      ...(capabilities ? { capabilities } : {}),
    });
  });
  const count = optionalNumber(payload["count"]);
  return {
    ok: true,
    value: {
      api_version: payload["api_version"] as string,
      contract_version: payload["contract_version"] as string,
      ...(count !== undefined && count !== null ? { count } : {}),
      devices,
    },
    problems,
    raw: payload,
  };
}

export function parseHealth(payload: unknown): Parsed<HealthPayload> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["health: response is not a JSON object"], raw: {} };
  }
  if (!envelope(payload, problems) || typeof payload["status"] !== "string") {
    return { ok: false, problems: [...problems, "health without 'status'"], raw: payload };
  }
  const checkedAt = optionalString(payload["checked_at_utc"]);
  const uptime = optionalNumber(payload["uptime_seconds"]);
  const devicesTotal = optionalNumber(payload["devices_total"]);
  const devicesOk = optionalNumber(payload["devices_ok"]);

  // Contract 2.0: health is aggregated by device_id in `devices`.
  let devices: Record<string, HealthDeviceStatus> | undefined;
  const devicesRaw = payload["devices"];
  if (isRecord(devicesRaw)) {
    devices = {};
    for (const [deviceId, entryRaw] of Object.entries(devicesRaw)) {
      if (!isRecord(entryRaw)) {
        problems.push(`health: 'devices.${deviceId}' is not an object`);
        continue;
      }
      const entry: HealthDeviceStatus = {};
      if (typeof entryRaw["telemetry_valid"] === "boolean") {
        entry.telemetry_valid = entryRaw["telemetry_valid"];
      }
      if (typeof entryRaw["stale"] === "boolean") entry.stale = entryRaw["stale"];
      const state = optionalString(entryRaw["state"]);
      if (state !== undefined && state !== null) entry.state = state;
      const serialPort = optionalString(entryRaw["serial_port"]);
      if (serialPort !== undefined) entry.serial_port = serialPort;
      const thread = optionalString(entryRaw["collector_thread"]);
      if (thread !== undefined) entry.collector_thread = thread;
      const freshness = optionalString(entryRaw["telemetry_freshness"]);
      if (freshness !== undefined) entry.telemetry_freshness = freshness;
      const communication = optionalString(entryRaw["communication"]);
      if (communication !== undefined) entry.communication = communication;
      const identity = optionalString(entryRaw["identity"]);
      if (identity !== undefined) entry.identity = identity;
      const lastSuccess = optionalString(entryRaw["last_success_utc"]);
      if (lastSuccess !== undefined) entry.last_success_utc = lastSuccess;
      const age = optionalNumber(entryRaw["age_seconds"]);
      if (age !== undefined) entry.age_seconds = age;
      devices[deviceId] = entry;
    }
  } else if (devicesRaw !== undefined) {
    problems.push("contract mismatch: 'devices' of health is not an object");
  }

  return {
    ok: true,
    value: {
      api_version: payload["api_version"] as string,
      contract_version: payload["contract_version"] as string,
      status: payload["status"],
      ...(checkedAt !== undefined ? { checked_at_utc: checkedAt } : {}),
      ...(uptime !== undefined ? { uptime_seconds: uptime } : {}),
      ...(devicesTotal !== undefined ? { devices_total: devicesTotal } : {}),
      ...(devicesOk !== undefined ? { devices_ok: devicesOk } : {}),
      ...(devices ? { devices } : {}),
    },
    problems,
    raw: payload,
  };
}

// --------------------- battery test parsers (3.0) ----------------------------

function parseStatusBlock(value: UnknownRecord): StatusBlock | null {
  const status: StatusBlock = {};
  const rawBits = optionalString(value["raw_bits"]);
  if (rawBits !== undefined && rawBits !== null) status.raw_bits = rawBits;
  const rawByte = optionalNumber(value["raw_byte"]);
  if (rawByte !== undefined && rawByte !== null) status.raw_byte = rawByte;
  const active = value["active"];
  if (Array.isArray(active)) {
    status.active = active.filter((item): item is string => typeof item === "string");
  }
  const flags = value["flags"];
  if (isRecord(flags)) {
    const normalized: Record<string, boolean> = {};
    for (const [flag, flagValue] of Object.entries(flags)) {
      if (typeof flagValue === "boolean") normalized[flag] = flagValue;
    }
    status.flags = normalized;
  }
  return Object.keys(status).length > 0 ? status : null;
}

/** Numeric fields of a block (`baseline`, `final`, `measurements`). */
function parseNumberRecord(value: unknown): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  if (!isRecord(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || typeof raw === "number") result[key] = asNumber(raw);
  }
  return result;
}

function parseBatteryTestCapabilities(value: UnknownRecord): BatteryTestCapabilities {
  const capabilities: BatteryTestCapabilities = {};
  if (typeof value["supported"] === "boolean") capabilities.supported = value["supported"];
  if (typeof value["enabled"] === "boolean") capabilities.enabled = value["enabled"];
  if (typeof value["abort_supported"] === "boolean") {
    capabilities.abort_supported = value["abort_supported"];
  }
  const testTypes = value["test_types"];
  if (Array.isArray(testTypes)) {
    capabilities.test_types = testTypes.filter((item): item is string => typeof item === "string");
  }
  // Detail per type (window × target): preserves only the published fields.
  const typesRaw = value["types"];
  if (isRecord(typesRaw)) {
    const types: Record<string, BatteryTestTypeParams> = {};
    for (const [typeKey, paramsRaw] of Object.entries(typesRaw)) {
      if (!isRecord(paramsRaw)) continue;
      const params: BatteryTestTypeParams = {};
      for (const key of ["duration_s", "target_percent", "timeout_s", "sample_interval_s"] as const) {
        const parsed = optionalNumber(paramsRaw[key]);
        if (parsed !== undefined) params[key] = parsed;
      }
      types[typeKey] = params;
    }
    capabilities.types = types;
  }
  const duration = optionalNumber(value["duration_s"]);
  if (duration !== undefined) capabilities.duration_s = duration;
  const sampleInterval = optionalNumber(value["sample_interval_s"]);
  if (sampleInterval !== undefined) capabilities.sample_interval_s = sampleInterval;
  const cooldown = optionalNumber(value["cooldown_s"]);
  if (cooldown !== undefined) capabilities.cooldown_s = cooldown;
  const minPercent = optionalNumber(value["min_battery_percent"]);
  if (minPercent !== undefined) capabilities.min_battery_percent = minPercent;
  return capabilities;
}

function parseDeviceCapabilities(value: unknown): DeviceCapabilities | null {
  if (!isRecord(value)) return null;
  const batteryTestRaw = value["battery_test"];
  if (!isRecord(batteryTestRaw)) return null;
  return { battery_test: parseBatteryTestCapabilities(batteryTestRaw) };
}

function parseEstimate(value: unknown): BatteryTestEstimate | null {
  if (!isRecord(value)) return null;
  const estimate: BatteryTestEstimate = { available: value["available"] === true };
  const method = optionalString(value["method"]);
  if (method !== undefined && method !== null) estimate.method = method;
  const reason = optionalString(value["reason"]);
  if (reason !== undefined && reason !== null) estimate.reason = reason;
  const confidence = optionalString(value["confidence"]);
  if (confidence !== undefined && confidence !== null) estimate.confidence = confidence;
  const windowSeconds = optionalNumber(value["window_s"]);
  if (windowSeconds !== undefined) estimate.window_s = windowSeconds;
  const startCharge = optionalNumber(value["start_charge_percent"]);
  if (startCharge !== undefined) estimate.start_charge_percent = startCharge;
  const drop = optionalNumber(value["drop_percent_in_window"]);
  if (drop !== undefined) estimate.drop_percent_in_window = drop;
  const rate = optionalNumber(value["discharge_rate_pp_per_min"]);
  if (rate !== undefined) estimate.discharge_rate_pp_per_min = rate;
  const runtime = optionalNumber(value["estimated_runtime_min"]);
  if (runtime !== undefined) estimate.estimated_runtime_min = runtime;
  const capped = optionalNumber(value["capped_at_min"]);
  if (capped !== undefined) estimate.capped_at_min = capped;
  return estimate;
}

function parseMetricDelta(value: unknown): BatteryTestMetricDelta | null {
  if (!isRecord(value)) return null;
  const delta: BatteryTestMetricDelta = {};
  for (const key of [
    "start",
    "end",
    "min",
    "max",
    "delta",
    "ripple",
    "max_abs_deviation",
    "count",
  ] as const) {
    const parsed = optionalNumber(value[key]);
    if (parsed !== undefined) delta[key] = parsed;
  }
  return delta;
}

function parseErrorField(value: unknown): ContractError | null {
  if (!isRecord(value)) return null;
  if (typeof value["code"] !== "string") return null;
  return {
    code: value["code"],
    message: typeof value["message"] === "string" ? value["message"] : "",
  };
}

function parseReportBase(entry: UnknownRecord, problems: string[]): Omit<BatteryTestReport, "samples"> | null {
  if (typeof entry["test_id"] !== "string" || typeof entry["status"] !== "string") {
    problems.push("battery test: report without textual 'test_id'/'status'");
    return null;
  }
  const report: Omit<BatteryTestReport, "samples"> = {
    test_id: entry["test_id"],
    status: entry["status"],
  };
  for (const key of [
    "device_id",
    "type",
    "started_at_utc",
    "expected_end_at_utc",
    "ended_at_utc",
    "finish_reason",
  ] as const) {
    const parsed = optionalString(entry[key]);
    if (parsed !== undefined && parsed !== null) report[key] = parsed;
  }
  for (const key of [
    "requested_duration_s",
    "duration_s",
    "sample_interval_s",
    "target_percent",
    "timeout_s",
    "samples_count",
  ] as const) {
    const parsed = optionalNumber(entry[key]);
    if (parsed !== undefined) report[key] = parsed;
  }
  if (typeof entry["test_flag_observed"] === "boolean") {
    report.test_flag_observed = entry["test_flag_observed"];
  }
  const flagsSeen = entry["flags_seen"];
  if (Array.isArray(flagsSeen)) {
    report.flags_seen = flagsSeen.filter((item): item is string => typeof item === "string");
  }
  const baseline = entry["baseline"];
  if (isRecord(baseline)) report.baseline = parseNumberRecord(baseline);
  const final = entry["final"];
  if (isRecord(final)) report.final = parseNumberRecord(final);

  const deltasRaw = entry["deltas"];
  if (isRecord(deltasRaw)) {
    const deltas: NonNullable<BatteryTestReport["deltas"]> = {};
    const windowS = optionalNumber(deltasRaw["window_s"]);
    if (windowS !== undefined) deltas.window_s = windowS;
    const sampleCount = optionalNumber(deltasRaw["sample_count"]);
    if (sampleCount !== undefined) deltas.sample_count = sampleCount;
    const metricsRaw = deltasRaw["metrics"];
    if (isRecord(metricsRaw)) {
      const metrics: Record<string, BatteryTestMetricDelta> = {};
      for (const [key, raw] of Object.entries(metricsRaw)) {
        const metric = parseMetricDelta(raw);
        if (metric) metrics[key] = metric;
      }
      deltas.metrics = metrics;
    }
    report.deltas = deltas;
  }

  report.estimate = parseEstimate(entry["estimate"]);
  report.error = entry["error"] === null || entry["error"] === undefined
    ? null
    : parseErrorField(entry["error"]);
  return report;
}

/** `POST .../tests` → 202 (acceptance of the request; execution is asynchronous). */
export function parseBatteryTestAccept(payload: unknown): Parsed<BatteryTestAccept> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["battery test: acceptance is not a JSON object"], raw: {} };
  }
  if (typeof payload["test_id"] !== "string" || typeof payload["status"] !== "string") {
    return { ok: false, problems: ["battery test: acceptance without 'test_id'/'status'"], raw: payload };
  }
  const accepted: BatteryTestAccept = {
    test_id: payload["test_id"],
    device_id: typeof payload["device_id"] === "string" ? payload["device_id"] : "",
    status: payload["status"],
  };
  const type = optionalString(payload["type"]);
  if (type !== undefined && type !== null) accepted.type = type;
  for (const key of ["accepted_at_utc", "started_at_utc", "expected_end_at_utc", "report_url"] as const) {
    const parsed = optionalString(payload[key]);
    if (parsed !== undefined) accepted[key] = parsed;
  }
  for (const key of [
    "poll_interval_s",
    "requested_duration_s",
    "target_percent",
    "timeout_s",
    "sample_interval_s",
  ] as const) {
    const parsed = optionalNumber(payload[key]);
    if (parsed !== undefined) accepted[key] = parsed;
  }
  return { ok: true, value: accepted, problems, raw: payload };
}

/** `POST .../tests/{id}/abort` → 202. */
export function parseBatteryTestAbort(payload: unknown): Parsed<BatteryTestAbort> {
  const problems: string[] = [];
  if (!isRecord(payload) || typeof payload["test_id"] !== "string") {
    return { ok: false, problems: ["battery test: cancellation without 'test_id'"], raw: {} };
  }
  return {
    ok: true,
    value: {
      test_id: payload["test_id"],
      device_id: typeof payload["device_id"] === "string" ? payload["device_id"] : "",
      status: typeof payload["status"] === "string" ? payload["status"] : "",
    },
    problems,
    raw: payload,
  };
}

/** `GET .../tests/{test_id}` → 200 (report, partial while `running`). */
export function parseBatteryTestReport(payload: unknown): Parsed<BatteryTestReport> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["battery test: report is not a JSON object"], raw: {} };
  }
  const testRaw = payload["test"];
  if (!isRecord(testRaw)) {
    return { ok: false, problems: ["battery test: report without the 'test' block"], raw: payload };
  }
  const base = parseReportBase(testRaw, problems);
  if (!base) return { ok: false, problems, raw: payload };

  const report: BatteryTestReport = { ...base };
  const samplesRaw = testRaw["samples"];
  if (Array.isArray(samplesRaw)) {
    report.samples = samplesRaw
      .filter(isRecord)
      .map((sample) => {
        const parsed: BatteryTestSample = {};
        const offset = optionalNumber(sample["offset_s"]);
        if (offset !== undefined) parsed.offset_s = offset;
        // `normalized` is the basis of the charts: preserved as it came, without renaming.
        if (isRecord(sample["normalized"])) {
          parsed.normalized = parseNumberRecord(sample["normalized"]);
        }
        if (isRecord(sample["measurements"])) {
          parsed.measurements = parseNumberRecord(sample["measurements"]);
        }
        const statusRaw = sample["status"];
        if (isRecord(statusRaw)) {
          const status = parseStatusBlock(statusRaw);
          if (status) parsed.status = status;
        }
        const batteryRaw = sample["battery"];
        if (isRecord(batteryRaw)) {
          parsed.battery = {
            charge_percent: asNumber(batteryRaw["charge_percent"]),
            voltage_v: asNumber(batteryRaw["voltage_v"]),
          };
        }
        return parsed;
      });
  }
  return { ok: true, value: report, problems, raw: payload };
}

/** `GET .../tests?limit=N` → 200 (history, without the sample series). */
export function parseTestsList(payload: unknown): Parsed<TestsListPayload> {
  const problems: string[] = [];
  if (!isRecord(payload)) {
    return { ok: false, problems: ["tests: response is not a JSON object"], raw: {} };
  }
  if (typeof payload["device_id"] !== "string") {
    return { ok: false, problems: ["tests: response without 'device_id'"], raw: payload };
  }
  const listRaw = payload["tests"];
  if (!Array.isArray(listRaw)) {
    return { ok: false, problems: [...problems, "tests: 'tests' missing"], raw: payload };
  }
  const tests: BatteryTestListItem[] = [];
  listRaw.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`tests[${index}] is not an object; ignored`);
      return;
    }
    const base = parseReportBase(item, problems);
    if (!base) return;
    tests.push(base);
  });
  const count = optionalNumber(payload["count"]);
  return {
    ok: true,
    value: {
      api_version: payload["api_version"] as string,
      contract_version: payload["contract_version"] as string,
      device_id: payload["device_id"],
      ...(count !== undefined && count !== null ? { count } : {}),
      tests,
    },
    problems,
    raw: payload,
  };
}
