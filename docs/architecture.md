# Architecture

## 1. Overview

```
┌─────────────────────────┐        ┌──────────────────────────────────────┐
│ UPS units (N)           │        │ UPS telemetry service (`monitor/`)   │
│ ─ TS Shara (Megatec/Q1) │        │ protocol collectors →                │
│   USB CDC-ACM 0483:5740 │───────▶│ in-memory telemetry → unified        │
│ ─ SMS (sms-1phase)      │  USB   │ REST API (v1 / contract_version 3.0) │
│   USB-Serial 067b:23d3  │        │ 1 port / N devices                   │
└─────────────────────────┘        └───────────────┬──────────────────────┘
                                                   │ HTTP GET + POST (test)
                                                   ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │ Container "ups-monitor-viewer"                           │
                    │                                                          │
                    │  backend Node/Express (src/backend)                      │
                    │   ├─ config.ts     environment variables (no fixed IP)   │
                    │   ├─ apiClient.ts  HTTP client: GET + POST (tests only)  │
                    │   ├─ contract.ts   contract validation/normalization     │
                    │   ├─ gaugeConfig.ts metric and band definitions          │
                    │   ├─ dashboard.ts  service: discover, query, cache       │
                    │   └─ server.ts     /healthz /api/config /api/dashboard   │
                    │                    /api/devices /api/tests + interface   │
                    │                                                          │
                    │  frontend React/TS (compiled to /app/public)             │
                    └───────────────┬──────────────────────────────────────────┘
                                    │ HTTP (same origin)
                                    ▼
                            User's browser
```

## 2. Responsibility boundaries

| Component | Does | Does not do |
|---|---|---|
| UPS telemetry service | Reads USB, implements Q1, keeps telemetry and publishes the API | Does not know the Web Viewer |
| Web Viewer backend | Queries the API via GET, validates the contract, publishes a single payload, serves the interface | Does not open a serial port, does not send commands, does not store history |
| Frontend | Renders gauges, states and details; refreshes on a cycle | Does not know the API address, does not make direct requests to the telemetry API |

The Web Viewer is a **consumer** of the HTTP/JSON contract. It does not depend on the API being FastAPI
or on any implementation detail of the telemetry service.

## 3. Why there is a backend in the container

The scope (§7.1) asks for an explicit choice between the browser querying the API directly or having a
read proxy in the container. The **proxy** was chosen, for four reasons:

1. **CORS.** The origin API sends no CORS headers. With the proxy, the browser only talks to its own
   origin.
2. **Network exposure.** The API address never reaches the browser; only the backend knows it.
3. **Single validation point.** The contract is verified once, in the backend, and the interface
   receives an already-classified payload (available / degraded / failure).
4. **Interface served alongside.** The same origin serves the HTML/JS and the viewer API, which
   simplifies deployment and avoids another port.

The proxy does **not** collect, does **not** persist, and does **not** duplicate the logic of the
telemetry service — it only queries and forwards.

## 4. Backend modules

| File | Responsibility |
|---|---|
| [config.ts](../src/backend/src/config.ts) | Reads and validates the environment variables. Exits with code `2` on an invalid value. |
| [logger.ts](../src/backend/src/logger.ts) | Single-line logging, levels `debug`/`info`/`warn`/`error`. |
| [apiClient.ts](../src/backend/src/apiClient.ts) | `UpstreamApiClient`: GET and POST (the latter only on the test routes), timeout via `AbortController`, classified errors (`upstream_unreachable`, `upstream_timeout`, `upstream_invalid_json`, ...). Rejects any other method locally (`viewer_invalid_method`). Never throws to the caller. |
| [contract.ts](../src/backend/src/contract.ts) | `parseTelemetry`, `parseIdentity`, `parseDevices`, `parseHealth`, `parseErrorPayload` and the test parsers (`parseBatteryTestAccept`, `parseBatteryTestReport`, `parseBatteryTestAbort`, `parseTestsList`). Preserves `null`, does not rename fields, keeps extra fields and returns `problems` with divergences. Knows contract 3.0 (the SMS `battery` block, `status.raw_byte`, aggregated `/health`, `capabilities.battery_test` with `test_types`/`types`, `samples[].normalized`, `target_percent`/`timeout_s` and the predictability report). |
| [gaugeConfig.ts](../src/backend/src/gaugeConfig.ts) | `GAUGE_DEFINITIONS` (metrics, scales and **validated bands**), `applyGaugeOverrides` (JSON via env) and `readMetricValue`. Each metric declares `sources[]` (one path per protocol, in order of preference). |
| [dashboard.ts](../src/backend/src/dashboard.ts) | `ViewerService`: `resolveDeviceId` chooses the UPS unit (requested → config → first valid → first in the list → `/health`), queries `/health`, `/api/v1/ups`, `/telemetry`, `/identity` and the `/tests` history, assembles `viewer` (source of each query), caches by TTL and responds 200/404/502 as appropriate. It also forwards the test actions (`startBatteryTest`, `getBatteryTestReport`, `abortBatteryTest`) preserving the HTTP status and the `error.code` of the API. |
| [server.ts](../src/backend/src/server.ts) | `createApp`: viewer routes, blocking of methods ≠ GET (except `POST /api/tests*`), static files and SPA fallback, error handler. |
| [index.ts](../src/backend/src/index.ts) | `start`/`main`, startup logs and shutdown on SIGINT/SIGTERM. |

