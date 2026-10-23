# Integration with the Web Viewer (same repository, Docker)

Handover document: what the **Web Viewer** needs to know / be able to do in order to consume the
**unified `upsmon` API** — published by this project at `http://127.0.0.1:8080`.

- **Source:** the telemetry service in this repository (`monitor/`) — reference host, Ubuntu 24.04.5 LTS.
- **Target:** the Web Viewer in this repository (Node/TypeScript backend in
  `src/backend/src/{apiClient,contract,dashboard,gaugeConfig}.ts`; React frontend in
  `src/frontend/src/model/status.ts` and `components/StatusFlags.tsx`).
- **Source of truth for the contract:** [unified-api.md](unified-api.md).
- **Evidence in this document:** real collection on **2026-10-22 11:22–11:23 (-03)** / `14:22–14:23Z`,
  with **only the SMS cable connected** (the TS Shara is without a cable — a real and useful scenario for
  validating the isolation between devices).
- **Summary:** most of the consumed contract **has not changed**. The changes that require action from the
  Web Viewer are: (a) **selecting the device** (`UPS_DEVICE_ID`), (b) `/health` is now
  **multi-device**, (c) **protocol-specific** fields in the telemetry, and (d) **status flags that are
  not those of the Q1**.
- **New (contract 3.0):** the **battery test** — a button in the Web Viewer, a `POST` to the API, and a
  **predictability report** with the sampled **timeline** (load drop, output voltage/frequency
  oscillation, temperature variation, UPS load, and estimated runtime). Two types:
  `duration_10s` and `discharge_20pct`. This is the subject of **§11**, and it is the **only** part of this
  document that requires new code in the Web Viewer.

---

## 1. What changed for the consumer

