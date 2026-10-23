/**
 * SIMULATED DATA — NOT REAL TELEMETRY.
 *
 * Used only when `VITE_ENABLE_DEMO=true` (file `.env.development`). They serve
 * to validate the visual hierarchy without depending on the API. The interface
 * explicitly marks this mode with a warning banner, and in production the
 * variable is not set, so this module never feeds the published screen.
 *
 * The format follows contract 3.0 (multi-device/multi-protocol): the device list
 * brings two UPS units — each with `capabilities.battery_test` — and each gauge
 * declares the possible origins per protocol. The simulated telemetry is that of
 * the TS Shara (`megatec-q1`) and the history brings an already completed test.
 */
import type { DashboardPayload, GaugeDefinition, ViewerConfigPayload } from "../model/contract.js";

const DEVICE_ID = "tsshara-3200va-01";
const SMS_DEVICE_ID = "sms-ups3200s-01";
const GENERATED_AT = "2026-10-22T12:00:00.000Z";

export const DEMO_GAUGES: GaugeDefinition[] = [
  {
    id: "input_voltage_v",
    label: "Input voltage",
    unit: "V",
    sources: [{ path: "data.measurements.input_voltage_v" }],
    scale: { min: 0, max: 250, ticks: [0, 50, 100, 150, 200, 250] },
    bands: [
      { level: "critical", from: 0, to: 80, label: "Voltage out of range (low)" },
      { level: "good", from: 80, to: 127, label: "Within the expected range (127 V)" },
      { level: "critical", from: 127, to: 200, label: "Voltage out of range (intermediate)" },
      { level: "good", from: 200, to: 225, label: "Within the expected range (220 V)" },
      { level: "critical", from: 225, to: 250, label: "Voltage out of range (high)" },
    ],
    decimals: 0,
    order: 1,
  },
  {
    id: "output_voltage_v",
    label: "Output voltage",
    unit: "V",
    sources: [{ path: "data.measurements.output_voltage_v" }],
    scale: { min: 0, max: 250, ticks: [0, 50, 100, 150, 200, 250] },
    bands: [
      { level: "critical", from: 0, to: 80, label: "Voltage out of range (low)" },
      { level: "good", from: 80, to: 127, label: "Within the expected range (127 V)" },
      { level: "critical", from: 127, to: 200, label: "Voltage out of range (intermediate)" },
      { level: "good", from: 200, to: 225, label: "Within the expected range (220 V)" },
      { level: "critical", from: 225, to: 250, label: "Voltage out of range (high)" },
    ],
    decimals: 0,
    order: 2,
  },
  {
    id: "input_frequency_hz",
    label: "Input frequency",
    unit: "Hz",
    sources: [
      { path: "data.measurements.input_frequency_hz" },
      { path: "data.measurements.output_frequency_hz", label: "Output frequency" },
    ],
    scale: { min: 20, max: 70, ticks: [20, 30, 40, 50, 60, 70] },
    bands: [
      { level: "critical", from: 20, to: 42, label: "Frequency out of range (low)" },
      { level: "warning", from: 42, to: 47, label: "Warning: low frequency" },
      { level: "good", from: 47, to: 53, label: "Normal frequency (50 Hz)" },
      { level: "warning", from: 53, to: 57, label: "Warning: frequency outside the ideal" },
      { level: "good", from: 57, to: 60, label: "Normal frequency (60 Hz)" },
      { level: "warning", from: 60, to: 63, label: "Warning: high frequency" },
      { level: "critical", from: 63, to: 70, label: "Frequency out of range (high)" },
    ],
    decimals: 1,
    order: 3,
  },
  {
    id: "temperature_c",
    label: "Internal temperature",
    unit: "°C",
    sources: [{ path: "data.measurements.temperature_c" }],
    scale: { min: 0, max: 50, ticks: [0, 10, 20, 30, 40, 50] },
    bands: [
      { level: "good", from: 0, to: 25, label: "Normal temperature" },
      { level: "warning", from: 25, to: 35, label: "Warning: elevated temperature" },
      { level: "critical", from: 35, to: 50, label: "Critical temperature" },
    ],
    decimals: 0,
    order: 4,
  },
  {
    id: "battery_charge_percent",
    label: "Battery charge",
    unit: "%",
    sources: [
      {
        path: "data.battery_charge.percent",
        origin_note: "estimate",
        secondary: {
          label: "Battery voltage (measurement)",
          path: "data.measurements.battery_voltage_v",
          unit: "V",
          decimals: 1,
        },
      },
      {
        path: "data.battery.charge_percent",
        origin_note: "reported by the device",
        secondary: {
          label: "Battery voltage (derived by the API)",
          path: "data.battery.voltage_v",
          unit: "V",
          decimals: 1,
        },
      },
    ],
    scale: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    bands: [
      { level: "critical", from: 0, to: 20, label: "Critical charge" },
      { level: "warning", from: 20, to: 40, label: "Warning: low charge" },
      { level: "good", from: 40, to: 100, label: "Adequate charge" },
    ],
    decimals: 0,
    order: 5,
  },
  {
    id: "load_percent",
    label: "UPS load",
    unit: "%",
    sources: [{ path: "data.measurements.load_percent" }],
    scale: { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] },
    bands: [
      { level: "good", from: 0, to: 50, label: "Adequate load" },
      { level: "warning", from: 50, to: 75, label: "Warning: high load" },
      { level: "critical", from: 75, to: 100, label: "Critical load" },
    ],
    decimals: 0,
    order: 6,
  },
];

