# Tests and validation

## 1. How to run

```bash
npm test                # backend + frontend
npm run test:backend    # backend only (vitest)
npm run test:frontend   # frontend only (vitest)
```

No test needs hardware, a serial port or the real API: the backend is exercised against a fake HTTP
server and the frontend against pure functions and a simulated `fetch`.

## 2. Backend (`src/backend/tests`)

### 2.1 Support

| File | Role |
|---|---|
| [helpers/fakeUpstream.ts](../src/backend/tests/helpers/fakeUpstream.ts) | Fake HTTP server that responds to the telemetry API routes |
| [helpers/fixtures.ts](../src/backend/tests/helpers/fixtures.ts) | Multi-device contract 3.0 responses: success (`megatec-q1` and `sms-1phase`), `stale`, `data:null`, `404`, `405`, list with two devices (with `capabilities.battery_test` — the TS Shara with `duration_10s` only, the SMS with `duration_10s` and `discharge_20pct`), aggregated `/health` and the test cycle (acceptance `202` with and without `requested_duration_s`, `running`/`completed` report, discharge report with `target_percent_reached` and `samples[].normalized`, unavailable estimate, cancellation, history and the `test_cooldown`/`test_disabled` errors) |
| [helpers/viewer.ts](../src/backend/tests/helpers/viewer.ts) | Starts `createApp` on a free port and exposes `getJson` |

### 2.2 Coverage per file

| File | What it verifies |
|---|---|
| [config.test.ts](../src/backend/tests/config.test.ts) | Defaults; reading of all variables; invalid numeric; invalid URL; invalid log level; empty/absent `VIEWER_GAUGE_THRESHOLDS` |
| [contract.test.ts](../src/backend/tests/contract.test.ts) | Valid payload; **preservation of `null`**; unknown fields kept; `data: null`; absent envelope; absent `communication`; invalid type; identity; device list (two protocols) and `capabilities.battery_test` (TS Shara × SMS `test_types` and the `types.<type>` parameters, incl. `target_percent`/`timeout_s`); **aggregated** health; the SMS `battery` block and `status.raw_byte`; error envelope; **test 3.0 parsers** (acceptance ≠ result, discharge acceptance without a window, partial/complete report with `samples[].normalized`, discharge report with `target_percent_reached`, `estimate.available:false` preserving the `reason`, cancellation and history without `samples`) |
| [apiClient.test.ts](../src/backend/tests/apiClient.test.ts) | Successful `GET`; `404`; `405`; `503`; timeout; network unavailable; invalid JSON; **refusal of `PUT`/`PATCH`/`DELETE` without going out to the network**; **`POST` (test) sending the JSON body** |
| [gaugeConfig.test.ts](../src/backend/tests/gaugeConfig.test.ts) | Bands cover the scale without overlap; `sources` of the battery and the frequency (one path per protocol); valid override; invalid JSON; unknown metric; band outside the scale; out-of-order band; `readMetricValue` (number, `null`, absent) |
| [server.test.ts](../src/backend/tests/server.test.ts) | Happy path (telemetry forwarded **identical**, discovery via `/api/v1/ups`, fallback via `/health`, `device_id` pinned without querying the list); **`?device_id=` selection** (chooses the SMS, another protocol; unknown → `404 device_not_found`); degraded states (`stale` → 200, `data:null` → 200, API down → 502, discovery failure → `viewer.upstream.error` filled in, timeout → 502, invalid JSON → 502, divergent contract → 502, `device_not_found` → 404, no devices → 404); **battery test actions** (`POST` → 202, `409 test_cooldown`, partial/complete report, `abort` → 202, `404 test_not_found`, no devices → 404) and the method gate (**`POST` only on `/api/tests*`**, `upstream.requests` empty on the others); server (`/healthz` 200, `/api/config`, `405` on a write method, `404` on a nonexistent route, cache deduplication) |

## 3. Frontend (`src/frontend/tests`)

| File | What it verifies |
|---|---|
| [metrics.test.ts](../src/frontend/tests/metrics.test.ts) | `evaluateBand` (including the upper limit in the last band); `valueFraction`/`valueAngle`; `arcPath` (coordinates and radius); `buildGaugeRenderModel` — **missing/`null`/`NaN` value never becomes `0`**; "Stale" label when `stale`; pt-BR rounding; `readMetricPath` (distinguishes `null` from absent and does not convert a string into a number); `resolveGaugeSource` (preference, fallback, explicit `null`, absent, label per origin) |
| [status.test.ts](../src/frontend/tests/status.test.ts) | Active/inactive flags, severity of `LB`/`FAULT`, undocumented flags, **flags per protocol** (`megatec-q1` × `sms-1phase`), translation of the communication states (incl. `checksum_error`), state severity, and the **explicit distinction between "API unavailable" and "stale telemetry"** |
| [notices.test.ts](../src/frontend/tests/notices.test.ts) | pt-BR formatting (decimal comma, "—" for absent, age in s/min/h); notices: demo mode, API unavailable with a code, "no telemetry" vs "stale", band configuration, absence of notices in the normal case, and the **origin API error in the envelope (not labeled as a Web Viewer failure)** |
| [client.test.ts](../src/frontend/tests/client.test.ts) | `GET` on `/api/dashboard` and `/api/config`; **`?device_id=` when a UPS unit is chosen**; **useful body on HTTP 503**; network error without an exception; invalid JSON; envelope code on 502; cancellation via `AbortController`; `isViewerLevelFailure` (transport/JSON ≠ origin API envelope) |
| [batteryTest.test.ts](../src/frontend/tests/batteryTest.test.ts) | `readTestSupport` (declared capabilities, `test_types`/`types`, absence → not supported, cooldown/charge guards and the notice that the device does not cancel); `buildEstimateView` — **`available:false` never becomes a number** (only the `reason`) and the `capped_at_min` ceiling is presented as a floor ("≥ 10 h"); `buildObservationView` (confirmation of the `TEST` flag, notice when not observed and undefined state during the test); **test types** (selector restricted to `test_types`, labels and parameters of each type); **chart series** (`buildChartPoints`/`buildTestChartModels` — order of the four metrics, ripple per `deltas.metrics`, **missing key = series unavailable, never `0`**, target line only on the battery charge); **chart geometry** (path, Y-axis margin, `m:ss` above 60 s × `s.S` in the short test, position of the reference line, empty series → `null`); `buildTestProgress` (window × target — **the 30 min ceiling is not used as a duration** — and indeterminate bar); translations of status/reason/error and the test history (with the Type column) |

