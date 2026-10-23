/**
 * Fixtures for the API contract v1/3.0 (multi-device and multi-protocol).
 *
 * Values based on the real responses documented in monitor/docs/unified-api.md
 * and on the bench readings from 2026-10-22:
 *   - TS Shara Universal UPS Senoidal 3200VA (`megatec-q1`, /dev/ttyACM0);
 *   - SMS Power Sinus NG uPS3200S (`sms-1phase`, /dev/ttyUSB0).
 * They are test samples — not fixed telemetry nor expected values.
 */

export const deviceId = "tsshara-3200va-01";
export const smsDeviceId = "sms-ups3200s-01";

export const healthOk = {
  api_version: "v1",
  contract_version: "3.0",
  status: "degraded",
  checked_at_utc: "2026-10-22T15:22:04.962Z",
  uptime_seconds: 16.255,
  devices_total: 2,
  devices_ok: 1,
  devices: {
    [deviceId]: {
      telemetry_valid: true,
      stale: false,
      state: "ok",
      serial_port: "/dev/ttyACM0",
      collector_thread: "ok",
      telemetry_freshness: "ok",
      communication: "ok",
      identity: "ok",
      last_success_utc: "2026-10-22T15:22:00.112Z",
      age_seconds: 4.85,
    },
    [smsDeviceId]: {
      telemetry_valid: false,
      stale: false,
      state: "port_unavailable",
      serial_port: "/dev/ttyUSB0",
      collector_thread: "ok",
      telemetry_freshness: "unavailable",
      communication: "port_unavailable",
      identity: "unavailable",
      last_success_utc: null,
      age_seconds: null,
    },
  },
};

