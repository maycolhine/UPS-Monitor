# Technical decisions

Format: **Approved decision** (confirmed by the requester), **Technical decision** (made by
development, with justification), **Open item** (awaiting validation).

---

## Approved by the requester

### D1 — Backend/read proxy in the container ✅

**Context.** Scope §7.1 asks for an explicit choice between the browser querying the API directly or
having an intermediate backend. The origin API does not send CORS headers.

**Decision.** The container has a Node/Express backend that queries the API and publishes the data to
the interface **on the same origin**. The browser never talks to the telemetry API.

**Consequences.** No CORS; the API address is not exposed to the browser; contract validation sits in
a single point; the compiled interface is served by the backend itself. The proxy does **not** collect,
does **not** persist and does **not** duplicate the logic of the telemetry service.

### D2 — Frontend stack: React + TypeScript + Vite ✅

**Decision.** React 18 + TypeScript, built with Vite.

**Justification.** Reusable components (a scope §7 requirement), typing of the JSON contract, fast
builds and a static output that can be served by the backend without an additional server.

### D3 — Gauge bands: validated and configurable ✅

**Decision.** The red/amber/green limits live in a single module
([gaugeConfig.ts](../src/backend/src/gaugeConfig.ts)), are published in `GET /api/config` and can be
overridden by `VIEWER_GAUGE_THRESHOLDS` (JSON).

**Justification.** The scope forbids treating invented limits as an official recommendation (§4.2,
§6.1). The default values are the ones **validated by the requester on 2026-10-21** (voltage 80–127 /
200–225 V; frequency 47–53 / 57–60 Hz; temperature 0–25 / 25–35 °C; battery 0–20 / 20–40 %; load
0–50 / 50–75 %). The interface only shows a configuration notice when `threshold_problems` is not
empty.

**Note.** The limits remain configurable because another model/brand may require different windows;
the current validation refers to the known fleet.

**Limit convention (2026-10-22).** A value exactly equal to a limit belongs to the band that **ends**
at it (`evaluateBand` in [metrics.ts](../src/frontend/src/model/metrics.ts)), which is how the bands
are described to the user ("green between 57 and 60"). Thus the nominal value of **60.0 Hz** is
classified as **"Normal frequency (60 Hz)"**, and not as attention — and the same holds for 127.0 V
and 220 V. On the scale, the tick marks mark the start and end of each band, not fixed ticks.

### D4 — Product name ✅

**Decision.** Generic name **"UPS Monitor"** (`UPS Monitor — Web Viewer` in the header). It does not
fix a brand/model, consistent with the goal of serving other brands in the future.

### D5 — Docker installation ✅

**Decision.** Official Docker CE (repository `download.docker.com`), with the user in the `docker`
group. The commands with `sudo` were executed by the requester (`sudo` is blocked in the assistant's
environment).

---

## Made during development

### D6 — Gauges in custom SVG, without a chart library

**Context.** Scope §7 allows chart libraries, provided they allow customizing scales, segments, labels
and states.

**Decision.** Implement the semicircle in pure SVG
([Gauge.tsx](../src/frontend/src/components/Gauge.tsx) + [metrics.ts](../src/frontend/src/model/metrics.ts)).

**Justification.** A semicircular gauge with bands, tick marks and a needle is simple geometry; with
custom SVG there is no additional dependency, the bundle stays small, the accessibility semantics are
explicit (`role`/`aria-label`) and the states are testable as pure functions — the scope asks for lean
and justified dependencies.

### D7 — npm workspaces, without a monorepo tool

**Decision.** `src/backend` and `src/frontend` are npm workspaces of the root `package.json`.

**Justification.** A single `npm install` and aggregate scripts (`npm test`, `npm run build`) without
adding Turborepo/Nx/Pnpm — the project's scale does not justify more tooling.

### D8 — `contract_version` as a contract, not as a technology

**Decision.** The backend validates `api_version`/`contract_version`, but does not depend on the API's
framework. `UpstreamApiClient` uses only `fetch`.

**Justification.** Scope §3.4 forbids assuming the API is FastAPI and requires depending on the
HTTP/JSON contract.

### D9 — Preserve `null` and do not rename fields

**Decision.** In [contract.ts](../src/backend/src/contract.ts), `null` is preserved as `null`, absent
fields remain absent, extra fields (from other brands) are kept, and the frontend reads the values
through `sources[]` — the exact contract paths, in order of preference.

**Justification.** The scope's fundamental rule: never convert `null` into `0` nor adapt the contract
silently.

### D10 — API 503 is not a total failure in the viewer

**Decision.** When the API responds `503` but publishes a telemetry payload with `telemetry_valid` /
`stale`, the Web Viewer forwards that payload with **HTTP 200** and leaves the state explicit in the
fields. Only transport failures and contract divergences become `502`.

