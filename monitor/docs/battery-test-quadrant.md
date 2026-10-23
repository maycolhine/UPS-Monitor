# Battery Test — Application in the Web Viewer Quadrant

**Transfer** document from the *UPS Monitoring* project to the sibling project **UPS Monitor — Web
Viewer**. It states, in a practical way, **how to use the battery test data inside the "Battery Test
quadrant"**: layout, state machine, wiring of the four charts, live update and edge cases.

- **Prerequisite:** read [battery-test-api-contract.md](battery-test-api-contract.md) — it is there that the layout
  of `samples[]`, `normalized`, `deltas` and `estimate` is defined. Here we only deal with **how to apply** them.
- **UI context:** the viewer is organized into **quadrants** (a project preference). This document covers
  **one** quadrant: the **Battery Test** one.
- **Scope:** the quadrant **only** appears/is enabled where `capabilities.battery_test.enabled = true`.

---

## 1. The quadrant on one page

The Battery Test quadrant has three blocks:

```text
┌──────────────────────────────── Battery Test ─────────────────────────────────┐
│ [ test type ]   [ Start test ]   [ Cancel ]      (state: idle/…)               │  <- BLOCK A: control
├───────────────────────────────────────────────────────────────────────────────┤
│  Output voltage (V)  │  Frequency (Hz)  │  Temperature (°C)  │  Battery (%)   │  <- BLOCK B: 4 charts
│  ~~~~~~~~~~ offset_s~~ │  ~~~~~~~~~~      │  ~~~~~~~~~~        │  ~~~~~~~~      │     (timeline)
├───────────────────────────────────────────────────────────────────────────────┤
│  Drop: −80.0 pp  ·  V ripple: 3.7 V  ·  Freq: 0.5 Hz  ·  Runtime: ~6.8 min    │  <- BLOCK C: summary
│  Reason: target_percent_reached · TEST observed: yes                          │     (deltas/estimate)
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Block A (control):** type selection, start button, cancel button and the current state.
- **Block B (charts):** the **four charts**, drawn from `samples[]` `offset_s` × `normalized`.
- **Block C (summary):** the numbers from `deltas` and `estimate` and the `finish_reason`.

Central rule: **Block B is always driven by `samples[]`** (the timeline). It works both during the
test (partial series) and after it (complete series) — it is the same component, changing only the data that arrives.

---

## 2. Connection with the API (who calls what)

| Quadrant action | Endpoint | Note |
|---|---|---|
| Discover whether to show/enable the block | `GET /api/v1/ups` → `capabilities.battery_test` | If `enabled: false`, hide the button |
| Start test | `POST /api/v1/ups/{device_id}/tests` `{"type": "<type>"}` | Responds `202` with `report_url` |
| Follow + draw live | `GET <report_url>` every `poll_interval_s` (0.5 s) | While `status = "running"` |
| Final report | the same `GET` when `status != "running"` | Brings `deltas`/`estimate` filled in |
| Cancel | `POST <report_url>/abort` | Only with `abort_supported: true` |
| History/trend (optional) | `GET /api/v1/ups/{device_id}/tests?limit=N` | Without `samples[]` |

Quadrant flow:

```text
idle ──[Start]──> posting ──202──> polling(0.5s) ──running──> polling
   ^                                                           │
   │                                                           ├─ completed/aborted/failed ──> done
   └───────────────────────[Cancel]── abort ───────────────────┘
```

---

## 3. Block A — control and type selection

### 3.1 Type selection

Offer only the types in `capabilities.battery_test.test_types`:

| `type` | Suggested label | When to offer |
|---|---|---|
| `duration_10s` | "Quick test (~10 s)" | whenever it is in the list |
| `discharge_20pct` | "Controlled discharge (down to 20 %)" | **only** if it is in the list (`abort_supported: true`) |

The `megatec-q1` (TS Shara) only lists `duration_10s` → for it, the selector has a single option (or becomes fixed
text). **Do not** send `discharge_20pct` to a device that does not support it: it responds `422`.

### 3.2 "Start test" button

- **Enable** it only with `enabled: true` **and** with the device having fresh telemetry (the `POST` may respond
  `409 test_unavailable`).
- Show **before the click** the limits that generate a `409`, when known:
  - `cooldown_s` (wait between tests),
  - `min_battery_percent` (minimum charge to test).
- During `posting`/`polling`, disable the button (prevents `409 test_in_progress`).

### 3.3 "Cancel" button

- **Visible only** during execution **and** with `abort_supported: true`.
- On `megatec-q1` (`abort_supported: false`) the button **does not** exist — the 10 s test ends on its own.
- On cancel, the `POST .../abort` returns `202 {"status":"aborting"}`; keep polling until
  `status: "aborted"` — **the samples already collected are preserved** and the charts remain valid.

### 3.4 State text per phase

| Phase | Suggested text | Progress bar |
|---|---|---|
| `idle` | "Ready to test" | — |
| `posting` | "Requesting test…" | indeterminate |
| `polling` (window) | "Testing… ~N s left" | `1 − (now − started_at) / requested_duration_s` |
| `polling` (target) | "Discharging down to 20 % (current: X %)" | `(start − current) / (start − 20)` **or** indeterminate |
| `done` (completed) | "Test completed" | full |
| `done` (aborted) | "Test cancelled" | full |
| `done` (failed) | "Test failed" + `error.message` | full |

> For the **target** test (`discharge_20pct`) the `expected_end_at_utc` is a **30 min ceiling**, not the predicted
> duration. **Do not** use the 30 min as the "expected duration" in the progress bar — prefer the charge
> progress (from 100 % down to 20 %) or an indeterminate bar. The real end is usually much earlier.

---

## 4. Block B — the four charts

Each chart is **`samples[].offset_s` (X)** against **a key of `samples[].normalized` (Y)**:

| Chart | Y axis | Reference line (optional) |
|---|---|---|
| **Output Voltage Fluctuation** | `normalized.output_voltage_v` | nominal voltage (`identity.nominal.voltage_v`) |
| **Output Frequency Fluctuation** | `normalized.frequency_hz` | nominal frequency (`identity.nominal.frequency_hz`) |
| **Internal Temperature Variation** | `normalized.temperature_c` | "critical" band already used in the gauges (e.g.: 35 °C) |
| **Battery Charge Drop** | `normalized.battery_charge_percent` | line at the target (20 %) on `discharge_20pct` |

### 4.1 How to build the series

```ts
// pseudo-code of the chart mapper
type Sample = {
  offset_s: number;
  normalized?: Record<string, number>;
};