export const devicesOk = {
  api_version: "v1",
  contract_version: "3.0",
  count: 2,
  devices: [
    {
      device_id: deviceId,
      brand: "TS Shara",
      model: "Universal UPS Senoidal 3200VA",
      transport: "usb-serial-cdc-acm",
      protocol: "megatec-q1",
      serial_port: "/dev/ttyACM0",
      communication_state: "ok",
      telemetry_valid: true,
      telemetry_endpoint: `/api/v1/ups/${deviceId}/telemetry`,
      identity_endpoint: `/api/v1/ups/${deviceId}/identity`,
      // Contract 3.0: TS Shara declares the test, but it comes disabled
      // (`enabled: false`) and without cancellation (`abort_supported: false`).
      // The `megatec-q1` only offers the 10 s window: requesting `discharge_20pct`
      // from it would respond `422 unsupported_test_type`.
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
      device_id: smsDeviceId,
      brand: "SMS",
      model: "Power Sinus NG uPS3200S",
      transport: "usb-serial",
      protocol: "sms-1phase",
      serial_port: "/dev/ttyUSB0",
      communication_state: "port_unavailable",
      telemetry_valid: false,
      telemetry_endpoint: `/api/v1/ups/${smsDeviceId}/telemetry`,
      identity_endpoint: `/api/v1/ups/${smsDeviceId}/identity`,
      // The SMS exposes the test enabled and cancellable — and, being a device
      // that reports the battery percentage, it also offers the controlled
      // discharge: it runs until the charge reaches the 20 % target or until the
      // 30 min cap (`timeout_s: 1800`), whichever comes first.
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
};

export const devicesEmpty = {
  api_version: "v1",
  contract_version: "3.0",
  count: 0,
  devices: [],
};

export const telemetryOk = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  telemetry_valid: true,
  stale: false,
  data_available: true,
  data: {
    captured_at_utc: "2026-10-22T15:22:00.112Z",
    source: "megatec-q1",
    measurements: {
      input_voltage_v: 219.0,
      input_voltage_fault_v: 219.0,
      output_voltage_v: 111.0,
      load_percent: 11,
      input_frequency_hz: 60.0,
      battery_voltage_v: 27.4,
      temperature_c: 26.0,
    },
    battery_charge: {
      percent: 100.0,
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
    raw_frame: "(219.0 219.0 111.0 011 60.0 27.4 26.0 00001001",
    age_seconds: 4.853,
  },
  communication: {
    state: "ok",
    telemetry_valid: true,
    stale: false,
    last_attempt_utc: "2026-10-22T15:22:03.711Z",
    last_success_utc: "2026-10-22T15:22:00.112Z",
    age_seconds: 4.853,
    consecutive_failures: 0,
    total_attempts: 4,
    total_successes: 3,
    last_error: null,
    serial_port: "/dev/ttyACM0",
    poll_interval_s: 5.0,
    stale_after_s: 20.0,
  },
};

/**
 * SMS telemetry (`sms-1phase`): uses the `data.battery` block (percentage
 * reported by the device, not estimated), `output_frequency_hz` and the flags
 * frame with its own meaning (BYPASS/UPSOK). It serves to prove that the
 * interface reads the data per protocol, without renaming fields.
 */
export const telemetrySms = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: smsDeviceId,
  telemetry_valid: true,
  stale: false,
  data_available: true,
  data: {
    captured_at_utc: "2026-10-22T15:22:01.400Z",
    source: "sms-1phase",
    measurements: {
      input_voltage_v: 218.6,
      input_voltage_extended_v: 218.6,
      output_voltage_v: 217.7,
      load_percent: 19,
      output_frequency_hz: 59.9,
      temperature_c: 49.1,
    },
    battery: {
      charge_percent: 100,
      charge_source: "reported_by_device",
      voltage_v: 24.0,
      voltage_derived: true,
      voltage_nominal_v: 24.0,
      packs: 1,
    },
    status: {
      raw_byte: 41,
      raw_bits: "00101001",
      active: ["BYPASS", "UPSOK", "BEEP"],
      flags: {
        OB: false,
        LB: false,
        BYPASS: true,
        BOOST: false,
        UPSOK: true,
        TEST: false,
        FSD: false,
        BEEP: true,
      },
    },
    raw_frame: "(218.6 217.7 019 59.9 49.1 100 00101001",
    age_seconds: 1.2,
  },
  communication: {
    state: "ok",
    telemetry_valid: true,
    stale: false,
    last_attempt_utc: "2026-10-22T15:22:01.900Z",
    last_success_utc: "2026-10-22T15:22:01.400Z",
    age_seconds: 1.2,
    consecutive_failures: 0,
    total_attempts: 8,
    total_successes: 8,
    last_error: null,
    serial_port: "/dev/ttyUSB0",
    poll_interval_s: 5.0,
    stale_after_s: 20.0,
  },
};

/** Stale telemetry: `data` preserved, `telemetry_valid` false (HTTP 503). */
export const telemetryStale = {
  ...telemetryOk,
  telemetry_valid: false,
  stale: true,
  communication: {
    ...telemetryOk.communication,
    state: "stale",
    telemetry_valid: false,
    stale: true,
    age_seconds: 42.5,
    consecutive_failures: 2,
    last_error: {
      code: "timeout",
      message: "no response within command_wait_s",
      at_utc: "2026-10-22T15:22:40.000Z",
    },
  },
};

/** Collector with no valid reading yet: `data = null` (HTTP 503). */
export const telemetryNoData = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  telemetry_valid: false,
  stale: false,
  data_available: false,
  data: null,
  communication: {
    state: "starting",
    telemetry_valid: false,
    stale: false,
    last_attempt_utc: null,
    last_success_utc: null,
    age_seconds: null,
    consecutive_failures: 0,
    total_attempts: 0,
    total_successes: 0,
    last_error: null,
    serial_port: "/dev/ttyACM0",
    poll_interval_s: 5.0,
    stale_after_s: 20.0,
  },
};

