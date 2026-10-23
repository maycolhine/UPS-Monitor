# Battery Test — How the Data Is Sent (Communication Contract)

**Transfer** document from the *UPS Monitoring* project to the sibling project **UPS Monitor — Web
Viewer**. It describes, end to end, **what the `upsmon` API sends** during and after a battery
test: the two test types, the request flow, the complete layout of the timeline (`samples[]`),
the normalized fields used in the charts and the reading of each summary.

- **Base URL:** `http://127.0.0.1:8080` (the API does not listen on the Docker bridge — see
  [web-viewer-integration.md §2](web-viewer-integration.md)).
- **Contract:** `api_version: "v1"`, `contract_version: "3.0"`.
- **Source of truth for the general envelope:** [unified-api.md](unified-api.md) (§6.8 = battery test).
- **Companion document:** [battery-test-quadrant.md](battery-test-quadrant.md) — how to **apply**
  this data inside the *Battery Test quadrant* in the viewer.

This document answers a single question: **"what arrives through the API and how should each field be interpreted?"**.
The construction of the charts and the presentation are covered in the companion document.

---

## 1. One-page summary

1. The viewer sends `POST /api/v1/ups/{device_id}/tests` with `{"type": "duration_10s"}` **or**
   `{"type": "discharge_20pct"}`.
2. The API responds **`202 Accepted`** with a `test_id` and a `report_url`. The request is **asynchronous**: it only
   starts executing on the next collector cycle (up to `poll_interval_s` = 5 s).
3. The viewer **polls** `report_url` (suggested: every `poll_interval_s` = **0.5 s**) and receives, already
   during the test, the **partial timeline** in `test.samples[]`.
4. At the end, `test.status` becomes `completed` / `aborted` / `failed` and the report brings `deltas`, `estimate`,
   `baseline` and `final` filled in.
5. For the charts, **each sample** brings `samples[].offset_s` (X axis) and `samples[].normalized` (Y axes).
   This is the field the viewer uses to draw the curves — there is no need to derive anything from the
   `measurements` block.

---

## 2. Two test types

| `type` | What it does | How it ends | Where it exists |
|---|---|---|---|
| `duration_10s` *(default)* | **fixed** window of ~10 s | end of the window (`duration_elapsed`) or `watchdog` | all protocols with a test |
| `discharge_20pct` | **no window**: runs until the reported charge drops to the **fixed target of 20 %** | target reached (`target_percent_reached`) or safety ceiling of **30 min** (`watchdog`) | **only** where the protocol knows how to **cancel** the test — today only `sms-1phase` |

- **`duration_10s`** is the only type of the TS Shara (`megatec-q1`): it does **not** know how to cancel the test, so a
  "windowless" test would only end when the battery dropped — which would shut down the servers. That is why
  `megatec-q1` **refuses** `discharge_20pct` (`422 unsupported_test_type`).
- **`discharge_20pct`** is only valid where the `abort_supported` capability is `true`. The duration parameter of the
  test command is sent as "no duration" **on purpose**, and the API guarantees the cancellation as soon as
  the charge reaches the target.

**How to discover what the device accepts** (`GET /api/v1/ups`, field `capabilities.battery_test`):

```json
"capabilities": {
  "battery_test": {
    "supported": true, "enabled": true,
    "test_types": ["duration_10s", "discharge_20pct"],
    "types": {
      "duration_10s":      { "duration_s": 10.0, "target_percent": null, "timeout_s": 12.0,   "sample_interval_s": 0.4 },
      "discharge_20pct":   { "duration_s": null, "target_percent": 20.0, "timeout_s": 1800.0, "sample_interval_s": 2.0  }
    },
    "duration_s": 10.0, "sample_interval_s": 0.4, "cooldown_s": 300.0,
    "min_battery_percent": 50.0, "abort_supported": true
  }
}
```

