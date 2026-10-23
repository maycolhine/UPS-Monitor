# Consumed contract and published contract

This document has two parts:

1. **Consumed contract** — the REST API of the *UPS telemetry service* (`v1` / `contract_version 3.0`),
   which is the **source of truth**. Original document: [`monitor/docs/unified-api.md`](../monitor/docs/unified-api.md)
   (unified API, several UPS units on several protocols; §6.8 covers the battery test) and
   [`monitor/docs/web-viewer-integration.md`](../monitor/docs/web-viewer-integration.md) §11 (battery
   test integration guide).
2. **Published contract** — what the Web Viewer backend exposes to the interface.

Nothing was renamed, reinterpreted or invented relative to the origin API.

---

## Part 1 — Telemetry API (consumed contract)

### 1.1 Endpoints

| Method | Path | Use in the Web Viewer |
|---|---|---|
| `GET` | `/health` | **Aggregated** health of all collectors (`devices_total`, `devices_ok`, `devices{device_id:{...}}`) |
| `GET` | `/api/v1` | Contract index (not queried automatically; available for diagnostics) |
| `GET` | `/api/v1/ups` | Discovery of the available devices (list with brand, model, protocol and `capabilities`) |
| `GET` | `/api/v1/ups/{device_id}/telemetry` | Measurements, states and collection metadata of **one** device |
| `GET` | `/api/v1/ups/{device_id}/identity` | Identification and nominal information of **one** device |
| `POST` | `/api/v1/ups/{device_id}/tests` | Battery test request (`duration_10s` or `discharge_20pct`; contract 3.0 — the only write point) |
| `GET` | `/api/v1/ups/{device_id}/tests` | Test history (`?limit=N`), without the sample series |
| `GET` | `/api/v1/ups/{device_id}/tests/{test_id}` | Test report (partial while `running`) |
| `POST` | `/api/v1/ups/{device_id}/tests/{test_id}/abort` | Cancellation, when `abort_supported` |

Any other method responds `405 method_not_allowed`. The Web Viewer **only performs GET** — the only
write is the `POST` on the test routes, and only after an explicit user action. Any other method is
rejected locally with the code `viewer_invalid_method`; the viewer server responds `405` to methods ≠
GET, except `POST` on the `/api/tests` routes.

**Multi-device.** A single instance of the API publishes **N** UPS units on different
ports/protocols; the device is chosen by `device_id`. The Web Viewer discovers all of them in
`GET /api/v1/ups`, lets the user select **one at a time** and sends the choice in
`GET /api/dashboard?device_id=...` — it never displays two at the same time.

### 1.2 HTTP codes

| Code | Situation | Handling in the Web Viewer |
|---|---|---|
| `200` | Intact data | Forwarded. Valid and fresh telemetry |
| `404` `not_found` | Nonexistent path | Treated as a contract divergence (`502 upstream_contract_mismatch`) |
| `404` `device_not_found` | `device_id` not configured in the API | `404 device_not_found` to the interface |
| `405` `method_not_allowed` | Method ≠ GET | Outside the test routes the viewer only sends GET |
| `503` | Application up, without usable data (telemetry missing/stale, identity unavailable) | **Not** treated as a total failure: the payload is forwarded with `200` and the state is made explicit in `telemetry_valid`, `stale` and `communication.state` |
| `202` | Battery test **accepted** (asynchronous execution) | Forwarded with `202`; it is **not** the test result (see §1.6) |
| `400` `invalid_request` | Malformed test request | Forwarded with the API's `error.code` |
| `403` `test_disabled` | Test not enabled on the device | Forwarded; the interface only enables the button when `capabilities.battery_test.enabled` is `true` |
| `409` `test_cooldown` / `battery_too_low` / `on_battery` / `battery_low` / `test_in_progress` / `test_unavailable` / `test_not_running` | Test guards | Forwarded with the `error.code`; the API message is displayed as it came |
| `422` `unsupported_test_type` / `test_not_supported` | Test unavailable for this device/protocol | Forwarded with the `error.code` |
| `404` `test_not_found` | Unknown `test_id` | Forwarded with `404 test_not_found` |

### 1.3 Common envelope