export const identityOk = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  identity_available: true,
  data: {
    captured_at_utc: "2026-10-22T15:21:48.710Z",
    device: {
      manufacturer: "TS -222  091225",
      model: "Senoid  32",
      firmware: "V01020805A",
      raw_frame: "#TS -222  091225 Senoid  32 V01020805A",
    },
    nominal: {
      voltage_label: "Univ.",
      voltage_v: null,
      input_current_a: 100.0,
      battery_voltage_v: 24.0,
      frequency_hz: 60.0,
      raw_frame: "#Univ. 100 24.00 60.0",
    },
  },
  configured: {
    device_id: deviceId,
    brand: "TS Shara",
    model: "Universal UPS Senoidal 3200VA",
    protocol: "megatec-q1",
    transport: "usb-serial-cdc-acm",
    serial_port: "/dev/ttyACM0",
    serial_baud: 2400,
    poll_interval_s: 5.0,
    stale_after_s: 20.0,
  },
  communication: telemetryOk.communication,
};

/** SMS identity (`sms-1phase`). */
export const identitySms = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: smsDeviceId,
  identity_available: true,
  data: {
    captured_at_utc: "2026-10-22T15:21:50.000Z",
    device: {
      manufacturer: "SMS",
      model: "Power Sinus",
      firmware: "1.2",
      raw_frame: null,
    },
    nominal: {
      voltage_label: "220 V",
      voltage_v: 220.0,
      input_current_a: null,
      battery_voltage_v: 24.0,
      frequency_hz: 60.0,
      raw_frame: null,
    },
  },
  configured: {
    device_id: smsDeviceId,
    brand: "SMS",
    model: "Power Sinus NG uPS3200S",
    protocol: "sms-1phase",
    transport: "usb-serial",
    serial_port: "/dev/ttyUSB0",
    poll_interval_s: 5.0,
    stale_after_s: 20.0,
  },
  communication: telemetrySms.communication,
};

export const deviceNotFound = {
  api_version: "v1",
  contract_version: "3.0",
  error: {
    code: "device_not_found",
    message: `device 'nonexistent' is not configured (available: ${deviceId})`,
  },
};

export const methodNotAllowed = {
  api_version: "v1",
  contract_version: "3.0",
  error: {
    code: "method_not_allowed",
    message: "the API is read-only: use GET (no command is sent to the UPS)",
  },
};

// ---------------------------- battery test (3.0) ----------------------------
// Shapes based on monitor/docs/web-viewer-integration.md §11.3 (illustrative
// values — not real telemetry). The `test_id` is the same throughout the cycle
// (accept → follow-up → history) to reproduce the asynchronous flow.

export const testId = "9f3c1a7b2d4e5061";

/** `POST .../tests` → 202: request queued; it is NOT the test result. */
export const testAccept = {
  api_version: "v1",
  contract_version: "3.0",
  accepted_at_utc: "2026-10-22T15:04:11.402Z",
  poll_interval_s: 0.5,
  test_id: testId,
  device_id: deviceId,
  type: "duration_10s",
  status: "running",
  started_at_utc: "2026-10-22T15:04:11.400Z",
  expected_end_at_utc: "2026-10-22T15:04:21.400Z",
  requested_duration_s: 10.0,
  sample_interval_s: 0.4,
  report_url: `/api/v1/ups/${deviceId}/tests/${testId}`,
};

/**
 * `GET .../tests/{id}` while `running`: it already comes with the partial series,
 * but the aggregations (`deltas`) and the estimate are still null.
 */
export const testReportRunning = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  test: {
    test_id: testId,
    type: "duration_10s",
    status: "running",
    started_at_utc: "2026-10-22T15:04:11.400Z",
    expected_end_at_utc: "2026-10-22T15:04:21.400Z",
    ended_at_utc: null,
    duration_s: null,
    sample_interval_s: 0.4,
    finish_reason: null,
    test_flag_observed: true,
    flags_seen: ["BEEP", "OB", "TEST"],
    baseline: null,
    final: null,
    deltas: { window_s: null, sample_count: null, metrics: null },
    estimate: null,
    samples_count: 3,
    error: null,
    samples: [
      {
        offset_s: 0.401,
        // `normalized` is the standardized mirror across protocols: it is the
        // basis of the quadrant charts (a missing key would mean "no series").
        normalized: {
          input_voltage_v: 219.0,
          output_voltage_v: 218.0,
          load_percent: 19.5,
          temperature_c: 26.1,
          frequency_hz: 59.9,
          battery_charge_percent: 99.5,
          battery_voltage_v: 23.9,
        },
        measurements: { output_voltage_v: 218.0, load_percent: 19.5, output_frequency_hz: 59.9 },
        status: { raw_bits: "00101101", flags: { TEST: true } },
        battery: { charge_percent: 99.5, voltage_v: 23.9 },
      },
    ],
  },
};