| Field of `types.<type>` | `duration_10s` | `discharge_20pct` | Use in the viewer |
|---|---|---|---|
| `duration_s` | `10.0` (window) | `null` (**no window**) | progress bar of the window test |
| `target_percent` | `null` | `20.0` | label "discharges down to 20 %" |
| `timeout_s` | `12.0` (`10 + 2 s`) | `1800.0` (30 min) | safety ceiling — when the test **stops no matter what** |
| `sample_interval_s` | `0.4` | `2.0` | expected pace between samples |

`test_types` on `megatec-q1` brings **only** `["duration_10s"]` (no `discharge_20pct`).

---

## 3. Request flow

```text
[viewer] POST /api/v1/ups/{device_id}/tests
             body: {"type": "duration_10s"}   (or {"type": "discharge_20pct"})
                 |
                 v
         202 Accepted  { test_id, report_url, expected_end_at_utc, poll_interval_s:0.5, ... }
                 |
                 |  polling on report_url (recommended: every 0.5 s)
                 v
   GET /api/v1/ups/{device_id}/tests/{test_id}
                 |
                 +-- status "running"    -> test.samples[] PARTIAL (live timeline)
                 |                          test.deltas / test.estimate still null
                 |
                 +-- status "completed"  -> COMPLETE report
                 +-- status "aborted"    -> complete report (aborted by the client)
                 +-- status "failed"     -> report with test.error filled in
```

Points that prevent interface bugs:

- The `POST` **does not** return the test result — it only **accepts** the request. Always follow it through
  `report_url`.
- The complete report takes **`expected_end_at_utc` + up to 5 s** (the request enters the queue and only runs on the
  next collector cycle).
- During the test (which may last up to 30 min for `discharge_20pct`), `samples[]` **already arrives filled in** — it is
  possible to draw the curves in real time with no extra endpoint.

### 3.1 Input (request)

```http
POST /api/v1/ups/{device_id}/tests
Content-Type: application/json

{ "type": "duration_10s" }
```

- **Optional** body: `{}` or absent is equivalent to `duration_10s`.
- `device_id` is the same `UPS_DEVICE_ID` as in the telemetry.

```bash
# fixed-window test (~10 s)
curl -s -X POST http://127.0.0.1:8080/api/v1/ups/sms-ups3200s-01/tests \
     -H 'Content-Type: application/json' -d '{"type":"duration_10s"}' | python3 -m json.tool

# controlled discharge test (stops on its own at the 20 % target or at the 30 min ceiling)
curl -s -X POST http://127.0.0.1:8080/api/v1/ups/sms-ups3200s-01/tests \
     -H 'Content-Type: application/json' -d '{"type":"discharge_20pct"}' | python3 -m json.tool
```