All responses — including errors — carry `api_version` (`v1`) and `contract_version` (`3.0`). Dates in
ISO 8601 UTC with milliseconds and a `Z` suffix. Every numeric field carries the unit in its name
(`_v`, `_hz`, `_c`, `_percent`). Errors use `{"error": {"code", "message"}}`.

The Web Viewer checks both version fields and records divergences in `viewer.warnings`.

### 1.4 Telemetry

```
api_version, contract_version, device_id,
telemetry_valid, stale, data_available,
data: {
  captured_at_utc, source, raw_frame, age_seconds,
  measurements: { ... depend on the protocol ... },
  battery_charge: { percent, estimated, method, calibration { voltage_low_v, voltage_high_v } },  // megatec-q1
  battery: { charge_percent, charge_source, voltage_v, voltage_derived, voltage_nominal_v, packs }, // sms-1phase
  status: { raw_bits, raw_byte, active[], flags { ... } }
},
communication: { state, telemetry_valid, stale, last_attempt_utc, last_success_utc, age_seconds,
                 consecutive_failures, total_attempts, total_successes, last_error, serial_port,
                 poll_interval_s, stale_after_s }
```

`data.source` reports the **protocol** that produced the reading (`megatec-q1`, `sms-1phase`) and it is
what defines **which** measurements and **which** battery block appear:

| Measurement | `megatec-q1` (TS Shara) | `sms-1phase` (SMS) |
|---|---|---|
| Input voltage | `input_voltage_v` | `input_voltage_v` (+ `input_voltage_extended_v`) |
| Output voltage | `output_voltage_v` | `output_voltage_v` |
| Load | `load_percent` | `load_percent` |
| Temperature | `temperature_c` | `temperature_c` |
| Frequency | `input_frequency_hz` | `output_frequency_hz` |
| Battery voltage | `battery_voltage_v` | `battery.voltage_v` |
| Input fault | `input_voltage_fault_v` | — |
| Battery block | `battery_charge` | `battery` |

Each metric published in `GET /api/config` carries **one or more origins** (`sources`); the interface
uses the first origin present in the payload. Thus the same "Frequency" card works on both protocols,
without renaming any contract field.

**Battery — the rule is opposite between the protocols.**

- `megatec-q1` → `data.battery_charge`: `percent` is **always an estimate** (linear interpolation
  between `calibration.voltage_low_v` = 0 % and `calibration.voltage_high_v` = 100 %; the Q1 protocol
  does not transmit a percentage). `estimated: true`, `method: "linear_voltage_interpolation"`. The
  interface **always** displays the "estimate" tag and shows `battery_voltage_v` in a separate field.
- `sms-1phase` → `data.battery`: `charge_percent` comes from the **device itself**
  (`charge_source: "reported_by_device"`) and is **not an estimate**; `voltage_v` is derived
  (`voltage_derived: true`). The interface does **not** apply the estimate tag to the percentage.

When there is no valid value, `percent`/`charge_percent` is `null` — and the interface shows "No data",
never `0`.

**Frame flags — the meaning of the bits changes per protocol.** The translation table is chosen by
`data.source` (implemented in [status.ts](../src/frontend/src/model/status.ts)). Unknown protocol → Q1
table.

`megatec-q1` (Q1):

| Bit | Flag | Meaning | Severity in the interface |
|---|---|---|---|
| b7 | `OB` | Operating on battery | attention |
| b6 | `LB` | Low battery | critical |
| b5 | `BOOST` | Low input voltage / boost | attention |
| b4 | `FAULT` | Fault | critical |
| b3 | `STANDBY` | Standby mode | informational |
| b2 | `TEST` | Test in progress (the state confirmed during the ~10 s test) | informational |
| b1 | `FSD` | Scheduled shutdown | attention |
| b0 | `BEEP` | Audible alarm | attention |

`sms-1phase` (SMS) — note that b5/b4/b3 have a **different meaning** from Q1:

| Bit | Flag | Meaning | Severity in the interface |
|---|---|---|---|
| b7 | `OB` | Operating on battery | attention |
| b6 | `LB` | Low battery | critical |
| b5 | `BYPASS` | Bypass active | attention |
| b4 | `BOOST` | Boost active | attention |
| b3 | `UPSOK` | UPS in normal operation | informational |
| b2 | `TEST` | Test in progress | informational |
| b1 | `FSD` | Scheduled shutdown | attention |
| b0 | `BEEP` | Audible alarm | attention |

