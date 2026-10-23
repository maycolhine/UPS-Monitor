---
description: Mandatory rules for fidelity to the telemetry API contract
globs: ["src/**/*.ts", "src/**/*.tsx"]
alwaysApply: true
---

# 20 — API contract

Full contract: [docs/api-contract.md](../../docs/api-contract.md). The source of truth is
[`monitor/docs/unified-api.md`](../../monitor/docs/unified-api.md) (unified API, several UPS units on
several protocols — `contract_version` **3.0**) and, for the battery test,
[`monitor/docs/web-viewer-integration.md`](../../monitor/docs/web-viewer-integration.md) §11.

## Inviolable rules

1. **GET only — with a single controlled exception.** The only `POST` is that of the **battery test**
   (`/api/tests` in the viewer → `POST /api/v1/ups/{device_id}/tests`), and only by explicit user
   action: **no test is triggered autonomously** and no command is sent directly to the UPS unit.
   `PUT`/`PATCH`/`DELETE` remain forbidden: `apiClient` refuses them locally (`viewer_invalid_method`)
   and the viewer server responds `405` to methods ≠ GET, except `POST` on `/api/tests*`.
2. **Do not rename anything.** Field names, units and JSON paths are those of the API
   (`input_voltage_v`, `load_percent`, `data.battery_charge.percent`, ...). The interface reads them
   through the paths in `sources[]` defined in `gaugeConfig.ts` (one or more origins, one per protocol).
3. **`null` stays `null`.** Never convert `null` into `0` nor into any fictitious value. An absent field
   stays absent and appears as "No data".
4. **Do not invent fields, endpoints, units or states.** If the response diverges from the document,
   record the divergence in `viewer.warnings` and report it — without silent adaptation.
5. **Do not depend on FastAPI** nor on any internal detail of the API: the coupling is HTTP/JSON.
6. **HTTP 503 ≠ total failure.** If the API responds `503` with a valid telemetry payload, forward it
   with `200` and let `telemetry_valid`, `stale` and `communication.state` explain the state.
7. **The battery has an OPPOSITE rule per protocol.** `megatec-q1`: `data.battery_charge.percent` is an
   **ESTIMATE** (linear interpolation of the voltage; the Q1 protocol does not transmit a percentage) —
   the interface marks this and shows `battery_voltage_v` in a separate field. `sms-1phase`:
   `data.battery.charge_percent` is **reported by the device** (`charge_source: "reported_by_device"`)
   and **is not an estimate**; `voltage_v` is derived (`voltage_derived: true`). The tag is per origin
   (`origin_note`), never fixed on the metric.
8. **Do not infer "mains power normal"** from the absence of the `OB` flag.
9. **Frame flags — the meaning changes per protocol.** `megatec-q1`: `OB` (b7), `LB` (b6), `BOOST` (b5),
   `FAULT` (b4), `STANDBY` (b3), `TEST` (b2), `FSD` (b1), `BEEP` (b0). `sms-1phase`: `OB` (b7), `LB`
   (b6), `BYPASS` (b5), `BOOST` (b4), `UPSOK` (b3), `TEST` (b2), `FSD` (b1), `BEEP` (b0) — b5/b4/b3
   have a different meaning. The table is chosen by `data.source` (`flagMetaForProtocol`); unknown
   protocol → Q1 table. New flags (other models) are displayed as undocumented, with no invented
   meaning.
10. **Communication states**: `starting`, `ok`, `stale`, `port_unavailable`, `permission_denied`,
    `disconnected`, `timeout`, `invalid_response`, `incomplete_response`, `parse_error`,
    `checksum_error`, `out_of_range`, `serial_error`. New state → display its own code.
11. **Multi-device, one at a time.** The API publishes N UPS units; the interface selects **one** and
    sends `GET /api/dashboard?device_id=...`. Without the parameter, the backend resolves it by
    `UPS_DEVICE_ID` → first with `telemetry_valid:true` → first in the list → first key of
    `health.devices`. Unknown `device_id` → `404 device_not_found`. Never display two at the same time
    nor invent a device.
12. **Battery test (3.0) — the API delivers facts, the viewer presents.** Only enable the button when
    `capabilities.battery_test.enabled` is `true`; offer cancellation only with `abort_supported`. Offer
    **only** the types from `test_types` (`duration_10s`; `discharge_20pct` only where the API declares
    it) — assuming a capability from the protocol produces `422 unsupported_test_type`. On
    `discharge_20pct` the `timeout_s` (1800 s) is a **ceiling**, not the expected duration: progress
    comes from the charge drop toward `target_percent` (indeterminate when there is no data), never from
    the clock. The `POST` responds `202` and is **not** the result: follow `report_url` and stop when the
    `status` is no longer `running`. `estimate` is a 1st-order linear extrapolation
    (`confidence: "low"`); when `available` is `false`, show the `reason` and **never** invent a number;
    `capped_at_min` is a floor ("≥ 10 h"), not a precision. Show `test_flag_observed`/`flags_seen` to
    confirm that the UPS unit **really** reported the test state (`TEST`) within the window; if it did
    not, warn.