### 3.2 Output — acceptance (`202 Accepted`)

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "accepted_at_utc": "2026-10-22T15:04:11.402Z",
  "poll_interval_s": 0.5,
  "test_id": "9f3c1a7b2d4e5061",
  "device_id": "sms-ups3200s-01",
  "type": "duration_10s",
  "status": "running",
  "started_at_utc": "2026-10-22T15:04:11.400Z",
  "expected_end_at_utc": "2026-10-22T15:04:21.400Z",
  "requested_duration_s": 10.0,
  "target_percent": null,
  "timeout_s": 12.0,
  "sample_interval_s": 0.4,
  "report_url": "/api/v1/ups/sms-ups3200s-01/tests/9f3c1a7b2d4e5061"
}
```

On `discharge_20pct` the same payload arrives with `"requested_duration_s": null`, `"target_percent": 20.0`,
`"timeout_s": 1800.0`, `"sample_interval_s": 2.0`; and `expected_end_at_utc` = start + **30 min** (it is the
**ceiling**, not a predicted duration — the test normally ends earlier, when the charge reaches 20 %).

| Acceptance field | Meaning |
|---|---|
| `poll_interval_s` | Suggested polling pace for the report (0.5 s) |
| `report_url` | Relative path of the report — **concatenate** it with the base URL, do not build it by hand |
| `expected_end_at_utc` | Expected end (window) or **ceiling** (`discharge_20pct`) |
| `requested_duration_s` | Requested window; `null` in the target-based test |
| `target_percent` | Charge target (`discharge_20pct`); `null` in the window test |
| `timeout_s` | Watchdog of the window (stops sampling no matter what) |

### 3.3 At this point the test has not started yet

`status` already arrives as `running` in the acceptance because the request was merely **queued**. Execution begins on the next
collector cycle (up to `poll_interval_s`, default 5 s). Do not interpret the acceptance as "test in progress".

---

## 4. Report (`GET .../tests/{test_id}` → `200`)

While `status = "running"`, `samples` arrives **partial** (what has already been sampled) and `deltas`/`estimate` are
`null`. At the end, the report is complete.

> **Illustrative example** — the **shape** of the payload is this one; the **numbers** below are examples (they are not a real
> measurement). The real report comes from your equipment.

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "device_id": "sms-ups3200s-01",
  "test": {
    "test_id": "9f3c1a7b2d4e5061",
    "device_id": "sms-ups3200s-01",
    "type": "discharge_20pct",
    "status": "completed",
    "started_at_utc": "2026-10-22T15:04:16.901Z",
    "expected_end_at_utc": "2026-10-22T15:34:16.900Z",
    "ended_at_utc": "2026-10-22T15:09:42.118Z",
    "requested_duration_s": null,
    "duration_s": 325.217,
    "sample_interval_s": 2.0,
    "target_percent": 20.0,
    "timeout_s": 1800.0,
    "finish_reason": "target_percent_reached",
    "test_flag_observed": true,
    "flags_seen": ["BEEP", "BYPASS", "OB", "TEST", "UPSOK"],

    "baseline": {
      "input_voltage_v": 218.6, "output_voltage_v": 217.7, "load_percent": 19.0,
      "temperature_c": 49.1, "frequency_hz": 59.9,
      "battery_charge_percent": 100.0, "battery_voltage_v": 24.0
    },
    "final": {
      "input_voltage_v": 218.4, "output_voltage_v": 216.9, "load_percent": 27.0,
      "temperature_c": 52.3, "frequency_hz": 59.8,
      "battery_charge_percent": 20.0, "battery_voltage_v": 21.6
    },

    "deltas": {
      "window_s": 325.217,
      "sample_count": 163,
      "metrics": {
        "battery_charge_percent": {
          "start": 100.0, "end": 20.0, "min": 20.0, "max": 100.0,
          "delta": -80.0, "ripple": 80.0, "max_abs_deviation": 80.0, "count": 163
        },
        "output_voltage_v": {
          "start": 217.7, "end": 216.9, "min": 215.4, "max": 219.1,
          "delta": -0.8, "ripple": 3.7, "max_abs_deviation": 2.3, "count": 163
        },
        "frequency_hz": {
          "start": 59.9, "end": 59.8, "min": 59.6, "max": 60.1,
          "delta": -0.1, "ripple": 0.5, "max_abs_deviation": 0.3, "count": 163
        },
        "temperature_c": {
          "start": 49.1, "end": 52.3, "min": 49.1, "max": 52.3,
          "delta": 3.2, "ripple": 3.2, "max_abs_deviation": 3.2, "count": 163
        },
        "load_percent": {
          "start": 19.0, "end": 27.0, "min": 19.0, "max": 27.0,
          "delta": 8.0, "ripple": 8.0, "max_abs_deviation": 8.0, "count": 163
        }
      }
    },
    "estimate": {
      "available": true,
      "method": "linear_regression_trimmed",
      "window_s": 325.217,
      "readings_total": 163,
      "readings_used": 158,
      "transient_readings_dropped": 5,
      "drop_percent_in_window": 80.0,
      "drop_percent_used": 74.0,
      "discharge_rate_pp_per_min": 14.76,
      "reference_charge_percent": 26.0,
      "estimated_runtime_min": 6.8,
      "capped_at_min": 600.0,
      "confidence": "low"
    },
    "samples_count": 163,
    "error": null,

    "samples": [
      {
        "offset_s": 2.014,
        "measurements": {
          "input_voltage_extended_v": 0.0, "input_voltage_v": 218.6,
          "output_voltage_v": 218.0, "load_percent": 19.5,
          "output_frequency_hz": 59.9, "temperature_c": 49.1
        },
        "status": {
          "raw_bits": "00101101", "raw_byte": 45,
          "active": ["BEEP", "TEST", "UPSOK", "BYPASS"],
          "flags": { "OB": false, "LB": false, "BYPASS": true, "BOOST": false,
                     "UPSOK": true, "TEST": true, "FSD": false, "BEEP": true }
        },
        "battery": { "charge_percent": 99.5, "voltage_v": 23.9 },
        "normalized": {
          "input_voltage_v": 218.6, "output_voltage_v": 218.0, "load_percent": 19.5,
          "temperature_c": 49.1, "frequency_hz": 59.9,
          "battery_charge_percent": 99.5, "battery_voltage_v": 23.9
        }
      }
    ]
  }
}
```