export const DEMO_CONFIG: ViewerConfigPayload = {
  viewer: {
    name: "UPS Monitor — Web Viewer",
    version: "1.0.0-demo",
    read_only: true,
    refresh_interval_ms: 5000,
  },
  upstream: { base_url: "http://(demo)/api/v1" },
  device_id: DEVICE_ID,
  gauges: DEMO_GAUGES,
  threshold_problems: [],
};

export const DEMO_DASHBOARD: DashboardPayload = {
  viewer: {
    name: "UPS Monitor — Web Viewer",
    version: "1.0.0-demo",
    read_only: true,
    generated_at_utc: GENERATED_AT,
    refresh_interval_ms: 5000,
    upstream: {
      base_url: "http://(demo)/api/v1",
      reachable: true,
      http_status: 200,
      duration_ms: 12,
      error: null,
    },
    device_id: DEVICE_ID,
    device_discovered: true,
    upstream_contract: { api_version: "v1", contract_version: "3.0" },
    warnings: ["DEMO MODE: simulated data, not real telemetry."],
    sources: {
      health: { ok: true, http_status: 200, duration_ms: 8, url: "/health", error: null, warnings: [] },
      devices: { ok: true, http_status: 200, duration_ms: 9, url: "/api/v1/ups", error: null, warnings: [] },
      telemetry: { ok: true, http_status: 200, duration_ms: 14, url: "/telemetry", error: null, warnings: [] },
      identity: { ok: true, http_status: 200, duration_ms: 10, url: "/identity", error: null, warnings: [] },
      tests: { ok: true, http_status: 200, duration_ms: 11, url: "/tests?limit=10", error: null, warnings: [] },
    },
  },
  health: {
    api_version: "v1",
    contract_version: "3.0",
    status: "ok",
    checked_at_utc: GENERATED_AT,
    uptime_seconds: 3600,
    devices_total: 2,
    devices_ok: 2,
    devices: {
      [DEVICE_ID]: {
        telemetry_valid: true,
        stale: false,
        state: "ok",
        serial_port: "/dev/ttyACM0",
        collector_thread: "ok",
        telemetry_freshness: "ok",
        communication: "ok",
        identity: "ok",
        last_success_utc: GENERATED_AT,
        age_seconds: 2,
      },
      [SMS_DEVICE_ID]: {
        telemetry_valid: true,
        stale: false,
        state: "ok",
        serial_port: "/dev/ttyUSB0",
        collector_thread: "ok",
        telemetry_freshness: "ok",
        communication: "ok",
        identity: "ok",
        last_success_utc: GENERATED_AT,
        age_seconds: 1.4,
      },
    },
  },
  devices: {
    api_version: "v1",
    contract_version: "3.0",
    count: 2,
    devices: [
      {
        device_id: DEVICE_ID,
        brand: "TS Shara",
        model: "Universal UPS Senoidal 3200VA",
        transport: "usb-serial-cdc-acm",
        protocol: "megatec-q1",
        serial_port: "/dev/ttyACM0",
        communication_state: "ok",
        telemetry_valid: true,
        telemetry_endpoint: `/api/v1/ups/${DEVICE_ID}/telemetry`,
        identity_endpoint: `/api/v1/ups/${DEVICE_ID}/identity`,
        // The TS Shara (megatec-q1) does NOT expose the test by default:
        // `enabled=false`. The protocol only offers the 10 s window — the
        // controlled discharge requires the device to report the battery
        // percentage.
        capabilities: {
          battery_test: {
            supported: true,
            enabled: false,
            test_types: ["duration_10s"],
            types: {
              duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
            },
            duration_s: 10,
            sample_interval_s: 0.4,
            cooldown_s: 300,
            min_battery_percent: 50,
            abort_supported: false,
          },
        },
      },
      {
        device_id: SMS_DEVICE_ID,
        brand: "SMS",
        model: "Power Sinus NG uPS3200S",
        transport: "usb-serial",
        protocol: "sms-1phase",
        serial_port: "/dev/ttyUSB0",
        communication_state: "ok",
        telemetry_valid: true,
        telemetry_endpoint: `/api/v1/ups/${SMS_DEVICE_ID}/telemetry`,
        identity_endpoint: `/api/v1/ups/${SMS_DEVICE_ID}/identity`,
        // The SMS reports the battery percentage, so it also offers the
        // controlled discharge: up to the target of 20 % or the 30 min ceiling,
        // whichever comes first.
        capabilities: {
          battery_test: {
            supported: true,
            enabled: true,
            test_types: ["duration_10s", "discharge_20pct"],
            types: {
              duration_10s: { duration_s: 10, sample_interval_s: 0.4 },
              discharge_20pct: { target_percent: 20, timeout_s: 1800, sample_interval_s: 1.0 },
            },
            duration_s: 10,
            sample_interval_s: 0.4,
            cooldown_s: 300,
            min_battery_percent: 50,
            abort_supported: true,
          },
        },
      },
    ],
  },
  telemetry: {
    api_version: "v1",
    contract_version: "3.0",
    device_id: DEVICE_ID,
    telemetry_valid: true,
    stale: false,
    data_available: true,
    data: {
      captured_at_utc: GENERATED_AT,
      source: "megatec-q1",
      measurements: {
        input_voltage_v: 222,
        input_voltage_fault_v: 222,
        output_voltage_v: 112,
        load_percent: 11,
        input_frequency_hz: 60,
        battery_voltage_v: 27.4,
        temperature_c: 26,
      },
      battery_charge: {
        percent: 100,
        estimated: true,
        method: "linear_voltage_interpolation",
        calibration: { voltage_low_v: 20.1, voltage_high_v: 26.8 },
      },
      status: {
        raw_bits: "00001001",
        active: ["STANDBY", "BEEP"],
        flags: {
          OB: false,
          LB: false,
          BOOST: false,
          FAULT: false,
          STANDBY: true,
          TEST: false,
          FSD: false,
          BEEP: true,
        },
      },
      age_seconds: 2,
    },
    communication: {
      state: "ok",
      telemetry_valid: true,
      stale: false,
      last_attempt_utc: GENERATED_AT,
      last_success_utc: GENERATED_AT,
      age_seconds: 2,
      consecutive_failures: 0,
      total_attempts: 720,
      total_successes: 720,
      last_error: null,
      serial_port: "/dev/ttyACM0",
      poll_interval_s: 5,
      stale_after_s: 20,
    },
  },
  identity: {
    api_version: "v1",
    contract_version: "3.0",
    device_id: DEVICE_ID,
    identity_available: true,
    data: {
      captured_at_utc: GENERATED_AT,
      device: {
        manufacturer: "TS -222  091225",
        model: "Senoid  32",
        firmware: "V01020805A",
        raw_frame: "#TS -222  091225 Senoid  32 V01020805A",
      },
      nominal: {
        voltage_label: "Univ.",
        voltage_v: null,
        input_current_a: 100,
        battery_voltage_v: 24,
        frequency_hz: 60,
        raw_frame: "#Univ. 100 24.00 60.0",
      },
    },
    communication: { state: "ok", telemetry_valid: true, stale: false, age_seconds: 2 },
  },
  // Simulated battery test history (contract 3.0): an already completed test,
  // to validate the panel hierarchy without having to trigger the UPS.
  tests: {
    api_version: "v1",
    contract_version: "3.0",
    device_id: DEVICE_ID,
    count: 1,
    tests: [
      {
        test_id: "demo-20261022T115900Z",
        type: "duration_10s",
        status: "completed",
        started_at_utc: "2026-10-22T11:59:00.000Z",
        expected_end_at_utc: "2026-10-22T11:59:10.000Z",
        ended_at_utc: "2026-10-22T11:59:10.320Z",
        duration_s: 10.3,
        finish_reason: "duration_elapsed",
        samples_count: 25,
        flags_seen: ["TEST", "OB"],
        estimate: {
          available: true,
          method: "linear_first_order_extrapolation",
          window_s: 10,
          start_charge_percent: 100,
          drop_percent_in_window: 1.6,
          discharge_rate_pp_per_min: 9.6,
          estimated_runtime_min: 10.4,
          capped_at_min: 600,
          confidence: "low",
        },
      },
    ],
  },
};