/**
 * `GET .../tests/{id}` at the end: complete report with the charge drop, the
 * ripple of the metrics and the estimated runtime (`confidence: "low"`).
 */
export const testReportCompleted = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  test: {
    test_id: testId,
    type: "duration_10s",
    status: "completed",
    started_at_utc: "2026-10-22T15:04:11.400Z",
    expected_end_at_utc: "2026-10-22T15:04:21.400Z",
    ended_at_utc: "2026-10-22T15:04:21.430Z",
    duration_s: 10.03,
    sample_interval_s: 0.4,
    finish_reason: "duration_elapsed",
    test_flag_observed: true,
    flags_seen: ["BEEP", "OB", "TEST"],
    baseline: {
      output_voltage_v: 217.7,
      load_percent: 19.0,
      battery_charge_percent: 100.0,
      battery_voltage_v: 24.0,
    },
    final: {
      output_voltage_v: 217.4,
      load_percent: 26.0,
      battery_charge_percent: 92.5,
      battery_voltage_v: 22.2,
    },
    deltas: {
      window_s: 10.03,
      sample_count: 25,
      metrics: {
        battery_charge_percent: {
          start: 100.0,
          end: 92.5,
          delta: -7.5,
          ripple: 7.5,
          max_abs_deviation: 7.5,
          min: 92.5,
          max: 100.0,
          count: 25,
        },
        output_voltage_v: {
          start: 217.7,
          end: 217.4,
          delta: -0.3,
          ripple: 0.6,
          max_abs_deviation: 0.6,
          min: 217.4,
          max: 218.0,
          count: 25,
        },
        load_percent: {
          start: 19.0,
          end: 26.0,
          delta: 7.0,
          ripple: 7.0,
          max_abs_deviation: 7.0,
          min: 19.0,
          max: 26.0,
          count: 25,
        },
      },
    },
    estimate: {
      available: true,
      method: "linear_charge_extrapolation",
      window_s: 10.03,
      start_charge_percent: 100.0,
      drop_percent_in_window: 7.5,
      discharge_rate_pp_per_min: 44.86,
      estimated_runtime_min: 2.2,
      capped_at_min: 600.0,
      confidence: "low",
    },
    samples_count: 25,
    error: null,
    // Reduced series (the contract publishes ~25 points): here only enough to
    // exercise the four quadrant charts.
    samples: [
      {
        offset_s: 0.401,
        normalized: {
          input_voltage_v: 219.0,
          output_voltage_v: 218.0,
          load_percent: 19.5,
          temperature_c: 26.1,
          frequency_hz: 59.9,
          battery_charge_percent: 99.5,
          battery_voltage_v: 23.9,
        },
        measurements: { output_voltage_v: 218.0, load_percent: 19.5, output_frequency_hz: 59.9 },
        status: { raw_bits: "00101101", flags: { TEST: true } },
        battery: { charge_percent: 99.5, voltage_v: 23.9 },
      },
      {
        offset_s: 5.204,
        normalized: {
          input_voltage_v: 218.6,
          output_voltage_v: 217.4,
          load_percent: 23.0,
          temperature_c: 26.8,
          frequency_hz: 60.1,
          battery_charge_percent: 96.0,
          battery_voltage_v: 23.1,
        },
        measurements: { output_voltage_v: 217.4, load_percent: 23.0, output_frequency_hz: 60.1 },
        status: { raw_bits: "00101101", flags: { TEST: true } },
        battery: { charge_percent: 96.0, voltage_v: 23.1 },
      },
      {
        offset_s: 10.031,
        normalized: {
          input_voltage_v: 219.2,
          output_voltage_v: 217.4,
          load_percent: 26.0,
          temperature_c: 27.3,
          frequency_hz: 59.7,
          battery_charge_percent: 92.5,
          battery_voltage_v: 22.2,
        },
        measurements: { output_voltage_v: 217.4, load_percent: 26.0, output_frequency_hz: 59.7 },
        status: { raw_bits: "00101001", flags: { TEST: true } },
        battery: { charge_percent: 92.5, voltage_v: 22.2 },
      },
    ],
  },
};