### 4.1 Reading the top-level fields of `test`

| Field | Meaning |
|---|---|
| `type` | `duration_10s` or `discharge_20pct` |
| `status` | `running` → then `completed` \| `aborted` \| `failed` |
| `requested_duration_s` | Requested window (`null` in the target-based test) |
| `duration_s` | Window **actually** sampled (may differ from `requested_duration_s`) |
| `sample_interval_s` | Expected interval between samples |
| `target_percent` | Charge target (`discharge_20pct`); `null` in the window test |
| `timeout_s` | Safety ceiling of the window |
| `finish_reason` | Why the window ended (§4.5) |
| `test_flag_observed` | `true` if the UPS raised the `TEST` flag (confirms that the test took place) |
| `flags_seen` | Union of all flags seen in the window (reveals `OB`, `TEST`, `LB`…) |
| `baseline` | Valid reading **immediately before** the test — already normalized (§4.3) |
| `final` | Last sample of the window — already normalized (§4.3) |
| `deltas` | Aggregation per metric (§4.4) |
| `estimate` | Runtime predictability (§4.6) |
| `samples_count` | Number of samples in the timeline |
| `error` | `{code, message}` when the test fails (e.g.: `no_samples`) |

---

## 5. The timeline: `samples[]`

`samples[]` is the **time series** of the test. **Each item** is a sample with five blocks:

| Block | Present | Content |
|---|---|---|
| `offset_s` | always | Seconds since the start of the window — **X axis** of all charts |
| `normalized` | almost always | **Normalized** metrics (same name in both protocols) — **Y axes of the charts** |
| `measurements` | always | **Raw protocol measurements** (names specific to each model) |
| `status` | always | `raw_bits`, `active[]`, `flags{}` (the SMS adds `raw_byte`) |
| `battery` | on the SMS / when available | Summary `{charge_percent, voltage_v}` |

> **Golden rule for the charts:** use **`samples[].normalized`**, not `measurements`. The `measurements` block
> keeps the original names of each protocol (so as not to break existing Zabbix integrations)
> and **varies between models** — using `normalized` makes the same chart code work on the TS
> Shara and on the SMS without handling differences.

### 5.1 Contract of the `normalized` block

| Key of `normalized` | Origin on the equipment | Unit |
|---|---|---|
| `input_voltage_v` | `measurements.input_voltage_v` | V |
| `output_voltage_v` | `measurements.output_voltage_v` | V |
| `load_percent` | `measurements.load_percent` | % |
| `temperature_c` | `measurements.temperature_c` | °C |
| `frequency_hz` | `output_frequency_hz` (SMS) **or** `input_frequency_hz` (TS Shara) | Hz |
| `battery_charge_percent` | `battery.charge_percent` (SMS) **or** `battery_charge.percent` (TS Shara) | % |
| `battery_voltage_v` | `battery.voltage_v` (SMS) **or** `measurements.battery_voltage_v` (TS Shara) | V |

Keys **without a value** are **omitted** from the object (they do not arrive as `null`). E.g.: on `megatec-q1` there is no
`output_frequency_hz`, but `frequency_hz` is still present because the API uses `input_frequency_hz`. If a
metric does not exist for the model, the key simply does not appear — the viewer must treat absence as
"series unavailable" (do not plot the line), never as `0`.