function series(samples: Sample[], key: string) {
  return samples
    .filter(s => s.normalized?.[key] !== undefined)   // ignores missing, does NOT turn into 0
    .map(s => ({ x: s.offset_s, y: s.normalized![key] }));
}

const chartVoltage = series(test.samples, "output_voltage_v");
const chartFreq    = series(test.samples, "frequency_hz");
const chartTemp    = series(test.samples, "temperature_c");
const chartBattery = series(test.samples, "battery_charge_percent");
```

Rules:

1. **Use `normalized`**, not `measurements` (the `measurements` varies per protocol; see the contract
   document §5).
2. **Missing key ≠ zero.** If `normalized.frequency_hz` does not exist (a model that does not report it), show the
   chart as "unavailable for this equipment" instead of drawing a straight line at 0.
3. In partial samples (during the test), the series grows — **redraw** or *append* the new point.
4. `offset_s` starts at ~0 and goes up to `duration_s`; the real window may be slightly larger than the requested one.

### 4.2 Live × final

| Moment | What arrives in `samples[]` | What to do in Block B |
|---|---|---|
| `running` | **Partial** series (grows every 0.5 s) | Draw the curve in real time; no summary line |
| `completed` / `aborted` | **Complete** series | Redraw with the final series; enable Block C |
| `failed` | May have 0 samples | Show a failure notice (Block A) and empty charts |

> The report payload **re-includes the entire series** on every polling. For long tests
> (`discharge_20pct`, up to ~900 samples), prefer **appending** only the new samples (comparing
> `samples_count`) to avoid redrawing hundreds of points every 0.5 s.

### 4.3 Axes and scales

- **X (offset_s):** in seconds. Format as `m:ss` when `duration_s ≥ 60` (the `discharge_20pct` lasts
  minutes), or `s.S` in the 10 s test.
- **Y:** unit in the title (V, Hz, °C, %). Leave the scale **automatic with headroom** — the voltage
  and frequency fluctuations are small (e.g.: ±2 V, ±0.5 Hz) and a fixed 0–250 V scale would hide them.
- **Battery (%):** for the `discharge_20pct`, fix the axis from **0 to 100** (or 20–100) to give a sense of the
  discharge; mark the 20 % target with a dashed line.

---

## 5. Block C — summary (what to show with `deltas` and `estimate`)

| User question | Field | Formatting |
|---|---|---|
| How much did the battery drop? | `deltas.metrics.battery_charge_percent.delta` | `−80.0 pp` (show the sign) |
| Did the voltage fluctuate a lot? | `deltas.metrics.output_voltage_v.ripple` / `.max_abs_deviation` | `3.7 V` / `2.3 V` |
| And the frequency? | `deltas.metrics.frequency_hz.ripple` | `0.5 Hz` |
| Did it heat up? | `deltas.metrics.temperature_c.delta` | `+3.2 °C` |
| Did the UPS load increase? | `deltas.metrics.load_percent.delta` | `+8.0 %` |
| How much battery time would I have in a real outage? | `estimate.estimated_runtime_min` | see the rules below |
| Did the test actually happen? | `test_flag_observed` + `"TEST"` in `flags_seen` | badge "TEST observed: yes/no" |
| How did it end? | `status` + `finish_reason` | see §6 |

Golden presentation rules:

1. **Never invent a number.** If `estimate.available = false`, show the `reason`
   ("charge drop below the measurable resolution"), **not** a runtime. Label the runtime as an
   **"estimate"** with `confidence: "low"`.
2. **`estimated_runtime_min` is a sanity ceiling.** The API limits it to `capped_at_min` (600 min). If it comes out equal to
   `capped_at_min`, present "≥ 10 h (extrapolation)" instead of false precision.
3. **Battery is per protocol.** On the SMS the percentage is **reported by the equipment**; on the TS Shara it is
   **estimated** from the voltage. The `normalized`/`deltas` already unify the **value**, but the **origin label**
   remains different (see `web-viewer-integration.md §6.2`).
4. **`normalized` is the only common field** between the two protocols for the charts — `measurements` is
   specific to each model.

---

## 6. How to react to each `status` / `finish_reason`

| `status` | `finish_reason` | Presentation in the quadrant |
|---|---|---|
| `completed` | `duration_elapsed` | **Normal case** of the 10 s test. Complete charts + summary |
| `completed` | `target_percent_reached` | **Normal case** of `discharge_20pct`. Highlight "reached 20 %" |
| `completed` | `test_flag_cleared` | Valid report; signal that the UPS ended the test before the expected time |
| `aborted` | `aborted` | "Cancelled by the user"; charts preserved; **without** a highlighted runtime |
| `completed` | `battery_low` | **Attention:** the battery reached a low level (safety guard). Show an alert |
| `completed` | `watchdog` | Time ceiling reached (12 s or 30 min). Inform that the test was interrupted by the limit |
| `failed` | `serial_error` | Communication error; show `test.error.message` |
| `failed` | *(with `error: no_samples`)* | "No valid samples" — empty charts |

> `finish_reason ≠ duration_elapsed` (in the window test) means an **atypical** window: always display the
> reason; do not treat it as a normal report nor hide the number.

---

## 7. Edge cases

| Situation | Correct UI behavior |
|---|---|
| `capabilities.battery_test.enabled = false` | Hide the button (or show it disabled with an explanation). **Do not** attempt the `POST` |
| `type` unsupported on the device | Do not offer the option; if the `POST` occurs → `422 unsupported_test_type` |
| Charge already ≤ 20 % (target) | `POST` → `409 battery_at_target`; explain before the click |
| No fresh telemetry | `POST` → `409 test_unavailable`; indicate checking the communication |
| Test in progress | `409 test_in_progress`; disable the button during `polling` |
| Empty `samples[]` and `status: running` | The test was queued but has not started yet. Show "waiting to start" |
| `normalized` key missing in a metric | Series "unavailable" in that chart (do not plot `0`) |
| `estimate.available = false` | Show `reason`; **do not** display a runtime |
| History disappears on restart | The history is in memory; treat `test_not_found` as "report expired" |

---

## 8. Implementation checklist

| # | Action | Where (suggestion) | Mandatory? |
|---|---|---|---|
| 1 | Read `capabilities.battery_test` and enable the quadrant only with `enabled: true` | `contract.ts` / `apiClient.ts` | **Yes** |
| 2 | Type selector restricted to `test_types` | quadrant component | **Yes** |
| 3 | `POST .../tests` with the chosen `type` and handle `202`/errors | `apiClient.ts` | **Yes** |
| 4 | Polling of `report_url` every `poll_interval_s`, stopping at `completed/aborted/failed` | same as above | **Yes** |
| 5 | Four charts from `samples[].normalized` (see §4) | `BatteryTestCharts.tsx` | **Yes** |
| 6 | Summary block from `deltas`/`estimate` (see §5) | `BatteryTestSummary.tsx` | **Yes** |
| 7 | **Cancel** button only with `abort_supported: true` | same as above | Recommended |
| 8 | Pre-click notice of `cooldown_s` / `min_battery_percent` | same as above | Recommended |
| 9 | Incremental update (append by `samples_count`) in long tests | `BatteryTestCharts.tsx` | Recommended |
| 10 | History/trend via `GET .../tests` | same as above | Optional |

> A new *endpoint* is **not** required in the Web Viewer backend: the quadrant talks directly to the `upsmon` API
> using the same `UPS_API_BASE_URL`. If the viewer prefers to centralize the traffic in its own backend
> (CORS/proxy), expose a thin forwarding route — the contract above does not change.

---

## 9. Quick glossary (paths for the quadrant)

| Quadrant element | JSON path |
|---|---|
| Button enabled? | `capabilities.battery_test.enabled` |
| Offered types | `capabilities.battery_test.test_types` |
| Cancel available? | `capabilities.battery_test.abort_supported` |
| Test state | `test.status` |
| End reason | `test.finish_reason` |
| X axis of the charts | `test.samples[].offset_s` |
| Y — output voltage | `test.samples[].normalized.output_voltage_v` |
| Y — frequency | `test.samples[].normalized.frequency_hz` |
| Y — temperature | `test.samples[].normalized.temperature_c` |
| Y — battery charge | `test.samples[].normalized.battery_charge_percent` |
| Summary — drop | `test.deltas.metrics.battery_charge_percent.delta` |
| Summary — voltage ripple | `test.deltas.metrics.output_voltage_v.ripple` |
| Summary — runtime | `test.estimate` (`available`, `estimated_runtime_min`, `confidence`) |
| Test target | `test.target_percent` |