| Item | Before (per-equipment API) | Now (unified API) | Impact on the Web Viewer |
|---|---|---|---|
| HTTP port | one port per equipment (8080 / 8081) | **one port for N equipments** (8080) | None in the code: only the `.env` changes |
| Endpoints | `/health`, `/api/v1`, `/api/v1/ups`, `/api/v1/ups/{id}/telemetry`, `/api/v1/ups/{id}/identity` | **the same** | None |
| `/api/v1/ups` | 1 item in `devices[]` | **N items** (`tsshara-3200va-01`, `sms-ups3200s-01`) | Device selection becomes explicit (§3) |
| `/health` | one equipment (`device_id`, `checks{}`, `collector{}`) | **multi-device** (`devices_total`, `devices_ok`, `devices{<id>}`, `collector_thread`, `telemetry_freshness`, `identity`) | `checks`/`collector`/`device_id` **no longer exist** (§5) |
| `telemetry` | envelope and fields of one protocol | **identical** envelope; `measurements`/battery/**flags change per protocol** | Gauges and the flags panel must be per protocol (§6, §7, §8) |
| `contract_version` | `1.0` | **`3.0`** | No break today; constant/documentation to be updated (§5.1) |
| Methods | GET only | GET (telemetry) + **POST** on `.../tests` (§11) | None in the current flow; enables the **battery test button** (§11) |
| `api_version` | `v1` | `v1` | None |

---

## 2. Connectivity from the Docker container

The API listens **only on the host's network IP** (`http_host = 127.0.0.1`) — **not** on `0.0.0.0`.

| Configuration | Result |
|---|---|
| `UPS_API_BASE_URL=http://127.0.0.1:8080` | **Works.** This is what this host's `.env` already uses (scenario B) |
| `UPS_API_BASE_URL=http://host.docker.internal:8080` | **Does not work** with the current bind: `extra_hosts: host.docker.internal:host-gateway` resolves to the bridge IP (`172.17.0.1`), and the API does not listen on that address → connection refused (`upstream_unreachable`) |

To use `host.docker.internal`, the API would have to come up with `http_host = 0.0.0.0` (this is not the
project default, which publishes only on the management network). **Nothing needs to be changed**: keep the IP.

Quick verification from inside the container:

```bash
docker compose exec ups-web-viewer node -e \
  "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
```

## 3. Device selection (action required)

`resolveDeviceId()` in `src/backend/src/dashboard.ts` chooses **`devices[0]`** when `UPS_DEVICE_ID` is
empty. With two equipments on the same port, the first is `tsshara-3200va-01` — which today is **without a
cable** and responds **503** on `/telemetry`. The dashboard would display "No data" even with the SMS
reading normally.

| Scenario | `UPS_DEVICE_ID` | Effect |
|---|---|---|
| **Only the SMS connected (today)** | `sms-ups3200s-01` | Dashboard shows the SMS (200) |
| Only the TS Shara connected | `tsshara-3200va-01` | Dashboard shows the TS Shara (200) |
| Both connected, view of one of them | one of the two `device_id` | Fixes the equipment |
| Empty (automatic discovery) | *(empty)* | Always the **first** of `/api/v1/ups` — fragile with 2+ equipments |

```env
# UPS Monitor/.env
UPS_DEVICE_ID=sms-ups3200s-01
```

> Evolution recommendation (optional, outside the current scope): make the Web Viewer **multi-device**,
> listing all items of `/api/v1/ups` and querying the `/telemetry` of each one. Today the viewer is
> *single-device* by construction (`upsmon.deviceId`, one `upstream_contract`).

## 4. Validated result (evidence)

Captured against the real API at `127.0.0.1:8080`:

| Request | HTTP | Observation |
|---|---|---|
| `GET /health` | **503** | `status: "degraded"` — `devices_ok: 1` of `devices_total: 2` |
| `GET /api/v1` | 200 | `devices: ["tsshara-3200va-01", "sms-ups3200s-01"]` |
| `GET /api/v1/ups` | 200 | `count: 2`; TS Shara `port_unavailable`, SMS `ok` |
| `GET /api/v1/ups/sms-ups3200s-01/telemetry` | **200** | 218.6 V input · 217.7 V output · 19 % load · 59.9 Hz · battery 100 % (reported) · 49.1 °C |
| `GET /api/v1/ups/sms-ups3200s-01/identity` | 200 | model `Power Sinus`, firmware `1.2`, nominal 220 V / 24 V / 60 Hz |
| `GET /api/v1/ups/tsshara-3200va-01/telemetry` | **503** | `port_unavailable` (cable disconnected) — `data: null` |
| `GET /api/v1/ups/naoexiste/telemetry` | 404 | `device_not_found` |
| `POST /api/v1/ups` | 405 | `method_not_allowed` |

**Important reading:** `/health` responds **503** only because one of the two equipments is without a cable.
The Web Viewer handles 503 correctly (it passes `200` back with an explicit state) — and `GET /api/v1/ups`
keeps returning **200**, that is, equipment discovery works even with one device down.

## 5. Changes in `/health` and in the envelope

### 5.1 `/health` is now aggregated per device

```json
{
  "api_version": "v1",
  "contract_version": "2.0",
  "status": "degraded",
  "checked_at_utc": "2026-10-22T14:23:07.723Z",
  "uptime_seconds": 10.273,
  "devices_total": 2,
  "devices_ok": 1,
  "devices": {
    "tsshara-3200va-01": {
      "telemetry_valid": false, "stale": false, "state": "port_unavailable",
      "serial_port": null, "collector_thread": "ok", "telemetry_freshness": "no_data",
      "communication": "port_unavailable", "identity": "unavailable",
      "last_success_utc": null, "age_seconds": null
    },
    "sms-ups3200s-01": {
      "telemetry_valid": true, "stale": false, "state": "ok",
      "serial_port": "/dev/ttyUSB0", "collector_thread": "ok", "telemetry_freshness": "ok",
      "communication": "ok", "identity": "ok",
      "last_success_utc": "2026-10-22T14:23:02.965Z", "age_seconds": 4.758
    }
  }
}
```

| Field of the old contract | Situation now | Consequence in the Web Viewer |
|---|---|---|
| `health.device_id` | **does not exist** | In `dashboard.ts::resolveDeviceId()`, the `health?.device_id` fallback is never satisfied. Discovery now depends **solely** on `/api/v1/ups` — which still responds 200 (ok), but the fallback is dead |
| `health.checks{}` | **does not exist** | `parseHealth()` leaves `checks` undefined (it does not generate a `problem`, since only `status` is mandatory). No UI item reads `checks` today |
| `health.collector{}` | **does not exist** | `parseHealth()` leaves `collector` undefined, without generating a `problem`. **Warning:** if any consumer uses `health.collector` for the communication state, it is now `undefined`; the correct path becomes `telemetry.communication` (unchanged) or `health.devices{<id>}.state` |
| `health.status` | **remains** (`ok`/`degraded`/`down`) | It now aggregates **all** devices |
| — | **new:** `devices_total`, `devices_ok`, `devices{}` | Natural source for a future multi-device view |

`status`: `ok` only when **all** equipments have valid telemetry; `degraded` when the application
is up but some device has no usable reading; `down` when some collection thread has died.
`/health` responds **200** only in `ok`.

**It is not necessary to change `parseHealth()`** for the current operation (no new mandatory field, no
mandatory field removed). The suggestions above are for the `checks`/`collector`/`device_id` items that today
are left undefined.

### 5.2 `contract_version` became `2.0` and is now at `3.0`

`src/backend/src/contract.ts` declares `EXPECTED_CONTRACT_VERSION = "1.0"`, but the `envelope()` function **does
not compare** this value (it only validates that `contract_version` is textual). Therefore **there is no break
and no warning** — `viewer.upstream_contract` will simply start reporting `2.0`… and now `3.0`.

Version **3.0** is a *major* because the API **ceases to be strictly read-only** (§11). This **does not**
change anything that the Web Viewer already consumes: no existing field was renamed, removed, or had its
type changed — the telemetry is identical. Even so, keep the rule that a divergence of
`contract_version` is a **warning**, never an error: the viewer should continue displaying the telemetry
normally.

Suggestion (contract hygiene, not a bug fix): update the constant to `"3.0"`, the test
fixtures (`tests/helpers/fixtures.ts`, `src/frontend/src/demo/fixture.ts`) and the document
`docs/api-contract.md`/`.trae/rules/20-api-contract.md` (which cite `contract_version 1.0`).

### 5.3 Envelope — no changes

`api_version` (`v1`) and `contract_version` in **all** responses, including errors
(`{"error": {"code", "message"}}`); ISO 8601 UTC dates with a `Z` suffix; unit in the field name. On the
**telemetry** paths the HTTP codes remain `200 / 404 / 405 / 503` with the same meanings. The
**test** paths (`.../tests`) add `202 / 400 / 403 / 409 / 422` (§11.4) — none of that affects the
telemetry flow that already exists.

## 6. Telemetry differences per device

`data.measurements`, the battery block, and the status block **vary according to the protocol**. The envelope
(§5.3) is identical.

### 6.1 `data.measurements`

| Field | `tsshara-3200va-01` (`megatec-q1`) | `sms-ups3200s-01` (`sms-1phase`) |
|---|---|---|
| `input_voltage_v` | yes | yes |
| `output_voltage_v` | yes | yes |
| `load_percent` | yes | yes |
| `temperature_c` | yes | yes |
| `input_voltage_fault_v` | **yes** | **no** |
| `input_frequency_hz` | **yes** | **no** (uses `output_frequency_hz`) |
| `battery_voltage_v` | **yes** | **no** (the voltage is in `data.battery.voltage_v`) |
| `output_frequency_hz` | no | **yes** |
| `input_voltage_extended_v` | no | **yes** (extended scale; `0.0` when not applicable) |

The fields are **protocol extensions**: the first four are common; the rest keep the name that each
model already published before unification (so as not to break existing items).

### 6.2 Battery block — name and origin **opposite**

| Device | Block | Source of the percentage | Voltage | Correct label in the interface |
|---|---|---|---|---|
| TS Shara | `data.battery_charge` | **estimated** by linear interpolation | reported by the equipment (`measurements.battery_voltage_v`) | **"estimate"** |
| SMS | `data.battery` | **reported by the equipment** (`charge_percent`) | **derived** (`nominal × % / 100`) | **not an estimate** (it is a reading from the equipment) |

```json
// TS Shara (data.battery_charge)
"battery_charge": { "percent": 100.0, "estimated": true, "method": "linear_voltage_interpolation",
                    "calibration": { "voltage_low_v": 20.1, "voltage_high_v": 26.8 } }

// SMS (data.battery)
"battery": { "charge_percent": 100.0, "charge_source": "reported_by_device",
             "voltage_v": 24.0, "voltage_derived": true, "voltage_nominal_v": 24, "packs": 2 }
```

> Rule 7 of `.trae/rules/20-api-contract.md` ("`data.battery_charge.percent` is always an ESTIMATE") applies
> **only** to the `megatec-q1` protocol. Applying it to the SMS would be an incorrect statement about the
> origin of the data.

### 6.3 Status block — **attention: the bits do not have the same meaning**

Both publish `raw_bits` (string b7…b0), `active[]`, and `flags{}` (all 8 names). The SMS adds
`raw_byte` (decimal).

| Bit | `megatec-q1` (TS Shara) | `sms-1phase` (SMS) |
|---|---|---|
| b7 | `OB` — operating on battery | `OB` — mains absent / on battery |
| b6 | `LB` — low battery | `LB` — low battery |
| b5 | **`BOOST`** — voltage boost | **`BYPASS`** — bypass active |
| b4 | **`FAULT`** — fault | **`BOOST`** — boost/buck active |
| b3 | **`STANDBY`** — standby mode | **`UPSOK`** — inverter/mains OK |
| b2 | `TEST` | `TEST` |
| b1 | `FSD` | `FSD` |
| b0 | `BEEP` | `BEEP` |

**Concrete risk in the Web Viewer:** `FLAG_META` (`src/frontend/src/model/status.ts`) is the Q1 table and
`buildFlagViews()` renders **only** those eight names. Applied to an SMS payload, the interface
would show `FAULT` and `STANDBY` **inactive** with Q1 labels — the SMS does not transmit those states, and its
b4/b3 mean `BOOST`/`UPSOK`. In addition, `BY` = `BYPASS` and `UPSOK` would fall into
`buildUnknownFlagViews()` as "State not documented in the current contract.".

In short, for the SMS a second set of labels would be needed (and the SMS **must not** reuse the
Q1 table):

| Flag (SMS) | Meaning | Suggested severity |
|---|---|---|
| `OB` | Mains absent / operating on battery | warning |
| `LB` | Low battery | critical |
| `BYPASS` | Bypass active | warning |
| `BOOST` | Boost/Buck active | informational |
| `UPSOK` | Inverter/mains OK (no fault) | informational (it is the **good** state) |
| `TEST` | Test in progress (never triggered by the viewer) | informational |
| `FSD` | Shutdown active | warning |
| `BEEP` | Beeper on | warning |

Real SMS sample (`flags`): `OB: false`, `LB: false`, `BYPASS: **true**`, `BOOST: false`,
`UPSOK: **true**`, `TEST: false`, `FSD: false`, `BEEP: **true**` (`raw_bits: "00101001"`).

### 6.4 New communication state: `checksum_error`

The SMS protocol validates an 18-byte **checksum** per frame, so the list of `communication.state` gained
**`checksum_error`** (13 states in total). `STATE_TEXT` in `src/frontend/src/model/status.ts` covers 12 and
**does not** have `checksum_error` → it would appear as "State not documented in the current contract.".

Suggestion: add, for example, `checksum_error: { label: "Corrupted frame", description: "Response
received with invalid checksum." }` and align the list in `.trae/rules/20-api-contract.md` §10.

### 6.5 Identity (`/identity`)

| Field | TS Shara | SMS |
|---|---|---|
| `data.device.manufacturer` | present | **absent/`null`** (the SMS `I` frame does not carry a manufacturer) |
| `data.device.model` | present | present (`"Power Sinus"`) |
| `data.device.firmware` | present | present (`"1.2"`) |
| `data.nominal.voltage_label` / `voltage_v` | `"Univ."` → `voltage_v: null` | `"220"` → `voltage_v: 220` |
| `data.nominal.input_current_a` / `battery_voltage_v` / `frequency_hz` | present | present |
| extra labels | — | `input_current_label`, `battery_voltage_label`, `frequency_label` |

`parseIdentity()` remains valid: all the fields it reads exist in both protocols; the difference is in
**content** (`manufacturer` null on the SMS), which the interface already treats as "—".

## 7. Real telemetry payload — `sms-ups3200s-01`

`GET /api/v1/ups/sms-ups3200s-01/telemetry` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "2.0",
  "device_id": "sms-ups3200s-01",
  "telemetry_valid": true,
  "stale": false,
  "data_available": true,
  "data": {
    "captured_at_utc": "2026-10-22T14:23:02.965Z",
    "source": "sms-1phase",
    "measurements": {
      "input_voltage_extended_v": 0.0,
      "input_voltage_v": 218.6,
      "output_voltage_v": 217.7,
      "load_percent": 19.0,
      "output_frequency_hz": 59.9,
      "temperature_c": 49.1
    },
    "battery": {
      "charge_percent": 100.0, "charge_source": "reported_by_device",
      "voltage_v": 24.0, "voltage_derived": true, "voltage_nominal_v": 24, "packs": 2
    },
    "status": {
      "raw_bits": "00101001", "raw_byte": 41,
      "active": ["BEEP", "UPSOK", "BYPASS"],
      "flags": { "BEEP": true, "FSD": false, "TEST": false, "UPSOK": true,
                 "BOOST": false, "BYPASS": true, "LB": false, "OB": false }
    },
    "raw_frame": "3d 00 00 08 8a 08 81 00 be 02 57 03 e8 01 eb 29 91 0d",
    "age_seconds": 4.781
  },
  "communication": {
    "state": "ok", "telemetry_valid": true, "stale": false,
    "last_attempt_utc": "2026-10-22T14:23:07.465Z",
    "last_success_utc": "2026-10-22T14:23:02.965Z",
    "age_seconds": 4.781, "consecutive_failures": 0,
    "total_attempts": 3, "total_successes": 2, "last_error": null,
    "serial_port": "/dev/ttyUSB0", "poll_interval_s": 5.0, "stale_after_s": 20.0
  }
}
```

Without a valid reading (TS Shara without a cable) → **503**, `data: null`, without fictitious values:

```json
{
  "api_version": "v1", "contract_version": "2.0", "device_id": "tsshara-3200va-01",
  "telemetry_valid": false, "stale": false, "data_available": false, "data": null,
  "communication": {
    "state": "port_unavailable", "last_success_utc": null,
    "consecutive_failures": 3, "total_attempts": 3, "total_successes": 0,
    "last_error": { "code": "port_unavailable",
      "message": "porta serial do nobreak nao encontrada (VID:PID 0483:5740); verifique o cabo USB ou defina serial_port na configuracao",
      "at_utc": "2026-10-22T14:23:07.463Z" },
    "serial_port": null, "poll_interval_s": 5.0, "stale_after_s": 20.0
  }
}
```

## 8. Impact on the Web Viewer gauges

`GAUGE_DEFINITIONS` uses a fixed `source_path` in the telemetry payload. With the SMS device selected:

| Gauge (id) | `source_path` | TS Shara | SMS |
|---|---|---|---|
| `input_voltage_v` | `data.measurements.input_voltage_v` | ok | ok |
| `output_voltage_v` | `data.measurements.output_voltage_v` | ok | ok |
| `input_frequency_hz` | `data.measurements.input_frequency_hz` | ok | **"No data"** (the SMS publishes `output_frequency_hz`) |
| `temperature_c` | `data.measurements.temperature_c` | ok | ok (note: 49.1 °C is above the "critical" band of 35 °C defined today — a real equipment value, not an error) |
| `battery_charge_percent` | `data.battery_charge.percent` | ok (**estimate**) | **"No data"** (the SMS publishes `data.battery.charge_percent`) |
| `load_percent` | `data.measurements.load_percent` | ok | ok |

`readMetricValue()` returns `undefined` for a missing path → the interface shows "No data", **without**
inventing a value (correct and expected behavior). To display the SMS battery, the reading must point
to `data.battery.charge_percent`, with the correct label ("reported by the equipment", **without** the
estimate mark).

Since `VIEWER_GAUGE_THRESHOLDS` only overrides `scale`/`bands`/`label`/`unit`/`decimals` (not the
`source_path`), per-device support requires choosing the `source_path` according to the device's
`protocol` (or grouping the two metrics, showing only the one that exists).

**There is no contract divergence here**: `measurements` is validated as
`Record<string, number | null>` — extra keys (`output_frequency_hz`, `input_voltage_extended_v`) are
preserved **without** generating `viewer.warnings`.

## 9. Suggested checklist for the Web Viewer

| # | Action | Where | Mandatory? |
|---|---|---|---|
| 1 | `UPS_DEVICE_ID=sms-ups3200s-01` (while only the SMS is connected) | `.env` | **Yes, to see data today** |
| 2 | Keep `UPS_API_BASE_URL=http://127.0.0.1:8080` | `.env` | **Yes** (the bind does not listen on the Docker bridge) |
| 3 | Accept `contract_version` `3.0` (update the constant, fixtures, and docs) | `src/backend/src/contract.ts`, tests, `docs/api-contract.md`, `.trae/rules/20-api-contract.md` | Recommended |
| 4 | Flag labels per protocol (do not reuse the Q1 table on the SMS) | `src/frontend/src/model/status.ts`, `components/StatusFlags.tsx` | Recommended |
| 5 | Add `checksum_error` to `STATE_TEXT` | `src/frontend/src/model/status.ts` | Recommended |
| 6 | Battery: use `data.battery.charge_percent` (SMS) in addition to `data.battery_charge.percent` (TS Shara), with the correct origin label | `src/backend/src/gaugeConfig.ts` + `model/metrics.ts` | Recommended for the SMS |
| 7 | Frequency: `data.measurements.output_frequency_hz` (SMS) in addition to `input_frequency_hz` (TS Shara) | same | Recommended for the SMS |
| 8 | Account for multi-device `/health` (`devices{}`), without depending on `checks`/`collector`/`device_id` | `src/backend/src/contract.ts`, `dashboard.ts` | Optional (document) |
| 9 | Evolve to multi-device (list all from `/api/v1/ups`) | `dashboard.ts` | Optional (future stage) |

## 10. How to recheck the API

```bash
B=http://127.0.0.1:8080
curl -s "$B/health"                | python3 -m json.tool     # 503 while the TS Shara is without a cable
curl -s "$B/api/v1"                | python3 -m json.tool
curl -s "$B/api/v1/ups"            | python3 -m json.tool
curl -s "$B/api/v1/ups/sms-ups3200s-01/telemetry"    | python3 -m json.tool   # 200
curl -s "$B/api/v1/ups/sms-ups3200s-01/identity"     | python3 -m json.tool   # 200
curl -s "$B/api/v1/ups/tsshara-3200va-01/telemetry"  | python3 -m json.tool   # 503 port_unavailable
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$B/api/v1/ups"               # 405
```

When the TS Shara cable is reconnected, the udev rule
([99-upsmon.rules](../config/examples/99-upsmon.rules)) **restarts the service** automatically and
`/health` should return to `ok` (200) without manual intervention.

## 11. Battery test (new in contract 3.0)

This is the part that requires **new code** in the Web Viewer. Everything else in the document is a
compatibility check.

**What the button does:** it asks the API for a battery test. The UPS momentarily switches to operating on
battery; the collector samples at high frequency and builds a **timeline** (`samples[]`) that becomes a
**predictability report** — **battery load drop**, **output voltage and frequency oscillation**, **internal
temperature variation**, **whether the UPS load increased** when switching to battery, and the **estimated
runtime** in case of a real outage.

**Two test types** (`type` in the `POST`):

| `type` | What it does | How it ends | Where it exists |
|---|---|---|---|
| `duration_10s` *(default)* | **fixed** window of ~10 s | end of the window (or `watchdog`) | all protocols with a test |
| `discharge_20pct` | **no window**: runs until the reported charge falls to the **fixed target of 20 %** | target reached (`target_percent_reached`) or **30 min cap** (`watchdog`) | **only** where `abort_supported: true` — today the SMS |

**What the button does NOT do:** there is no test "until the battery is low" (critical level). The `duration_10s`
is a fixed window and the `discharge_20pct` stops by itself at the **20 % target** (the API **sends a cancel**
order to the test upon reaching it). There are guards that refuse the request (battery already low, UPS already
on battery, charge below the minimum, charge already at the target, cooldown).

> **The API provides the facts; the Web Viewer provides the presented predictability.** The API delivers the
> **complete series** (`samples[]`, with the normalized metrics), the aggregations (`deltas`), and the
> **first-order linear** extrapolation already marked `confidence: "low"`. The definitive model/policy (average
> between tests, trend, alert) and the **charts** belong to the Web Viewer.
>
> **Dedicated documents:** [battery-test-api-contract.md](battery-test-api-contract.md) — **how the data
> is sent** (layout of `samples[]`/`normalized`, the two types, flow, the four charts); and
> [battery-test-quadrant.md](battery-test-quadrant.md) — **how to apply** the data in the *Battery Test
> quadrant*. The formal contract is in
> [unified-api.md §6.8](unified-api.md#68-teste-de-bateria-contrato-30).

### 11.1 Discovery — the button only appears where the test exists

`GET /api/v1/ups` now brings `capabilities.battery_test` per device:

```json
"capabilities": {
  "battery_test": {
    "supported": true, "enabled": true,
    "test_types": ["duration_10s", "discharge_20pct"],
    "types": {
      "duration_10s":    { "duration_s": 10.0, "target_percent": null, "timeout_s": 12.0,   "sample_interval_s": 0.4 },
      "discharge_20pct": { "duration_s": null, "target_percent": 20.0, "timeout_s": 1800.0, "sample_interval_s": 2.0 }
    },
    "duration_s": 10.0, "sample_interval_s": 0.4, "cooldown_s": 300.0,
    "min_battery_percent": 50.0, "abort_supported": true
  }
}
```

| Field | Use in the interface |
|---|---|
| `enabled` | **Enables/disables the quadrant.** `false` → hide the button (or show it disabled) and explain that the device does not have the test enabled. Do **not** try the `POST` "to see what happens": it responds 403 |
| `test_types` | **Which options to offer** in the selector. The `megatec-q1` brings only `["duration_10s"]` |
| `types.<type>` | `duration_s` (progress bar), `target_percent` (label "up to 20 %"), `timeout_s` (cap), `sample_interval_s` (rate) |
| `abort_supported` | Shows the **Cancel** button during execution. `false` (TS Shara): cancellation merely stops sampling |
| `cooldown_s`, `min_battery_percent` | Explain **before** the user clicks (avoids the 409) |

### 11.2 Flow

```text
[Select the type]  ->  ["Test battery" button]
        |  POST /api/v1/ups/{device_id}/tests   {"type":"duration_10s"}  (or "discharge_20pct")
        v
   202 { test_id, status:"running", report_url, poll_interval_s:0.5, expected_end_at_utc,
         requested_duration_s, target_percent, timeout_s, sample_interval_s }
        |
        |  polling at report_url every 0.5 s (the POST is ASYNCHRONOUS: it only runs on the collector's next cycle)
        v
   GET .../tests/{test_id}   -> status "running" (PARTIAL samples[]: draws the live curve;
        |                                            deltas/estimate still null)
        |                       ... until
        v
   status "completed" | "aborted" | "failed"   -> complete report (deltas/estimate filled in)
        |
        v
   [Renders the 4 charts + the predictability summary]
```

**Detail that avoids an interface bug:** the `POST` is **asynchronous**. The request enters a queue and is only
executed on the collector's next cycle (up to `poll_interval_s` = 5 s). Therefore, the complete report takes
approximately **`expected_end_at_utc` + up to 5 s**. Do not treat the `POST` response as the test result —
always follow it via `report_url`. In `discharge_20pct` the `expected_end_at_utc` is the **30 min
cap**, not a predicted duration (the test normally ends earlier, upon reaching 20 %).

### 11.3 Input and output (the contract the Web Viewer implements)

#### Input — request

```http
POST /api/v1/ups/{device_id}/tests
Content-Type: application/json

{ "type": "discharge_20pct" }
```

The body is **optional** (`{}` or no body is equivalent to `duration_10s`). `device_id` is the same `UPS_DEVICE_ID`
already used in the telemetry. For the TS Shara, always use `duration_10s`.

#### Output — acceptance (`202 Accepted`)

```json
{
  "api_version": "v1", "contract_version": "3.0",
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

Use `report_url` (relative path — concatenate with `UPS_API_BASE_URL`), do **not** build the URL by hand.

#### Output — follow-up (`GET .../tests/{test_id}` → `200`)

While `running`, the payload already comes with the **partial series** (useful for the live charts); at the end,
it comes complete. Summary of the fields the interface consumes:

```json
{
  "api_version": "v1", "contract_version": "3.0",
  "device_id": "sms-ups3200s-01",
  "test": {
    "test_id": "9f3c1a7b2d4e5061", "type": "discharge_20pct", "status": "completed",
    "started_at_utc": "...", "expected_end_at_utc": "...", "ended_at_utc": "...",
    "requested_duration_s": null, "duration_s": 325.217, "sample_interval_s": 2.0,
    "target_percent": 20.0, "timeout_s": 1800.0, "finish_reason": "target_percent_reached",
    "test_flag_observed": true,
    "flags_seen": ["BEEP", "BYPASS", "OB", "TEST", "UPSOK"],
    "baseline": { "output_voltage_v": 217.7, "load_percent": 19.0, "temperature_c": 49.1,
                  "frequency_hz": 59.9, "battery_charge_percent": 100.0, "battery_voltage_v": 24.0 },
    "final":    { "output_voltage_v": 216.9, "load_percent": 27.0, "temperature_c": 52.3,
                  "frequency_hz": 59.8, "battery_charge_percent": 20.0, "battery_voltage_v": 21.6 },
    "deltas": { "window_s": 325.217, "sample_count": 163, "metrics": {
        "battery_charge_percent": { "start":100.0, "end":20.0, "delta":-80.0, "ripple":80.0,
                                    "max_abs_deviation":80.0, "min":20.0, "max":100.0, "count":163 },
        "output_voltage_v":       { "start":217.7, "end":216.9, "delta":-0.8, "ripple":3.7,
                                    "max_abs_deviation":2.3, "min":215.4, "max":219.1, "count":163 },
        "temperature_c":          { "start":49.1, "end":52.3, "delta":3.2, "ripple":3.2,
                                    "max_abs_deviation":3.2, "min":49.1, "max":52.3, "count":163 },
        "frequency_hz":           { "start":59.9, "end":59.8, "delta":-0.1, "ripple":0.5,
                                    "max_abs_deviation":0.3, "min":59.6, "max":60.1, "count":163 },
        "load_percent":           { "start":19.0, "end":27.0, "delta":8.0, "ripple":8.0,
                                    "max_abs_deviation":8.0, "min":19.0, "max":27.0, "count":163 } } },
    "estimate": { "available": true, "method": "linear_regression_trimmed",
                  "window_s": 325.217, "readings_total": 163, "readings_used": 158,
                  "transient_readings_dropped": 5, "drop_percent_in_window": 80.0,
                  "drop_percent_used": 74.0, "discharge_rate_pp_per_min": 14.76,
                  "reference_charge_percent": 26.0,
                  "estimated_runtime_min": 6.8, "capped_at_min": 600.0, "confidence": "low" },
    "samples_count": 163,
    "error": null,
    "samples": [ { "offset_s": 2.014,
                   "measurements": { "output_voltage_v": 218.0, "load_percent": 19.5,
                                     "output_frequency_hz": 59.9, "temperature_c": 49.1, "...": "..." },
                   "status": { "raw_bits": "00101101", "flags": { "TEST": true, "...": false } },
                   "battery": { "charge_percent": 99.5, "voltage_v": 23.9 },
                   "normalized": { "output_voltage_v": 218.0, "frequency_hz": 59.9,
                                   "temperature_c": 49.1, "battery_charge_percent": 99.5,
                                   "load_percent": 19.5, "input_voltage_v": 218.6,
                                   "battery_voltage_v": 23.9 } } ]
  }
}
```

> **Illustrative** values (to show the shape). The real numbers come from the equipment.

**Volumes:** `duration_10s` brings ~25 samples (10 s ÷ 0.4 s); `discharge_20pct` can reach ~900 (up to
30 min ÷ 2 s). Avoid requesting the report every 100 ms — `poll_interval_s` (0.5 s) is the suggested rate.

> **`samples[].normalized` is the source of the charts.** Each sample brings a `normalized` block with the
> metrics **common to both protocols** — use it instead of `measurements` (which has names specific to each
> model). Details and the mapping of the four charts in
> [battery-test-api-contract.md §5–6](battery-test-api-contract.md).

#### Output — history (`GET .../tests?limit=N` → `200`)

Version **without** `samples[]`, for a trend chart between tests (today's estimated runtime ×
yesterday's):

```json
{ "api_version": "v1", "contract_version": "3.0", "device_id": "sms-ups3200s-01", "count": 1,
  "tests": [ { "test_id": "9f3c1a7b2d4e5061", "type": "discharge_20pct", "status": "completed",
               "started_at_utc": "...", "duration_s": 325.217, "target_percent": 20.0,
               "finish_reason": "target_percent_reached", "samples_count": 163,
               "flags_seen": ["BEEP","BYPASS","OB","TEST","UPSOK"],
               "estimate": { "available": true, "estimated_runtime_min": 6.8, "confidence": "low" },
               "error": null } ] }
```

The history is **in memory** (last `test_history_size` = 20 per device) and is lost when the
service restarts. Do not use it as a long-term source.

#### Cancellation

```http
POST /api/v1/ups/{device_id}/tests/{test_id}/abort
```

→ `202 { "test_id": "...", "status": "aborting" }`. The report moves to `status: "aborted"` and
`finish_reason: "aborted"`, **preserving the samples already collected**. In `megatec-q1` (`abort_supported:
false`) this merely interrupts sampling. In `sms-1phase` the cancellation is also **sent to the UPS**
(it ends the test on the equipment).

### 11.4 Errors and what to show in the interface

| HTTP | `error.code` | Suggested message in the interface |
|---|---|---|
| `403` | `test_disabled` | "Battery test not enabled on this equipment." (ideally do not even show the button) |
| `409` | `test_cooldown` | "Wait a few minutes between tests (cooldown)." |
| `409` | `battery_too_low` | "Battery charge below the safe minimum for testing." |
| `409` | `battery_at_target` | "The charge is already at 20 % — there is nothing to discharge." |
| `409` | `on_battery` | "The UPS is already on battery — test not allowed." |
| `409` | `battery_low` | "Low battery (LB flag) — test not allowed." |
| `409` | `test_in_progress` | "A test is already in progress on this equipment." |
| `409` | `test_unavailable` | "No fresh telemetry — check the equipment's communication." |
| `409` | `test_not_running` | (on cancellation) "This test has already ended." |
| `422` | `unsupported_test_type` / `test_not_supported` | "Test type unavailable for this equipment." |
| `422` | `test_requires_battery_percent` | "This equipment does not report the battery percentage (required for the target-based discharge)." |
| `404` | `device_not_found` / `test_not_found` | "Equipment/test not found." |
| `400` | `invalid_request` | Malformed request (client bug). |

The error envelope is the usual one (`{"error": {"code", "message"}}`), with `message` already in Portuguese and
ready to display (or to log).

### 11.5 How to render the predictability report

| User question | Contract field |
|---|---|
| How much did the battery drop? | `test.deltas.metrics.battery_charge_percent.delta` (negative) and `.ripple` |
| Did the output voltage oscillate much? | `test.deltas.metrics.output_voltage_v.ripple` / `.max_abs_deviation` |
| And the frequency? | `test.deltas.metrics.frequency_hz.ripple` / `.max_abs_deviation` |
| Did it heat up internally? | `test.deltas.metrics.temperature_c.delta` / `.max` |
| Did the UPS load increase when switching to battery? | `test.deltas.metrics.load_percent.delta` (> 0) |
| How much battery time would I have in a real outage? | `test.estimate.estimated_runtime_min` (**only** if `estimate.available`) |
| Did the test really happen? | `test.test_flag_observed` + `"TEST"` in `test.flags_seen` |
| I want the curve on the chart | `test.samples[]` (`offset_s` on the X axis; `normalized` on the Y axis) |

The **four charts** (output voltage, frequency, temperature, battery charge) are `offset_s` (X)
against `samples[].normalized.<key>` (Y):

| Chart | `normalized` key |
|---|---|
| Output Voltage Oscillation | `output_voltage_v` |
| Output Frequency Oscillation | `frequency_hz` |
| Internal Temperature Variation | `temperature_c` |
| Battery Charge Drop | `battery_charge_percent` |

Golden rules in the presentation:

1. **Never invent a number:** if `estimate.available` is `false`, show the `reason` ("load drop below the
   measurable resolution"), **not** a runtime. The `estimate` is labeled `confidence: "low"`.
2. **`estimated_runtime_min` is a sanity cap:** the API limits it to `capped_at_min` (600 min). If it comes equal
   to the cap, present it as "≥ 10 h (extrapolation)" instead of false precision.
3. **Battery is per protocol:** on the SMS the percentage is **reported by the equipment**; on the TS Shara it is
   **estimated** from voltage (§6.2). The `normalized`/`deltas` already normalize both — but the origin label
   remains different.
4. **An atypical `finish_reason` means an abnormal window:** show the reason. `duration_elapsed` and
   `target_percent_reached` are the **normal** endings; `aborted`, `battery_low`, `watchdog`,
   `test_flag_cleared`, `stopping`, `serial_error` are **not**.
5. **Live charts:** during `running`, `samples[]` already comes partial — draw the curve in real time; on
   long tests (`discharge_20pct`), append only the new samples (compare `samples_count`).

The complete script of **how to apply** all of this in the component (quadrant state machine, scales,
edge cases) is in [battery-test-quadrant.md](battery-test-quadrant.md).

### 11.6 Implementation checklist in the Web Viewer

| # | Action | Where (suggestion) | Mandatory? |
|---|---|---|---|
| 1 | Read `capabilities.battery_test` from `/api/v1/ups` and enable the quadrant only with `enabled: true` | `contract.ts`/`apiClient.ts` + panel component | **Yes** |
| 2 | Type selector restricted to `test_types` (`duration_10s`; `discharge_20pct` only where it exists) | quadrant component | **Yes** |
| 3 | `POST .../tests` (with the chosen `type`) and handle `202`/errors from §11.4 | `apiClient.ts`/`dashboard.ts` | **Yes** |
| 4 | Polling of `report_url` every `poll_interval_s` (0.5 s), stopping on `completed`/`aborted`/`failed` | same | **Yes** |
| 5 | The 4 charts from `samples[].normalized` (see §11.5) | new component (e.g., `BatteryTestCharts.tsx`) | **Yes** |
| 6 | Summary with the mappings from §11.5 (drop, oscillation, temperature, charge, runtime) | same | **Yes** |
| 7 | **Cancel** button only when `abort_supported: true` | same | Recommended |
| 8 | Cooldown/target warning before the click (`cooldown_s`, `min_battery_percent`) | same | Recommended |
| 9 | Chart/sparkline of the window from `samples[]` (incremental update) | same | Recommended |
| 10 | History/trend from `GET .../tests` | same | Optional |

> A new *endpoint* in the Web Viewer backend is **not** required for the test to start working: it
> can talk directly to the `upsmon` API (same `UPS_API_BASE_URL`). If the viewer prefers to keep all
> traffic behind its own backend (CORS/proxy), expose a thin route that forwards the calls — the contract
> above does not change.