> `normalized` does **not** replace `measurements`: it is a reduced and standardized mirror, designed for
> charts, summaries and comparison between protocols.

---

## 6. The four charts — source column

Each chart is an `offset_s` (X) against a key of `normalized` (Y):

| # | Chart | X axis | Y axis (`samples[].normalized`) | Summary (`deltas.metrics`) |
|---|---|---|---|---|
| 1 | **Output Voltage Fluctuation** | `offset_s` | `output_voltage_v` | `output_voltage_v.ripple`, `.max_abs_deviation` |
| 2 | **Output Frequency Fluctuation** | `offset_s` | `frequency_hz` | `frequency_hz.ripple`, `.max_abs_deviation` |
| 3 | **Internal Temperature Variation** | `offset_s` | `temperature_c` | `temperature_c.delta`, `.max`, `.min` |
| 4 | **Battery Charge Drop** | `offset_s` | `battery_charge_percent` | `battery_charge_percent.delta`, `.ripple` |

Extra: the **UPS load** (`load_percent`) helps explain "why the battery drops faster" (the
inverter starts feeding the load). It also arrives in `normalized.load_percent`.

Example of a ready series (the same test, simplified):

```json
"samples": [
  { "offset_s": 0.0,   "normalized": { "output_voltage_v": 217.7, "frequency_hz": 59.9, "temperature_c": 49.1, "battery_charge_percent": 100.0 } },
  { "offset_s": 2.0,   "normalized": { "output_voltage_v": 218.0, "frequency_hz": 59.9, "temperature_c": 49.4, "battery_charge_percent": 97.0 } },
  { "offset_s": 4.0,   "normalized": { "output_voltage_v": 217.4, "frequency_hz": 60.0, "temperature_c": 49.8, "battery_charge_percent": 94.5 } }
]
```

Plotting `x = sample.offset_s` and `y = sample.normalized.<key>` (ignoring samples without the key) already produces the
four charts.

---

## 7. `deltas` — summary per metric

Aggregates the sampled series. **The keys of `deltas.metrics` are the same as those of `normalized`** (plus
`battery_voltage_v` when available).

```json
"deltas": {
  "window_s": 325.217,
  "sample_count": 163,
  "metrics": {
    "<key>": {
      "start": 100.0, "end": 20.0, "min": 20.0, "max": 100.0,
      "delta": -80.0, "ripple": 80.0, "max_abs_deviation": 80.0, "count": 163
    }
  }
}
```

| Field | Definition | Practical reading |
|---|---|---|
| `start` / `end` | First and last value of the series | Trend (went up/down) |
| `min` / `max` | Extremes within the window | Operating range |
| `delta` | `end − start` | Negative `battery_charge_percent.delta` = charge drop |
| `ripple` | `max − min` | **Amplitude of the fluctuation** (voltage/frequency/temperature) |
| `max_abs_deviation` | Largest deviation relative to `start` | Peak distance from the initial value |
| `count` | Valid samples of the key | Reliability of the summary |

Interpretation:

- **Voltage / frequency:** `ripple` and `max_abs_deviation` answer "did it fluctuate a lot?". In `battery_charge_percent`,
  `ripple` is the charge drop within the window.
- **Temperature:** `delta > 0` = internal heating during the discharge.
- **UPS load:** `load_percent.delta > 0` = the load increased when switching to battery.

---

## 8. `estimate` — estimated runtime (1st order)

**Linear** regression (least squares) of the charge drop, **discarding the initial transient**:

```text
transient     = initial readings whose drop between consecutive readings is GREATER
                than the typical drop of the window (median of the drops)
rate          = -slope of the regression over the remaining readings   (pp/s)
runtime_min   = adjusted_charge_at_end_of_window / rate / 60
```

In the first instants of the test the charge drops much faster than in the rest of the window (ohmic /
electrolyte drop) and **that drop is not the real discharge rate**: extrapolating it produced runtimes of a few
minutes, alarming for the end user. The trimming is **adaptive** — it does not use a fixed percentage — so it
cuts nothing in a uniform discharge and follows the real size of the transient.