### Flow of `GET /api/dashboard`

1. `GET /health` (short cache) — aggregated health of all collectors.
2. Resolve the `device_id` (see `resolveDeviceId`): the interface's `?device_id=` → `UPS_DEVICE_ID` →
   `GET /api/v1/ups` (the first with `telemetry_valid:true`, otherwise the first item) → the first key
   of `health.devices`. A `?device_id=` that is not in the list → `404 device_not_found`; with no
   identifier at all, it responds `404 no_devices_configured` (or `502 upstream_unreachable`).
3. `GET .../{device_id}/telemetry` and `GET .../{device_id}/identity`.
4. Validate each response; if the body is an error envelope (`error.code`), separate that from the
   "contract divergence" case.
5. Assemble `viewer.sources` with the result of each query (URL, HTTP status, duration, error,
   warnings).
6. Respond:
   - `200` with `telemetry` — includes the case where the API responded `503` but published a valid
     payload with `telemetry_valid:false`/`stale:true`; the real state is made explicit in the fields;
   - `404` `device_not_found` when the API responded with that code;
   - `502` for transport failures and contract divergences;
   - `500` `viewer_internal_error` for unexpected failures of the viewer itself.

### Cache

`fetch()` in [dashboard.ts](../src/backend/src/dashboard.ts) keeps an in-memory cache per path, with a
configurable TTL, and deduplicates simultaneous requests to the same path. **Failures are not
cached**: the interface returns to normal as soon as the API responds.

### Battery test flow (contract 3.0)

The test is the **only** write in the project and goes entirely through the viewer backend — the
browser never talks to the origin API.

1. The interface reads `capabilities.battery_test` of the device in `GET /api/v1/ups` (received in the
   `devices` block of the dashboard) and **only enables** the button when `enabled` is `true`.
2. On click, the interface calls `POST /api/tests?device_id=...` with the chosen `type`; the viewer
   forwards the `POST` to the API and returns the acceptance (`202`, `test_id`, `type`,
   `poll_interval_s`, `report_url`). The test is **never** triggered autonomously.
3. The interface polls `GET /api/tests/{test_id}` every `poll_interval_s` until the status is no
   longer `running`.
4. On completion, the panel presents the report facts — series, `deltas`, `estimate` and
   `test_flag_observed` — and the history (`GET /api/v1/ups/{id}/tests`, in the `tests` block of the
   dashboard). The estimated runtime is only **presented** — when `estimate.available` is `false`, the
   `reason` is shown, never a number.
5. `POST /api/tests/{test_id}/abort` is only offered with `abort_supported`; otherwise the interface
   warns that the cancellation only stops the sampling.

**Two test types.** The panel selector is built **only** from the types declared in the device's
`test_types`: `duration_10s` (fixed window of ~10 s, offered to everyone that has a test) and
`discharge_20pct` (discharge until the charge drops to the **20 % target**, with a safety ceiling of
30 min — whichever comes first; currently only on `sms-1phase`, which knows how to cancel). For
`discharge_20pct`, the parameter is intentionally sent "without a window"; `duration_s` comes back
`null` and `timeout_s` (1800 s) is a **ceiling**, not the expected duration — progress is measured by
the drop in charge, not by the clock.

## 5. Frontend modules