/**
 * Second test type (`discharge_20pct`), offered only where the API declares it:
 * it runs until the charge reaches the 20 % target **or** until the 30 min cap,
 * whichever comes first. Here it ended at the target, well before the cap.
 */
export const testReportDischarge = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  test: {
    test_id: "b41d70c9a8e25316",
    type: "discharge_20pct",
    status: "completed",
    started_at_utc: "2026-10-22T15:20:00.000Z",
    expected_end_at_utc: "2026-10-22T15:50:00.000Z",
    ended_at_utc: "2026-10-22T15:28:12.000Z",
    duration_s: 492.0,
    target_percent: 20,
    timeout_s: 1800,
    sample_interval_s: 1.0,
    finish_reason: "target_percent_reached",
    test_flag_observed: true,
    flags_seen: ["BEEP", "OB", "TEST"],
    baseline: { battery_charge_percent: 100.0, output_voltage_v: 219.1 },
    final: { battery_charge_percent: 20.0, output_voltage_v: 217.9 },
    deltas: {
      window_s: 492.0,
      sample_count: 492,
      metrics: {
        battery_charge_percent: {
          start: 100.0,
          end: 20.0,
          delta: -80.0,
          ripple: 80.0,
          max_abs_deviation: 80.0,
          min: 20.0,
          max: 100.0,
          count: 492,
        },
        output_voltage_v: {
          start: 219.1,
          end: 217.9,
          delta: -1.2,
          ripple: 3.7,
          max_abs_deviation: 2.3,
          min: 216.4,
          max: 220.1,
          count: 492,
        },
        frequency_hz: {
          start: 60.0,
          end: 60.0,
          delta: 0.0,
          ripple: 0.5,
          max_abs_deviation: 0.3,
          min: 59.7,
          max: 60.2,
          count: 492,
        },
        temperature_c: {
          start: 26.0,
          end: 29.2,
          delta: 3.2,
          ripple: 3.2,
          max_abs_deviation: 3.2,
          min: 26.0,
          max: 29.2,
          count: 492,
        },
      },
    },
    estimate: {
      available: true,
      method: "linear_charge_extrapolation",
      window_s: 492.0,
      start_charge_percent: 100.0,
      drop_percent_in_window: 80.0,
      discharge_rate_pp_per_min: 9.76,
      estimated_runtime_min: 10.2,
      capped_at_min: 600.0,
      confidence: "low",
    },
    samples_count: 492,
    error: null,
    samples: [
      {
        offset_s: 1.0,
        normalized: {
          input_voltage_v: 219.4,
          output_voltage_v: 219.1,
          load_percent: 18.0,
          temperature_c: 26.0,
          frequency_hz: 60.0,
          battery_charge_percent: 100.0,
          battery_voltage_v: 25.6,
        },
        measurements: { output_voltage_v: 219.1, load_percent: 18.0, output_frequency_hz: 60.0 },
        status: { raw_bits: "00101101", flags: { TEST: true, OB: true } },
        battery: { charge_percent: 100.0, voltage_v: 25.6 },
      },
      {
        offset_s: 246.0,
        normalized: {
          input_voltage_v: 218.8,
          output_voltage_v: 216.4,
          load_percent: 21.5,
          temperature_c: 27.8,
          frequency_hz: 60.2,
          battery_charge_percent: 58.0,
          battery_voltage_v: 24.1,
        },
        measurements: { output_voltage_v: 216.4, load_percent: 21.5, output_frequency_hz: 60.2 },
        status: { raw_bits: "00101101", flags: { TEST: true, OB: true } },
        battery: { charge_percent: 58.0, voltage_v: 24.1 },
      },
      {
        offset_s: 492.0,
        normalized: {
          input_voltage_v: 219.0,
          output_voltage_v: 217.9,
          load_percent: 22.4,
          temperature_c: 29.2,
          frequency_hz: 59.7,
          battery_charge_percent: 20.0,
          battery_voltage_v: 21.4,
        },
        measurements: { output_voltage_v: 217.9, load_percent: 22.4, output_frequency_hz: 59.7 },
        status: { raw_bits: "00101101", flags: { TEST: true, OB: true, LB: true } },
        battery: { charge_percent: 20.0, voltage_v: 21.4 },
      },
    ],
  },
};