**Justification.** Scope §3.3 requires that `503` is not treated as a rendering failure nor that old
numbers appear as current. Since the payload carries `stale` and `age_seconds`, the interface can show
an honest degraded state instead of an error screen.

### D11 — Short in-memory cache, without persistence

**Decision.** Cache per path with a TTL (`UPS_API_CACHE_TTL_MS`, default 1.5 s) and deduplication of
simultaneous requests; identity with a longer TTL (`UPS_API_IDENTITY_TTL_MS`, 60 s). **Failures are
not cached.**

**Justification.** Avoids repeating queries when the interface refreshes every 5 s, without
introducing a database (forbidden in scope §2.3) and without delaying recovery after a failure.

### D12 — Container healthcheck independent of the API

**Decision.** `GET /healthz` answers for the health of the **container itself** and does not query the
telemetry API. The Docker `HEALTHCHECK` uses this endpoint.

**Justification.** A powered-off UPS unit is no reason for Docker to restart the web application.

### D13 — Demonstration mode off by default

**Decision.** Simulated data exist in
[demo/fixture.ts](../src/frontend/src/demo/fixture.ts) and are used only when `VITE_ENABLE_DEMO=true`,
defined **only** in `.env.development`. The interface shows a "DEMO MODE" banner and the fixture is
explicitly labeled as simulated.

**Justification.** The scope asks for a prototype with identified simulated data (Phase B) and forbids
presenting it as real telemetry. In production the variable does not exist — the production
`vite build` does not define it.

### D14 — GET only, with local refusal

**Decision.** `UpstreamApiClient` refuses methods other than GET **before** going out to the network
(`viewer_invalid_method`), and the viewer server responds `405` to any method ≠ GET on `/api/*` and
`/healthz`.

**Justification.** Guarantees, by construction, that no write command reaches the API or the UPS unit
(acceptance criterion "exclusive consumption of GET endpoints").

### D15 — Folder structure

**Decision.** The scope §8 tree was kept, with two recorded adjustments:

1. `SCOPE.md` was not duplicated: the official scope is referenced by `README.md`.
2. The tests live in `src/backend/tests` and `src/frontend/tests` (next to each workspace), instead of
   a root `tests/` folder, so that each workspace is self-contained in Docker and in `vitest`.

### D16 — Visual language: dark four-quadrant panel

**Context.** Scope §4.1 and rule 30-ui-ux defined a white overall background (`#FFFFFF`). The requester
provided an internal control-tower logistics dashboard used as a visual reference for the desired final
style and explicitly asked for a **no-scroll** panel divided into four quadrants.

**Decision.** Adopt the visual language of the reference dashboard: a high-contrast dark stage, the
**Barlow** typeface and a 2×2 grid (`header` at the top left, gauges 2×3 at the top right, state/detail
panels in the lower quadrants). The gauge color bands and the notices now use tones suited to the dark
background (`#EF4444`/`#F59E0B`/`#10B981`).

**Justification.** The requester's preference prevails over the original aesthetic guideline. The
**content** rules of 30-ui-ux were kept in full: color is never the only state signal, a missing value
never becomes `0`, a battery percentage is always marked as an estimate, focus is visible, `aria-label`
on the gauges, `dt`/`dd`, `caption`/`th` and `role="status"` on the notices.

**Consequences.** Divergence recorded in [design-system.md](./design-system.md). Scope §4.1 and rule
30-ui-ux keep the old text until the requester revises them.

### D17 — Unified API 2.0: multi-device and multi-protocol

**Context.** The telemetry service unified the API on a single port for **N** UPS units on different
protocols (`megatec-q1` and `sms-1phase`), raising `contract_version` from `1.0` to `2.0` and
documenting the new contract in `monitor/docs/unified-api.md`. The requester asked for the integration,
reading **one** UPS unit at a time, chosen among the collected ones.

**Decision.** Four points:

1. **Device selection.** The interface lists the UPS units from `GET /api/v1/ups` ("Collected UPS
   units") and sends the choice in `GET /api/dashboard?device_id=`. The backend resolves, in this
   order: `?device_id=` → `UPS_DEVICE_ID` → first with `telemetry_valid:true` → first in the list →
   first key of `health.devices`. Unknown `?device_id=` → `404 device_not_found` (`resolveDeviceId` in
   [dashboard.ts](../src/backend/src/dashboard.ts)).
2. **Value origin per protocol.** Each metric in [gaugeConfig.ts](../src/backend/src/gaugeConfig.ts)
   declares `sources[]` (one path per protocol, in order of preference); the interface resolves it
   with `resolveGaugeSource`. This covers, without renaming fields, the frequency
   (`input_frequency_hz` × `output_frequency_hz`) and the battery (`battery_charge` × `battery`).
3. **Battery — opposite rule.** In `megatec-q1` the percentage is an **estimate** (linear interpolation
   of the voltage, "estimate" tag); in `sms-1phase` it is **reported by the device**
   (`charge_source: "reported_by_device"`, no estimate tag). The tag is per origin (`origin_note`),
   not fixed per metric.
4. **Flags per protocol.** The meaning of b5/b4/b3 changes between Q1 and SMS; the translation table
   is chosen by `data.source` (`flagMetaForProtocol` in
   [status.ts](../src/frontend/src/model/status.ts)). Unknown protocol → Q1 table.

**Justification.** The scope forbids a fixed brand/model in code and requires serving new devices
without changing the frontend. Treating the protocol as data (and not as a special case) keeps the
inviolable rules: `null` never becomes `0`, fields are not renamed and the interface does not know the
API.

**Consequences.** `EXPECTED_CONTRACT_VERSION = "2.0"`; `/health` becomes aggregated
(`devices_total`/`devices_ok`/`devices{}`); the `checksum_error` state (SMS) enters the translation;
`status.raw_byte` is displayed when published. The old API (`1.0`, a single `device_id`) is no longer
accepted silently: the divergence appears in `viewer.warnings`. *(Partly superseded by D18: the
expected `contract_version` became `3.0`.)*

### D18 — Contract 3.0: ~10 s battery test

**Context.** The telemetry service raised `contract_version` from `2.0` to `3.0` and added the fixed
window battery test (~10 s), with `capabilities.battery_test` in `GET /api/v1/ups` and the routes
`POST/GET .../tests` ([`monitor/docs/web-viewer-integration.md`](../monitor/docs/web-viewer-integration.md)
§11). For the first time the contract provides for a **write**. The requester asked for the analysis,
the display of the depletion/runtime prediction and chose **"display + start/abort button"**, with the
caveat that **the test must not be triggered autonomously**.

**Decision.** Five points:

1. **The write stays behind the backend.** The browser never calls the origin API: it uses the viewer's
   own `/api/tests`, which forwards the request preserving the HTTP status and the `error.code`.
   `UpstreamApiClient` now accepts `POST` (the other routes remain GET-only) and the server responds
   `405` to methods ≠ GET, **except** `POST` on `/api/tests*`.
2. **Never trigger on its own.** The `POST` only exists by explicit user action. The interface reads
   `capabilities.battery_test` and only enables the button when `enabled` is `true` (in the current
   profile, the TS Shara comes with `enabled: false` and `abort_supported: false`).
3. **The API delivers facts; the Web Viewer presents.** The runtime (`estimate`) is a 1st-order linear
   extrapolation that the API itself publishes with `confidence: "low"`. When `available` is `false`,
   the interface shows the `reason` — **it never converts the absence into a number**. `capped_at_min`
   is presented as a floor ("≥ 10 h"), not as a precision. The viewer does not compute its own
   predictability.
4. **Confirmation that the test occurred.** The panel shows `test_flag_observed`/`flags_seen`: if the
   UPS unit does not report the `TEST` flag within the window, an explicit notice appears — the API
   **scheduled** the test, but only the flag proves that it ran on the device.
5. **Pure and testable model.** All report reading lives in pure functions
   ([batteryTest.ts](../src/frontend/src/model/batteryTest.ts)), covered by
   [batteryTest.test.ts](../src/frontend/tests/batteryTest.test.ts) without a DOM.

**Justification.** The scope forbids autonomous commands to the UPS unit and requires fidelity to the
contract. Keeping the write in the backend preserves D1 (no CORS, no exposing the API) and keeps a
single validation point. Labeling the runtime as an extrapolation and showing the `reason` when it
does not exist fulfills the golden rule: **no number is invented**.

**Consequences.** `EXPECTED_CONTRACT_VERSION = "3.0"`; the `tests` block (history) enters
`viewer.sources` and the dashboard payload — the absence of the history does not bring down the
dashboard (`tests: null`); `apiClient` now exposes `post()`; the layout gains the test panel in the
lower-left quadrant and "Operational state" moves to the first quadrant. The `2.0` contract is no
longer accepted silently: the divergence appears in `viewer.warnings`.

### D19 — Two test types and timeline charts in the panel

**Context.** The telemetry service published the transfer documents
[`battery-test-api-contract.md`](../monitor/docs/battery-test-api-contract.md) and
[`battery-test-quadrant.md`](../monitor/docs/battery-test-quadrant.md): in addition to the fixed window
test (`duration_10s`), `sms-1phase` started offering `discharge_20pct` — a **no window** discharge that
runs until the charge drops to the **20 % target** or until the 30 min safety ceiling, whichever comes
first. The same material standardized `samples[].normalized` (chart series with the same name in both
protocols) and asked for **charts instead of a table** in the quadrant, with **selectable blocks** in
the sidebar. The requester asked for the analysis, the update of the collection and the implementation
of the charts.

**Decision.** Six points:

1. **Types come from the API, never from the protocol.** The panel selector is built **only** from
   `capabilities.battery_test.test_types`; the chosen `type` is sent in the `POST`. Nothing is assumed
   from the protocol name — offering `discharge_20pct` where the API does not declare it would only
   produce `422 unsupported_test_type`.
2. **Progress with two modes.** `duration_10s` uses the elapsed time over the requested window
   (`mode: "window"`); `discharge_20pct` uses the **charge drop** from the `baseline` to the target
   (`mode: "target"`). The `timeout_s` of 1800 s is a **ceiling**, not the expected duration: using it
   as a window would leave the bar nearly empty even with half of the discharge completed. With no data
   for the fraction, the bar stays **indeterminate** (`aria-valuenow` absent).
3. **Charts from `normalized`, in custom SVG.** The points come from `samples[].normalized`
   (`output_voltage_v`, `frequency_hz`, `temperature_c`, `battery_charge_percent`) against
   `samples[].offset_s`; `measurements` is **not** used, because it varies by protocol. The geometry
   (`buildLineChart`) is a pure and testable function, and the drawing is custom SVG — without a chart
   library (the same guideline as the gauges, D16).
4. **Missing key ≠ zero.** A sample without the key is ignored in the series; the metric block shows
   "series unavailable" and the chart explains the absence. No straight line at zero is drawn — the
   golden rule of the contract (§20/3 and §30) also holds for the charts.
5. **Legible scale for small oscillations.** The Y axis is **automatic with a 15 % margin**, and not the
   gauge scale (0–250 V), which would hide oscillations of ±2 V/±0.5 Hz. The X axis uses `m:ss` above
   60 s and `s.S` in the short test, with the **same** format in all chart labels. The target line
   (20 %) appears dashed, labeled from `target_percent`.
6. **The metrics table is gone.** Block B (charts) takes the place that belonged to the table; the
   remaining table is that of **previous tests**, now with the **Type** column. The summary block keeps
   presenting `deltas`/`estimate` — the API delivers the facts, the viewer presents (D18, item 3).

**Justification.** Keeping the type policy in the API preserves the rule of not inventing capabilities
and allows new devices to come in without changing the frontend. Separating progress into window ×
target avoids presenting the safety ceiling as a prediction. Drawing the charts in custom SVG keeps the
dependency lean, reuses the already tested pure geometry and remains testable without a DOM.

**Consequences.** `batteryTest.ts` gained `buildTestTypeOptions`, `buildChartPoints`,
`buildTestChartModels`, `buildLineChart` and `formatOffsetSeconds`, and the progress now distinguishes
window from target; the new component
[BatteryTestCharts.tsx](../src/frontend/src/components/BatteryTestCharts.tsx) concentrates block B;
`useBatteryTest.start(type?)` forwards the type to the `POST`; the fixtures and the tests cover the
discharge report (`target_percent_reached`, `target_percent`/`timeout_s` in the acceptance) and the
absence of a key in `normalized`. The test remains **without** autonomous triggering: only the click
sends the command.

---

## Open items (awaiting the requester's decision)

| # | Open item | Impact while unresolved |
|---|---|---|
| P3 | Decide whether the dashboard will display only model/`device_id` or also other identity data | Today it displays everything the API publishes; whatever is missing appears as "—" |
| P4 | Confirm whether the application will be accessible only on the local management network | No authentication was implemented (the origin API does not authenticate either) |
| P6 | Decide on a reading history | Out of scope for this version |
| P7 | Revise scope §4.1 and rule 30-ui-ux (white background) to record the dark visual language adopted (D16) | The documents keep the old text; the divergence is recorded in [design-system.md](./design-system.md) |

### Completed open items

| # | Open item | Status |
|---|---|---|
| P1 | Validate the red/amber/green bands of each metric | ✅ Completed on 2026-10-21 (D3) |
| P2 | Confirm the fleet output voltage (110/127 V vs 220 V) | ✅ Completed: the default band covers both windows (80–127 and 200–225 V) (D3) |
| P5 | Define the operational temperature and load limits | ✅ Completed on 2026-10-21 (D3) |

## Discarded decisions

- **Querying the API directly from the browser** — would require CORS on the origin API (outside this
  project's control) and would expose the API address to the browser.
- **Chart library (Chart.js/ECharts/Recharts)** — unnecessary weight and configuration for six
  semicircular gauges.
- **Database / authentication** — no demonstrated need; forbidden by scope §2.3 and §9.3.
- **Server-side rendering** — the panel is read-only and refreshed by polling; CSR is sufficient.