Some protocols also publish `status.raw_byte` (decimal) in addition to `raw_bits` (binary).

Undocumented flags (other models/brands) are displayed as informational, with the description
"State not documented in the current contract" — without inventing a meaning.

**`communication.state` states**: `starting`, `ok`, `stale`, `port_unavailable`, `permission_denied`,
`disconnected`, `timeout`, `invalid_response`, `incomplete_response`, `parse_error`, `checksum_error`,
`out_of_range`, `serial_error`. All are translated to text in
[status.ts](../src/frontend/src/model/status.ts); a new state appears with its own code (a label is
never invented).

### 1.5 Identity

```
api_version, contract_version, device_id, identity_available,
data: {
  captured_at_utc,
  device:   { manufacturer, model, firmware, raw_frame },
  nominal:  { voltage_label, voltage_v, input_current_a, battery_voltage_v, frequency_hz, raw_frame }
},
configured: { device_id, brand, model, protocol, transport, serial_port, serial_baud,
              poll_interval_s, stale_after_s },
communication: { ... }
```

Contract note: on the current device, `voltage_label` is `"Univ."` (not numeric), therefore `voltage_v`
is `null`. The interface displays "—" in that case, with no fictitious value.

A failure to read the identification **does not** invalidate the telemetry: `/identity` responds `503`
and `/telemetry` continues normally. The interface treats this as a partial absence of details.

### 1.6 Battery test (contract 3.0)

Contract 3.0 adds a **single write**: the battery test. It is **asynchronous** — the `POST` only
enqueues the request, which the collector executes on the next cycle; the result is obtained from the
report at `report_url`.

**Two test types.** The `type` sent in the `POST` chooses the behavior, and each device declares in
`test_types` **what it accepts** — sending a type outside the list responds `422 unsupported_test_type`:

| `type` | What it does | How it ends |
|---|---|---|
| `duration_10s` *(default)* | **fixed** window of ~10 s | end of the window (`duration_elapsed`) or `watchdog` |
| `discharge_20pct` | **no window**: runs until the charge drops to the **20 % target** | target reached (`target_percent_reached`) or the safety ceiling of **30 min** (`watchdog`) |

`discharge_20pct` only exists where the protocol knows how to **cancel** the test
(`abort_supported: true`) — currently only `sms-1phase`. `megatec-q1` (TS Shara) declares **only**
`duration_10s`: without cancellation, a "no window" test would only end when the battery dropped, and
`megatec-q1` **refuses** `discharge_20pct`. The viewer does **not** assume a capability from the
protocol: it reads what the API declares.

**Discovery.** `GET /api/v1/ups` publishes, per device:

```
capabilities: { battery_test: {
  supported, enabled,
  test_types: ["duration_10s", "discharge_20pct"],
  types: { duration_10s:    { duration_s, target_percent: null, timeout_s, sample_interval_s },
           discharge_20pct: { duration_s: null, target_percent, timeout_s, sample_interval_s } },
  duration_s, sample_interval_s, cooldown_s, min_battery_percent, abort_supported } }
```

`enabled` decides whether the button can be triggered; `abort_supported` decides whether the
cancellation is offered; `types.<type>` carries the detail of each type (window × target/ceiling). In
`discharge_20pct`, `duration_s` is `null` and `timeout_s` (1800 s) is a **ceiling**, not the expected
duration — the test usually ends earlier, when the charge reaches the target.

**Flow**

```
POST .../tests  → 202 { test_id, type, status: "running", poll_interval_s, report_url, ... }
   ↓ (the collector executes on the next cycle; up to poll_interval_s later)
GET report_url (every poll_interval_s ≈ 0.5 s)
   → running  (partial series; deltas/estimate null)
   → completed | aborted | failed   (final report)
POST .../tests/{id}/abort → 202 { status: "aborting" }   (only with abort_supported)
```

**Acceptance (`POST .../tests` → 202)** — not the result: `test_id`, `device_id`, `type`, `status`,
`started_at_utc`, `expected_end_at_utc`, `requested_duration_s`, `target_percent`, `timeout_s`,
`sample_interval_s`, `poll_interval_s`, `report_url`. In the window test, `requested_duration_s`
carries the window and `target_percent` is `null`; in the target test it is the reverse.