| Field | Content |
|---|---|
| `available` | `false` when there is no measurable drop in the useful segment (short window / noise / stable charge after the transient) |
| `reason` | Explanation when `available: false` |
| `method` | `"linear_regression_trimmed"` |
| `readings_total` / `readings_used` | Battery readings in the window and how many entered the fit |
| `transient_readings_dropped` | Initial readings discarded as transient |
| `drop_percent_in_window` | Charge drop observed in the **entire** window (includes the transient) |
| `drop_percent_used` | Charge drop in the segment used in the fit |
| `discharge_rate_pp_per_min` | Discharge rate of the segment used |
| `reference_charge_percent` | Charge at the end of the window, adjusted by the regression |
| `estimated_runtime_min` | Estimated runtime, limited to `capped_at_min` (**600 min**) |
| `capped_at_min` | Sanity ceiling (600 min) |
| `confidence` | **`"low"`** — 10 s is short and the real discharge is almost never linear |

> **Division of responsibility:** the API publishes **facts** (complete series, aggregations and the 1st-order
> extrapolation, already marked `confidence: "low"`). The **definitive model/policy** of predictability and the
> presentation belong to the Web Viewer. The API **does not** turn `available: false` into a number.

---

## 9. `finish_reason` and `status`

| `finish_reason` | Meaning | Expected? |
|---|---|---|
| `duration_elapsed` | The requested window ended normally | Yes (window test) |
| `target_percent_reached` | The charge reached the target (20 %) — **normal end** of `discharge_20pct` | Yes |
| `test_flag_cleared` | The UPS lowered the `TEST` flag before the end | Atypical |
| `aborted` | Cancellation requested by the client | Yes (if the user cancelled) |
| `battery_low` | `LB` flag appeared — safety guard that terminates **immediately** | Atypical (attention) |
| `watchdog` | Time ceiling reached (window or 30 min) | Atypical (attention) |
| `stopping` | The service was shut down during the window | Atypical |
| `serial_error` | Sending the test command failed (no samples) | Failure |

**`status`** (`running` → `completed` \| `aborted` \| `failed`): `failed` when no valid sample was
obtained or when the action command failed (`test.error` filled in).

---

## 10. Cancellation (`POST .../tests/{test_id}/abort` → `202`)

```json
{ "api_version": "v1", "contract_version": "3.0", "device_id": "sms-ups3200s-01",
  "test_id": "9f3c1a7b2d4e5061", "status": "aborting" }
```

- The `abort` only **marks** an event; the collector closes the window on the next cycle and records
  `finish_reason: "aborted"` / `status: "aborted"` — **preserving the samples already collected**.
- On `sms-1phase` the collector **also sends the cancellation** to the UPS (`abort_supported: true`). On
  `megatec-q1` there is no cancellation command: the "abort" only **stops sampling** (the UPS finishes
  the 10 s test on its own).
- Aborting a test that is **not** running → `409 test_not_running`; nonexistent `test_id` →
  `404 test_not_found`.

---

## 11. List / history (`GET .../tests?limit=N` → `200`)

Version **without** `samples[]`, for a trend chart **between** tests (the estimated runtime of today vs that of
yesterday):

```json
{ "api_version": "v1", "contract_version": "3.0", "device_id": "sms-ups3200s-01", "count": 2,
  "tests": [
    { "test_id": "9f3c1a7b2d4e5061", "type": "discharge_20pct", "status": "completed",
      "started_at_utc": "2026-10-22T15:04:16.901Z", "expected_end_at_utc": "2026-10-22T15:34:16.900Z",
      "ended_at_utc": "2026-10-22T15:09:42.118Z", "duration_s": 325.217,
      "target_percent": 20.0, "finish_reason": "target_percent_reached",
      "samples_count": 163, "flags_seen": ["BEEP","BYPASS","OB","TEST","UPSOK"],
      "estimate": { "available": true, "estimated_runtime_min": 6.8, "confidence": "low" },
      "error": null }
  ] }
```