| File | Responsibility |
|---|---|
| [api/client.ts](../src/frontend/src/api/client.ts) | `fetchConfig`, `fetchDashboard(deviceId?)`, `startBatteryTest`/`fetchBatteryTestReport`/`abortBatteryTest` on its own origin (sends `?device_id=` when a UPS unit is chosen); treats 503 as a useful body and never throws. |
| [App.tsx](../src/frontend/src/App.tsx) | Composition of the four-quadrant stage (context, measurements, battery test, details), notices, the "Collected UPS units" list with clickable selection (`?device_id=`) and resolution of each gauge's origin. |
| [hooks/useViewerData.ts](../src/frontend/src/hooks/useViewerData.ts) | Reads `/api/config` once and refreshes `/api/dashboard?device_id=` on a cycle, without overlapping requests. |
| [hooks/useBatteryTest.ts](../src/frontend/src/hooks/useBatteryTest.ts) | Test state: dispatches the request (by user action), polls the report and observes an already-running test reported by the history. |
| [model/contract.ts](../src/frontend/src/model/contract.ts) | Types of the viewer payload + types of the API contract (3.0: `battery`, `raw_byte`, aggregated `health`, `capabilities.battery_test`, the test report/estimate, `GaugeDefinition.sources`). |
| [model/batteryTest.ts](../src/frontend/src/model/batteryTest.ts) | Pure test functions: capabilities, guards, offered types (`buildTestTypeOptions`, restricted to `test_types`), `buildEstimateView` (never converts `available:false` into a number), chart series (`buildChartPoints`, `buildTestChartModels` — missing key = series unavailable), SVG chart geometry (`buildLineChart`, `formatOffsetSeconds`), observation of the `TEST` flag, progress (window × target) and history. |
| [model/format.ts](../src/frontend/src/model/format.ts) | pt-BR formatting. Missing → "—", never `0`. |
| [model/metrics.ts](../src/frontend/src/model/metrics.ts) | Semicircle geometry, band evaluation, `readMetricPath`, `resolveGaugeSource` (chooses the origin present in the payload) and `buildGaugeRenderModel`. |
| [model/status.ts](../src/frontend/src/model/status.ts) | Flags per protocol (`megatec-q1` × `sms-1phase`), severity, communication states and textual translation. |
| [components/Gauge.tsx](../src/frontend/src/components/Gauge.tsx) | Semicircular gauge in SVG (track, bands, tick marks, needle, central value). |
| [components/GaugeCard.tsx](../src/frontend/src/components/GaugeCard.tsx) | Metric card + secondary value (battery voltage). |
| [components/Header.tsx](../src/frontend/src/components/Header.tsx) | Identification, last valid reading, consumed contract and the list of collected UPS units (received as children). |
| [components/StatusFlags.tsx](../src/frontend/src/components/StatusFlags.tsx) | Operational states: active ones highlighted and the rest at reduced opacity (all always visible). |
| [components/BatteryTest.tsx](../src/frontend/src/components/BatteryTest.tsx) | Blocks A/C of the test panel: type selector, start/abort button, guards, progress (window × target), estimated runtime, observation of the `TEST` flag and history. |
| [components/BatteryTestCharts.tsx](../src/frontend/src/components/BatteryTestCharts.tsx) | Block B of the panel: sidebar with the four selectable blocks (output voltage, frequency, internal temperature, battery charge) and the SVG chart of the chosen series, drawn from `samples[].normalized`. |
| [components/Details.tsx](../src/frontend/src/components/Details.tsx) | Identity, battery voltage, collection state, age, last error and the result of each query. |
| [components/Notices.tsx](../src/frontend/src/components/Notices.tsx) | `buildNotices`: demo mode, API unavailable, telemetry missing/stale, band configuration. |
| [styles/global.css](../src/frontend/src/styles/global.css) | Dark four-quadrant stage, responsiveness and SVG classes. |

## 6. States represented in the interface

| Situation | Origin | Presentation |
|---|---|---|
| All normal | `telemetry_valid:true`, `stale:false`, `state:"ok"` | Green "Connected" indicator; gauges colored by band |
| Stale telemetry | `stale:true` | Amber "Stale" indicator, notice with the age, gauges labeled "Stale" |
| Active collection without a sample | `data_available:false` | Amber "No data" indicator |
| Sensor/value missing | `null`/absent field | Gauge neutralized with "No data" (never `0`) |
| Collector failure | `communication.state` ≠ `ok` | Red indicator with the translated state label |
| Telemetry API down | `viewer.upstream.error` | Critical banner "Telemetry API unavailable" with the error code |
| No device | `device_id: null` | Banner "No usable telemetry"; `GET /api/dashboard` responds 404 |
| Viewer service down | `fetch` failure in the browser | Critical banner "Web Viewer service unreachable" |
| Multiple UPS units | `GET /api/v1/ups` with `count > 1` | "Collected UPS units" list: the active one highlighted ("displaying"), the others clickable ("available"); one at a time via `?device_id=` |
| Battery test available | `capabilities.battery_test.enabled: true` | Button "Test battery (10 s)" enabled, with the guards (cooldown, minimum charge); with more than one type in `test_types`, the selector "Quick test (~10 s)" / "Controlled discharge (up to 20 %)" |
| Test unavailable | `enabled: false` / `supported: false` | Button disabled with the reason; no request is sent |
| Test in progress | `status: "running"` | Progress bar (time in the window test; charge drop, or indeterminate, in the target test), partial series in the charts and "Checking whether the device reported the test state…" |
| Test without the `TEST` flag | `test_flag_observed: false` | Amber notice in the observation — the device did not confirm the test state within the window |
| Test completed | `status: "completed"` | Timeline charts (one block per metric), test outcome, charge drop, ripple per metric and estimated runtime (or the `reason`, when unavailable) |
| Metric not published | missing key in `samples[].normalized` | The metric block shows "series unavailable" and the chart explains; it **never** draws zero |
| Test cancelled/failed | `finish_reason` ≠ `duration_elapsed` / `target_percent_reached` | Translated reason; the report is not presented as a normal test |

## 7. Recorded architectural decisions

See [technical-decisions.md](./technical-decisions.md). Summary: React + TypeScript + Vite; gauges in
custom SVG (no chart library); backend proxy in the container; npm workspaces; multi-stage Docker with
the backend serving the static interface.