**Report (`GET .../tests/{test_id}` → 200)** — `test` block:

```
test_id, type, status (running|completed|aborted|failed),
started_at_utc, expected_end_at_utc, ended_at_utc, duration_s, sample_interval_s,
requested_duration_s, target_percent, timeout_s,
finish_reason,            // duration_elapsed | target_percent_reached | test_flag_cleared | aborted |
                          // battery_low | watchdog | stopping | serial_error
test_flag_observed,       // true when the UPS unit raised the TEST flag — proof that the test occurred
flags_seen[],             // flags observed within the window
baseline{}, final{},      // reference and end values (already normalized)
deltas: { window_s, sample_count, metrics: { <metric>: { start, end, min, max, delta, ripple,
                                                         max_abs_deviation, count } } },
estimate: { available, method, window_s, start_charge_percent, drop_percent_in_window,
            discharge_rate_pp_per_min, estimated_runtime_min, capped_at_min, confidence, reason },
samples_count, error,
samples[ { offset_s, normalized{}, measurements{}, status{}, battery{} } ]
```

**`samples[].normalized`** is the **cross-protocol standardized** mirror and is the source of the
charts (`measurements` keeps the original names of each protocol and **varies** by model). Keys:
`input_voltage_v`, `output_voltage_v`, `load_percent`, `temperature_c`, `frequency_hz`,
`battery_charge_percent`, `battery_voltage_v`. A **missing** key means "series unavailable for this
device" — **never** zero; the viewer does not draw the line in that case.

**History (`GET .../tests?limit=N` → 200)** — `count` and `tests[]` in the same format as the report,
**without** the `samples` series; each item carries `type`.

**Estimate.** `estimate` is a **1st-order linear extrapolation** from the charge drop in the window,
always with `confidence: "low"`; `estimated_runtime_min` is bounded by `capped_at_min` (600 min) —
when it equals the ceiling, the value is a **floor** ("≥ 10 h"), not a precision. When `available` is
`false`, the `reason` field explains the absence — **the interface never converts that into a
number**. That is the golden rule: **the API delivers the facts; the Web Viewer presents** (never
invents).

**Confirmation of the test state.** The report carries `test_flag_observed` and `flags_seen`. If the
device does not report the `TEST` flag during the window, the interface shows an explicit notice — it
is the proof that the test actually occurred on the UPS unit, and not merely that the API scheduled
it.

**Cancellation.** With `abort_supported: false`, the `POST .../abort` only stops the sampling; the
interface warns about this before the click (guards displayed in the panel).

**Guards and errors** (envelope `{"error": {"code", "message"}}`, `message` in English, ready to
display; the code is preserved by the viewer backend):

| HTTP | `error.code` | When |
|---|---|---|
| `403` | `test_disabled` | `allow_battery_test` is not enabled on the device |
| `422` | `unsupported_test_type` | `type` outside the ones accepted **by this device** (e.g. `discharge_20pct` on `megatec-q1`) |
| `422` | `test_not_supported` | the protocol does not offer a test |
| `422` | `test_requires_battery_percent` | `discharge_20pct` on telemetry **without** a battery percentage |
| `409` | `test_unavailable` / `test_in_progress` / `on_battery` / `battery_low` / `battery_too_low` / `battery_at_target` / `test_cooldown` / `test_not_running` | test state guards |
| `400` | `invalid_request` | body is not a valid JSON object (or `type` is not a string) |
| `404` | `device_not_found` / `test_not_found` | device / test does not exist |

### 1.7 Observed divergences

No divergence between the API implementation and the `unified-api.md` document was found. The behavior
was checked against the real devices:

- `GET /api/v1/ups` → `200`, `count: 2` — `tsshara-3200va-01` (`megatec-q1`, `telemetry_valid:true`)
  and `sms-ups3200s-01` (`sms-1phase`, `port_unavailable`: USB cable absent);
- `GET /health` → `503` `degraded`, aggregated (`devices_total: 2`, `devices_ok: 1`, `devices{...}`);
- `GET /api/v1/ups/tsshara-3200va-01/telemetry` → `200`, input ~221 V, output 111 V, 60 Hz,
  battery 27 V, 26 °C, load 11 %, battery 100 % (estimated), `STANDBY` + `BEEP`;