The history is **in memory** (`test_history_size` = 20 per device, configurable) and is lost when the
service restarts. **Do not** use it as a long-term source.

---

## 12. Errors and HTTP codes

Standard error envelope: `{"error": {"code", "message"}}` (with `message` in Portuguese, ready to display).

| HTTP | `error.code` | When |
|---|---|---|
| `403` | `test_disabled` | `allow_battery_test` is not `true` on the device |
| `422` | `unsupported_test_type` | `type` outside those accepted **by this device** (e.g.: `discharge_20pct` on `megatec-q1`) |
| `422` | `test_not_supported` | the device protocol does not offer a test |
| `422` | `test_requires_battery_percent` | `discharge_20pct` on telemetry **without** a battery percentage (the target could not be evaluated) |
| `404` | `device_not_found` / `test_not_found` | Nonexistent equipment / test |
| `400` | `invalid_request` | Body is not a valid JSON object (or `type` is not a string) |
| `409` | `test_unavailable` | No fresh telemetry (`stale`/`starting`) or collection loop terminated |
| `409` | `test_in_progress` | A test is already in progress on this device |
| `409` | `on_battery` | The UPS is **already** on battery (`OB` flag) |
| `409` | `battery_low` | `LB` flag set |
| `409` | `battery_too_low` | Charge below `test_min_battery_percent` |
| `409` | `battery_at_target` | `discharge_20pct` with the charge **already** at the target (≤ 20 %) |
| `409` | `test_cooldown` | Still within `test_cooldown_s` of the last test |
| `409` | `test_not_running` | `abort` of a test that is not running |

---

## 13. Volumes and polling pace

| `type` | Typical samples | `sample_interval_s` | `expected_end_at_utc` |
|---|---|---|---|
| `duration_10s` | ~25 | 0.4 s | start + 10 s |
| `discharge_20pct` | up to ~900 | 2.0 s | start + 30 min (ceiling; usually ends earlier) |

- Poll `report_url` every `poll_interval_s` (**0.5 s**); do not request every 100 ms.
- The report payload **includes the entire series** on every query — for long tests, prefer updating the
  chart with the **new** samples (comparing `samples_count`) instead of redrawing everything.

---

## 14. End-to-end example (`discharge_20pct`)

```bash
B=http://127.0.0.1:8080
D=sms-ups3200s-01

# 1) discover capabilities and enable the button
curl -s "$B/api/v1/ups" | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['capabilities'] for x in d['devices'] if x['device_id']=='$D'])"

# 2) start the controlled discharge test
curl -s -X POST "$B/api/v1/ups/$D/tests" -H 'Content-Type: application/json' \
     -d '{"type":"discharge_20pct"}' | python3 -m json.tool

# 3) follow up (repeat until status != running)
curl -s "$B/api/v1/ups/$D/tests/<TEST_ID>" | python3 -c "
import sys,json
t=json.load(sys.stdin)['test']
print(t['status'], t['finish_reason'], 'samples:', t['samples_count'],
      'charge:', (t.get('final') or {}).get('battery_charge_percent'))"

# 4) cancel (if necessary)
curl -s -X POST "$B/api/v1/ups/$D/tests/<TEST_ID>/abort" | python3 -m json.tool
```

---

## 15. Quick glossary of JSON paths

| Chart/UI point | Path |
|---|---|
| X axis (time) | `test.samples[].offset_s` |
| Output voltage | `test.samples[].normalized.output_voltage_v` |
| Frequency | `test.samples[].normalized.frequency_hz` |
| Temperature | `test.samples[].normalized.temperature_c` |
| Battery charge | `test.samples[].normalized.battery_charge_percent` |
| UPS load | `test.samples[].normalized.load_percent` |
| Drop summary | `test.deltas.metrics.battery_charge_percent.delta` |
| Estimated runtime | `test.estimate.estimated_runtime_min` (only if `test.estimate.available`) |
| Final status | `test.status` + `test.finish_reason` |

The practical application of these fields in a viewer component is in
[battery-test-quadrant.md](battery-test-quadrant.md).