13. **Test charts: `samples[].normalized`, never `measurements`.** The charts are `samples[].offset_s`
    (X) against a key of `normalized` (`output_voltage_v`, `frequency_hz`, `temperature_c`,
    `battery_charge_percent`, `load_percent`, `battery_voltage_v`) — the `measurements` block varies by
    protocol. A **missing** key = series unavailable: show that and **never** draw zero in place of the
    missing data.

## Telemetry fields (exact paths)

```
data.captured_at_utc, data.source (protocol), data.raw_frame, data.age_seconds
data.measurements.input_voltage_v, .output_voltage_v, .load_percent, .temperature_c   (common)
   megatec-q1: .input_voltage_fault_v, .input_frequency_hz, .battery_voltage_v
   sms-1phase: .input_voltage_extended_v, .output_frequency_hz
data.battery_charge.percent, .estimated, .method, .calibration.voltage_low_v/.voltage_high_v   (megatec-q1)
data.battery.charge_percent, .charge_source, .voltage_v, .voltage_derived, .voltage_nominal_v, .packs   (sms-1phase)
data.status.raw_bits, .raw_byte, .active[], .flags{}
communication.state, .telemetry_valid, .stale, .age_seconds, .last_success_utc,
              .consecutive_failures, .last_error{code,message,at_utc}, .serial_port,
              .poll_interval_s, .stale_after_s
```

`/health` (2.0+) is aggregated: `status` (`ok`/`degraded`/`down`), `devices_total`, `devices_ok` and
`devices.{device_id}.{telemetry_valid, stale, state, serial_port, communication, identity,
last_success_utc, age_seconds}`.

Battery test (3.0): `capabilities.battery_test.{supported, enabled, test_types[], types.{duration_10s,
discharge_20pct}.{duration_s, target_percent, timeout_s, sample_interval_s}, duration_s,
sample_interval_s, cooldown_s, min_battery_percent, abort_supported}` in `GET /api/v1/ups`;
`POST .../tests` with `{type}` → acceptance `202` (`test_id`, `type`, `status`, `poll_interval_s`,
`report_url`, `requested_duration_s`, `target_percent`, `timeout_s`);
`GET .../tests/{test_id}` → `test.{type, status, started_at_utc, expected_end_at_utc, ended_at_utc,
duration_s, requested_duration_s, target_percent, timeout_s, finish_reason, test_flag_observed,
flags_seen, baseline, final, deltas.window_s,
deltas.sample_count, deltas.metrics.{start,end,min,max,delta,ripple,max_abs_deviation,count},
estimate.{available, method, window_s, start_charge_percent, drop_percent_in_window,
discharge_rate_pp_per_min, estimated_runtime_min, capped_at_min, confidence, reason}, samples_count,
error, samples[{offset_s, normalized{}, measurements{}, status{}, battery{}}]}`;
`GET .../tests?limit=N` → `count` + `tests[]` (without `samples`);
`POST .../tests/{test_id}/abort` → `202` with `status: "aborting"`. `finish_reason`:
`duration_elapsed`, `target_percent_reached`, `test_flag_cleared`, `aborted`, `battery_low`,
`watchdog`, `stopping`, `serial_error`.

Envelope: `api_version` (`v1`) and `contract_version` (`3.0`) in **all** responses, including errors
(`{"error": {"code", "message"}}`). Dates in ISO 8601 UTC with a `Z` suffix.

## API HTTP codes

| Code | Meaning | Handling |
|---|---|---|
| `200` | Intact data | Forward |
| `202` | Battery test accepted (asynchronous) | Forward; it is **not** the test result |
| `404` `not_found` | Nonexistent path | `502 upstream_contract_mismatch` |
| `404` `device_not_found` | `device_id` not configured | `404 device_not_found` |
| `404` `test_not_found` | Unknown `test_id` | `404 test_not_found` |
| `405` `method_not_allowed` | Method ≠ GET (outside `/tests`) | Must not occur |
| `403` `test_disabled` | Test not enabled | Forward; button only with `enabled: true` |
| `409` | Test guards (`test_cooldown`, `battery_too_low`, `on_battery`, `battery_low`, `test_in_progress`, `test_unavailable`, `test_not_running`) | Forward with the API's `error.code` |
| `422` | `unsupported_test_type`, `test_not_supported` | Forward with the API's `error.code` |
| `503` | No usable data | Forward with `200` and the explicit state |