## 4. Scope §10 acceptance criteria — status

### Functional

| Criterion | Where it is met / verified |
|---|---|
| Identifies the device through the API | `ViewerService.resolveDeviceId` (list → `/health` → `UPS_DEVICE_ID`); `server.test.ts` |
| Indicators display the correct fields and units | `GET /api/config` defines `unit`/`decimals`; `metrics.test.ts` |
| Battery percentage marked as an estimate | `estimated: true` in the definition; "estimate" tag on the card; `gaugeConfig.test.ts` |
| Active states presented in an understandable way | `StatusFlags` + `status.test.ts` |
| Time/age of the last reading visible | Header and details area; `formatAge` in `notices.test.ts` |
| Missing/invalid data does not become zero | `buildGaugeRenderModel` and `readMetricPath`; `metrics.test.ts` |
| Distinguishes API unavailable from stale telemetry | Notices and indicator; `status.test.ts` and `notices.test.ts` |

### Visual and UX

| Criterion | Status |
|---|---|
| Dark four-quadrant stage (D16) | `--surface: #030408` on `html`/`body` and `.stage` in a 2×2 grid |
| Palette according to the rules | [design-system.md](./design-system.md) §1 |
| Gauges with red/amber/green semantics | Bands in `gaugeConfig.ts`, classes `gauge__band--*` |
| Colors are not the only means of communicating state | Every band has a textual label; every state has text + value |
| Values and units legible on desktop and mobile | Fluid grid; `formatNumber` with a separate unit |
| Layout without page scrolling on desktop | `.stage` with `100dvh` and `overflow: hidden`; breakpoint at 900 px and 420 px |
| Loading, error and data-absence states | `loading`, `Notices`, `gauge--empty`, `panel__empty` |

### Integration

| Criterion | Status |
|---|---|
| Read-only via GET; writes restricted to the test (3.0) | `GET` everywhere; `POST` only on `/api/tests*`, never autonomous; local refusal in `UpstreamApiClient` and `405` on the server; `apiClient.test.ts` and `server.test.ts` |
| Handling of HTTP 200, 404, 405 and 503 | `dashboard.ts` + `server.test.ts` |
| Handling of timeout, network and invalid JSON | `apiClient.ts` + `apiClient.test.ts` |
| Configurable API base address | `UPS_API_BASE_URL`; no IP in the code |
| Container ↔ host communication documented and tested | [docker-operation.md](./docker-operation.md) §3 |
| No dependency on USB access | There is no `node-serialport` nor reading of `/dev/*` in the project |

### Delivery

| Criterion | Status |
|---|---|
| Project starts via Docker according to the README | `Dockerfile` + `compose.yaml` + [docker-operation.md](./docker-operation.md) |
| `.env.example` file | Present, without secrets |
| Essential automated tests pass | `npm test` (backend + frontend) |
| Architecture, contract, decisions and operation documented | `docs/` |
| No credentials, tokens or secrets versioned | The origin API does not authenticate; no token is used |

## 5. Suggested manual validation (after starting the container)

1. **Normal case** — with the API responding: all gauges filled in, green "Connected" indicator,
   header with the last valid reading.
2. **Stale telemetry** — stop the collector without stopping the API: amber "Stale" indicator, notice
   with the reading age, gauges labeled "Stale".
3. **API unavailable** — stop the API: critical banner "Telemetry API unavailable" with the error code,
   gauges neutralized, query table marking the failure.
4. **No device** — point `UPS_API_BASE_URL` to a response without `devices`: banner "No usable
   telemetry" and `GET /api/dashboard` responding `404 no_devices_configured`.
5. **Read-only (outside the test)** — `curl -X POST http://localhost:8090/api/dashboard` must respond
   `405`; `curl -X POST "http://localhost:8090/api/tests?device_id=..."` is the only accepted write and
   must only be used with a device enabled.
6. **Battery test (manual triggering, never autonomous)** — with a device whose
   `capabilities.battery_test.enabled` is `true`: trigger the button, confirm the `202` in the
   acceptance and the progress of the 10 s window; on completion, check the charge drop, the estimated
   runtime (or the `reason`, when unavailable) and the observation of the `TEST` flag. With
   `enabled: false` (TS Shara in the current profile), the button appears disabled with the reason and
   no request is sent.
7. **Responsiveness** — 1440 px, 1024 px, 768 px and 390 px without horizontal scrolling; values and
   units legible in all of them.
8. **Basic accessibility** — keyboard navigation with visible focus; screen reader announcing the
   `aria-label` of each gauge.