/** `POST .../tests` with `discharge_20pct` → 202 (`target_percent`, no fixed window). */
export const testAcceptDischarge = {
  api_version: "v1",
  contract_version: "3.0",
  accepted_at_utc: "2026-10-22T15:20:00.003Z",
  poll_interval_s: 0.5,
  test_id: "b41d70c9a8e25316",
  device_id: deviceId,
  type: "discharge_20pct",
  status: "running",
  started_at_utc: "2026-10-22T15:20:00.000Z",
  expected_end_at_utc: "2026-10-22T15:50:00.000Z",
  target_percent: 20,
  timeout_s: 1800,
  sample_interval_s: 1.0,
  report_url: `/api/v1/ups/${deviceId}/tests/b41d70c9a8e25316`,
};

/**
 * Report with `estimate.available: false`: the drop stayed below the measurable
 * resolution. The interface must show the `reason`, NEVER a number.
 */
export const testReportEstimateUnavailable = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  test: {
    test_id: testId,
    type: "duration_10s",
    status: "completed",
    started_at_utc: "2026-10-22T15:04:11.400Z",
    expected_end_at_utc: "2026-10-22T15:04:21.400Z",
    ended_at_utc: "2026-10-22T15:04:21.430Z",
    duration_s: 10.02,
    sample_interval_s: 0.4,
    finish_reason: "duration_elapsed",
    test_flag_observed: false,
    flags_seen: ["BEEP", "OB"],
    baseline: { battery_charge_percent: 100.0 },
    final: { battery_charge_percent: 100.0 },
    deltas: {
      window_s: 10.02,
      sample_count: 25,
      metrics: {
        battery_charge_percent: {
          start: 100.0,
          end: 100.0,
          delta: 0.0,
          ripple: 0.0,
          max_abs_deviation: 0.0,
          min: 100.0,
          max: 100.0,
          count: 25,
        },
      },
    },
    estimate: {
      available: false,
      reason: "charge drop below the measurable resolution",
      confidence: "low",
    },
    samples_count: 25,
    error: null,
  },
};

/** `POST .../tests/{id}/abort` → 202: the report will move to `aborted`. */
export const testAbort = {
  api_version: "v1",
  contract_version: "3.0",
  test_id: testId,
  device_id: deviceId,
  status: "aborting",
};

/** `GET .../tests?limit=N` → 200: history without the sample series. */
export const testsListOk = {
  api_version: "v1",
  contract_version: "3.0",
  device_id: deviceId,
  count: 1,
  tests: [
    {
      test_id: testId,
      type: "duration_10s",
      status: "completed",
      started_at_utc: "2026-10-22T15:04:11.400Z",
      ended_at_utc: "2026-10-22T15:04:21.430Z",
      duration_s: 10.03,
      finish_reason: "duration_elapsed",
      samples_count: 25,
      flags_seen: ["BEEP", "OB", "TEST"],
      estimate: { available: true, estimated_runtime_min: 2.2, confidence: "low" },
      error: null,
    },
  ],
};

/** Typical refusal of `POST .../tests`: 409 `test_cooldown`. */
export const testCooldownError = {
  api_version: "v1",
  contract_version: "3.0",
  error: {
    code: "test_cooldown",
    message: "wait for the cooldown between tests (300 s)",
  },
};

/** Refusal of the disabled test: 403 `test_disabled` (TS Shara by default). */
export const testDisabledError = {
  api_version: "v1",
  contract_version: "3.0",
  error: {
    code: "test_disabled",
    message: "the battery test is not enabled on this device",
  },
};