- `GET /api/v1/ups/sms-ups3200s-01/telemetry` → `503` with `data: null` and
  `communication.state: "port_unavailable"` — forwarded as `200` with the explicit state;
- unknown `?device_id=` → `404 device_not_found`.

The values above are **evidence of specific readings**, not expected or fixed values.

---

## Part 2 — API published by the Web Viewer

Only `GET`, except the battery test routes (`/api/tests*`), which also accept `POST` — never triggered
autonomously, only by user action. The other methods receive `405 method_not_allowed`.

### 2.1 `GET /healthz`

Health of the **container** — does not query the telemetry API (an offline UPS unit must not restart
the container).

```json
{ "status": "ok", "service": "ups-monitor-viewer", "version": "1.0.0", "read_only": true, "uptime_seconds": 123 }
```

### 2.2 `GET /api/config`

```json
{
  "viewer": { "name": "UPS Monitor — Web Viewer", "version": "1.0.0", "read_only": true,
              "refresh_interval_ms": 5000 },
  "upstream": { "base_url": "http://host.docker.internal:8080" },
  "device_id": null,
  "gauges": [ { "id": "input_voltage_v", "label": "Input voltage", "unit": "V",
                "sources": [ { "path": "data.measurements.input_voltage_v" } ],
                "scale": { "min": 0, "max": 250, "ticks": [0, 50, 100, 150, 200, 250] },
                "bands": [ { "level": "critical", "from": 0, "to": 80, "label": "..." } ],
                "decimals": 0, "order": 1 } ],
  "threshold_problems": []
}
```

`sources[].path` is the **exact** path of the field in the telemetry payload; the interface reads the
value through that path — no name is rewritten in the frontend. A metric can have **more than one
origin** (different protocols publish the same data in different fields); the interface uses the
**first origin present** in the payload. Each origin can optionally declare:

- `label` — alternative label of the metric when that origin is used (e.g. "Output frequency");
- `origin_note` — tag displayed on the card (e.g. `"estimate"` on `megatec-q1`,
  `"reported by the device"` on `sms-1phase`);
- `secondary` — complementary measurement displayed next to the gauge (`label`, `path`, `unit`,
  `decimals`), such as the battery voltage.

`device_id` is `null` when the backend discovers the device automatically (see §2.3).

`threshold_problems` lists inconsistencies in `VIEWER_GAUGE_THRESHOLDS` (invalid JSON, unknown metric,
band outside the scale, overlapping bands). When it is not empty, the interface shows an informational
notice.

### 2.3 `GET /api/dashboard`

```json
{
  "viewer": {
    "name": "UPS Monitor — Web Viewer", "version": "1.0.0", "read_only": true,
    "generated_at_utc": "...", "refresh_interval_ms": 5000,
    "upstream": { "base_url": "...", "reachable": true, "http_status": 200,
                  "duration_ms": 12, "error": null },
    "device_id": "tsshara-3200va-01", "device_discovered": true,
    "upstream_contract": { "api_version": "v1", "contract_version": "3.0" },
    "warnings": [],
    "sources": {
      "health":    { "ok": true, "http_status": 200, "duration_ms": 8, "url": "...",
                     "error": null, "warnings": [] },
      "devices":   { "...": "..." },
      "telemetry": { "...": "..." },
      "identity":  { "...": "..." },
      "tests":     { "...": "..." }
    }
  },
  "health": null | { ... API responses, without renaming fields ... },
  "devices": null | { ... },
  "telemetry": null | { ... },
  "identity": null | { ... },
  "tests": null | { ... history of `GET /api/v1/ups/{device_id}/tests` ... }
}
```

The `health`, `devices`, `telemetry`, `identity` and `tests` blocks are the API response **preserved**,
with the original field names. `null` means "it was not possible to obtain a usable payload" and is
never replaced with zeros. `health` carries the **aggregated** payload (`devices_total`, `devices_ok`,
`devices{device_id:{...}}`); `devices` carries the list from `GET /api/v1/ups` — it is from there that
the interface builds the "Collected UPS units" block and reads `capabilities.battery_test`; `tests`
carries the battery test history (`count`, `tests[]`) and is queried only when there is a test in
progress or completed. The **absence** of the history does not bring down the dashboard: `tests`
stays `null` and the panel shows the empty state.

**Device selection.** `GET /api/dashboard?device_id=<id>` selects **one** UPS unit. Without the
parameter, the backend resolves it by default, in this order: `UPS_DEVICE_ID` → first device with
`telemetry_valid:true` → first in the list → first key of `health.devices`. An unknown `device_id`
responds `404 device_not_found`. The interface sends the user's choice in the `query` and always
displays the `device_id` that the backend **confirmed** it served (`viewer.device_id`), never the
requested one.

**Error envelope.** When the outcome is not `200`, the body carries only `viewer` + `error`
(`{"viewer": {...}, "error": {"code": "...", "message": "..."}}`); the other blocks are absent. In
those cases `viewer.upstream` **always** describes the condition of the origin API (`reachable: false`
and `error` filled in), including when the failure occurred while discovering the device in
`GET /api/v1/ups`. It is what allows the interface to distinguish *"Telemetry API unavailable"* from
*"Web Viewer service unreachable"* (scope §10).

**Codes**

| Code | `error.code` | When |
|---|---|---|
| `200` | — | Usable payload. Includes the case where the API responded `503` but published telemetry with `stale:true` |
| `404` | `device_not_found` | The API responded `device_not_found` for the `device_id` |
| `404` | `no_devices_configured` | `GET /api/v1/ups` returned no devices and `/health` brought no `device_id` |
| `502` | `upstream_unreachable` | Network/DNS/connection failure to the API |
| `502` | `upstream_timeout` | No response within `UPS_API_TIMEOUT_MS` |
| `502` | `upstream_invalid_json` | Response is not valid JSON |
| `502` | `upstream_unexpected_status` | API contract error that is not `device_not_found` |
| `502` | `upstream_contract_mismatch` | Valid JSON, but outside the documented contract |
| `500` | `viewer_internal_error` | Unexpected failure of the Web Viewer itself |

### 2.4 `GET /api/devices`

`200` with `{ "viewer": {...}, "devices": {...} }`, or the same error envelope above when
`GET /api/v1/ups` fails.

### 2.5 `/api/tests…` — battery test

The viewer's write routes **forward** the request to the origin API (it is the one that executes the
command on the UPS unit). No test is triggered autonomously: the `POST` only exists after an explicit
user action in the panel. All of them accept `?device_id=...`; without the parameter, the backend
resolves the device as in §2.3.

| Route | Body | Success | Errors |
|---|---|---|---|
| `POST /api/tests` | `{ "type": "duration_10s" }` or `{ "type": "discharge_20pct" }` (optional; absent = `duration_10s`) | `202` with the acceptance (`test_id`, `type`, `status`, `poll_interval_s`, `report_url`) | Error envelope (§2.3) with the API's `error.code`: `403 test_disabled`, `409 test_cooldown`/`battery_too_low`/`on_battery`/`battery_low`/`battery_at_target`/`test_in_progress`/`test_unavailable`, `422 unsupported_test_type`/`test_not_supported`/`test_requires_battery_percent`, `404 device_not_found` |
| `GET /api/tests/{test_id}` | — | `200` with the report (`test`), partial while `running` | `404 test_not_found`; `502 upstream_*` if the API does not respond |
| `POST /api/tests/{test_id}/abort` | — | `202` with `status: "aborting"` | `409 test_not_running`; `422`/`403` when the protocol does not cancel |

The success body is the API payload **preserved** (same field names). The interface offers **only**
the types declared in `capabilities.battery_test.test_types` of the chosen device — offering
`discharge_20pct` where the API does not declare it would only produce `422 unsupported_test_type`.
The interface polls the report every `poll_interval_s` informed in the acceptance and stops when the
`status` is no longer `running`.

### 2.6 Nonexistent path

`404` `{ "error": { "code": "not_found", "message": "resource not found in this application" } }`.

### 2.7 Static interface

When `VIEWER_STATIC_DIR` points to the compiled interface, any route that is not `/api/*` or
`/healthz` returns `index.html` (SPA). It is what allows serving the interface and the API on the same
origin, without CORS.
