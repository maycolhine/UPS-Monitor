# UPS Monitor

A single repository that unifies the two halves of the UPS monitoring stack:

1. **`monitor/` — the telemetry service.** A local Python collector that discovers and reads UPS
   units connected over USB serial on a Linux host, interprets each device's protocol and publishes
   the measurements through a **read-only HTTP/REST API** (one process, one HTTP port, N devices).
2. **`src/` — the Web Viewer.** A Node/Express backend plus a React/TypeScript dashboard that
   consumes that API, validates its contract and presents the telemetry in a dark, four-quadrant
   control-room interface, distributed as a Docker image.

The dashboard can also request a **battery test** on a device — strictly on the operator's explicit
action — and display its report. Nothing else on the API is writable.

- Architecture: [docs/architecture.md](./docs/architecture.md)
- Consumed API contract: [docs/api-contract.md](./docs/api-contract.md)
- Technical decisions: [docs/technical-decisions.md](./docs/technical-decisions.md)
- Tests: [docs/tests.md](./docs/tests.md)
- Docker operation: [docs/docker-operation.md](./docs/docker-operation.md)
- Visual identity: [docs/design-system.md](./docs/design-system.md)
- Monitor service API: [monitor/docs/unified-api.md](./monitor/docs/unified-api.md)

> **Current status:** validated with UPS units from **two brands/protocols** — TS Shara Universal
> UPS Senoidal 3200VA (`tsshara-3200va-01`, USB CDC-ACM `/dev/ttyACM0`, Megatec/Q1) and SMS Power
> Sinus NG uPS3200S (`sms-ups3200s-01`, USB-Serial, `sms-1phase`). The project does not depend on
> these models: devices are discovered through `GET /api/v1/ups`, the interface lets you pick **one**
> at a time, and every field is read from the contract with no hardcoded names. The viewer consumes
> the unified API's **contract 3.0** (multi-device + battery test).

---

## 1. Architecture at a glance

```
UPS units (N) ── USB ──▶ Ubuntu host (monitor/ telemetry service)
                         per-protocol drivers → in-memory telemetry → REST API (v1 / 3.0)
                                                                      │ HTTP GET + POST (battery test)
                                                                      ▼
                                        Web Viewer container (src/)
                                        ┌──────────────────────────────────────────┐
   browser ── HTTP ──▶ :8090 ──────────▶│ backend (Node/Express)                    │
                                        │  • validates the contract                 │
                                        │  • read-through proxy (solves CORS)       │
                                        │  • serves /api/config, /api/dashboard     │
                                        │  • serves the built interface (same       │
                                        │    origin: no API address is exposed)     │
                                        └──────────────────────────────────────────┘
```

The browser talks **only** to the viewer backend, on the same origin. The container is what talks to
the telemetry API — that is why there is no CORS and the API address never reaches the browser.

The Web Viewer **does not** touch the serial port, does not implement the UPS protocols, does not run
the collector and **does not send commands to the UPS**: the only write request it makes is forwarded
to the telemetry API, which is the only component that commands the hardware. **No test is ever
triggered automatically.**

## 2. Repository structure

```
UPS Monitor/
├── README.md                      # this file
├── docs/                          # viewer architecture, contract, design, decisions, tests, operation
├── .trae/rules/                   # project context rules for the assistant
├── src/                           # Web Viewer (npm workspaces)
│   ├── backend/                   # read-through proxy + contract validation + interface server
│   │   ├── src/                   # contract, apiClient, dashboard, config, server, logger
│   │   └── tests/                 # contract, HTTP client, service and server tests
│   └── frontend/                  # React + TypeScript dashboard (Vite)
│       ├── src/
│       │   ├── api/               # same-origin HTTP client
│       │   ├── components/        # SVG gauges, cards, header, flags, details, notices
│       │   ├── demo/              # SIMULATED data (development only)
│       │   ├── hooks/             # periodic refresh
│       │   ├── model/             # contract, formatting, metrics, states
│       │   └── styles/
│       └── tests/                 # model, notices and HTTP client tests
├── monitor/                       # telemetry service (Python)
│   ├── upsmon/                    # application package (standard library + pyserial)
│   ├── config/examples/           # upsmon.conf, systemd unit and udev rule
│   ├── scripts/                   # run_api.py, monitor_collector.py, install_service.sh
│   ├── tests/                     # automated tests (unittest, no hardware)
│   └── docs/                      # unified API contract and Web Viewer integration
├── SMS/                           # legacy reference base — SMS Power Sinus NG uPS3200S
├── TS_Shara/                      # legacy reference base — TS Shara Universal UPS Senoidal 3200VA
├── scripts/discovery/             # serial discovery probe used during bring-up
├── Dockerfile                     # multi-stage build
├── compose.yaml
├── .dockerignore
├── .env.example
└── package.json                   # npm workspaces root (backend + frontend)
```

## 3. Monitored devices

| `device_id` | Brand / Model | Protocol | Transport | Device port |
|---|---|---|---|---|
| `tsshara-3200va-01` | TS Shara Universal UPS Senoidal 3200VA | `megatec-q1` (ASCII text) | USB CDC-ACM `0483:5740` | `/dev/ttyACM0` |
| `sms-ups3200s-01` | SMS Power Sinus NG uPS3200S | `sms-1phase` (binary) | USB-Serial `067b:23d3` | `/dev/ttyUSB0` |

Battery percentage is handled per protocol: in `megatec-q1` it is **estimated** from the battery
voltage (`linear_regression_trimmed`), while in `sms-1phase` it is **reported by the equipment**.

## 4. Requirements

| Scope | Requirements |
|---|---|
| Web Viewer in production | Docker Engine 24+ and Docker Compose v2 |
| Web Viewer local development | Node.js 20 LTS (>= 18.19) and npm 10+ |
| Telemetry service (`monitor/`) | Ubuntu 24.04 LTS, Python 3.12 and `pyserial` (the only external dependency) |
| Consumed telemetry API | Reachable over the network, serving contract `v1` / `contract_version` `3.0` (unified API, N UPS units) |

## 5. Quick start

### 5.1 Start the telemetry API (`monitor/`)

```bash
cd monitor

# Single external dependency (a privileged command — run it in your terminal):
sudo apt install python3-serial
sudo usermod -aG dialout "$USER"      # grants access to /dev/ttyACM0 and /dev/ttyUSB0

# Inspect and start the service:
python3 -m upsmon --config config/examples/upsmon.conf --list      # configured devices
python3 -m upsmon --config config/examples/upsmon.conf --check     # one collection per device (JSON)
python3 -m upsmon --config config/examples/upsmon.conf             # starts the API (default 127.0.0.1:8080)
```

```bash
curl -s http://127.0.0.1:8080/health                                    | python3 -m json.tool
curl -s http://127.0.0.1:8080/api/v1/ups                                | python3 -m json.tool
curl -s http://127.0.0.1:8080/api/v1/ups/tsshara-3200va-01/telemetry    | python3 -m json.tool
```

To run it as a background service:

```bash
cd monitor
sudo scripts/install_service.sh
journalctl -u upsmon-api -f
```

### 5.2 Run the Web Viewer with Docker (recommended)

```bash
cp .env.example .env          # adjust UPS_API_BASE_URL (and, if desired, the published port)
docker compose up --build -d
docker compose logs -f
```

Open `http://<host-ip>:8090` (the port is configurable through `VIEWER_HTTP_PORT`). To stop:

```bash
docker compose down
```

Details, diagnostics and troubleshooting: [docs/docker-operation.md](./docs/docker-operation.md).

#### `localhost` inside the container

Inside the container, `localhost` and `127.0.0.1` point to the **container itself**, never to the
Ubuntu host that owns the USB cable. `compose.yaml` already registers
`host.docker.internal:host-gateway`, so the default
`UPS_API_BASE_URL=http://host.docker.internal:8080` works as long as the API listens on all
interfaces:

```bash
cd monitor
python3 scripts/run_api.py --http-host 0.0.0.0 --http-port 8080
```

### 5.3 Local development of the Web Viewer

```bash
npm install                     # installs the workspaces (backend + frontend)
npm test                        # backend and frontend tests
npm run build                   # builds backend (tsc) and frontend (vite build)
```

Two terminals:

```bash
# terminal 1 — backend at http://127.0.0.1:8181
VIEWER_HTTP_PORT=8181 UPS_API_BASE_URL=http://127.0.0.1:8080 npm run dev:backend

# terminal 2 — interface at http://127.0.0.1:5173 (proxying to the backend)
npm run dev:frontend
```

Vite proxies `/api` and `/healthz` to `VIEWER_BACKEND_URL` (default `http://127.0.0.1:8181`).

To preview the layout **without** the API, `src/frontend/.env.development` sets
`VITE_ENABLE_DEMO=true`. In that mode the interface shows a **DEMO MODE** banner and the values are
simulated — they are never presented as real telemetry. Outside development mode the variable does
not exist and demo mode stays off.

## 6. Configuration

Every Web Viewer variable is documented in [.env.example](./.env.example). Summary:

| Variable | Default | Purpose |
|---|---|---|
| `VIEWER_HTTP_PORT` | `8080` in the container / `8090` on the host | HTTP port of the service |
| `VIEWER_HTTP_HOST` | `0.0.0.0` | Listening interface |
| `VIEWER_STATIC_DIR` | — | Built interface directory (set in the image) |
| `UPS_API_BASE_URL` | `http://host.docker.internal:8080` (Docker) / `http://127.0.0.1:8080` (local) | Base address of the telemetry API |
| `UPS_DEVICE_ID` | empty | Pins a device; empty = discovered through `GET /api/v1/ups` |
| `UPS_API_TIMEOUT_MS` | `4000` | Timeout of each API request |
| `UPS_API_CACHE_TTL_MS` | `1500` | Short in-memory telemetry cache |
| `UPS_API_IDENTITY_TTL_MS` | `60000` | Cache of the device identification |
| `VIEWER_REFRESH_INTERVAL_MS` | `5000` | Interface refresh interval |
| `VIEWER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `VIEWER_GAUGE_THRESHOLDS` | empty | JSON overriding the **default validated** gauge bands |

Invalid values (out-of-range number, malformed URL, incoherent JSON) are **not** silently accepted:
the configuration terminates the process with exit code `2`, and diverging bands are reported through
`threshold_problems` in the interface.

The telemetry service is configured through `monitor/config/examples/upsmon.conf` (a `[upsmon]`
section plus one `[device:*]` block per UPS). See
[monitor/docs/unified-api.md](./monitor/docs/unified-api.md).

## 7. APIs

### 7.1 Telemetry service (`monitor/`) — unified multi-device API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Availability of the application and of each device (`ok` / `degraded` / `down`) |
| `GET` | `/api/v1` | Contract index |
| `GET` | `/api/v1/ups` | All configured devices (includes `capabilities.battery_test`) |
| `GET` | `/api/v1/ups/{device_id}/telemetry` | Last valid telemetry + collection state |
| `GET` | `/api/v1/ups/{device_id}/identity` | Identification and nominal ratings |
| `POST` | `/api/v1/ups/{device_id}/tests` | Starts the **battery test** (`type`: `duration_10s` \| `discharge_20pct`) → `202` + `test_id` |
| `GET` | `/api/v1/ups/{device_id}/tests` | Summarized history (last N, in memory) |
| `GET` | `/api/v1/ups/{device_id}/tests/{test_id}` | Test report (partial while `running`) |
| `POST` | `/api/v1/ups/{device_id}/tests/{test_id}/abort` | Aborts an in-progress test → `202` |

The telemetry `GET` routes are **read-only**; the `POST` routes only **validate preconditions and
enqueue** the request — the collector loop is what talks to the serial port. Any other
`POST`/`PUT`/`PATCH`/`DELETE` receives **405**. Full contract:
[monitor/docs/unified-api.md](./monitor/docs/unified-api.md).

### 7.2 Web Viewer (`src/`)

Only `GET`, except the battery-test routes (`/api/tests*`), which also accept `POST` — only after an
operator action. Any other method receives `405` with
`{"error":{"code":"method_not_allowed", ...}}`.

| Endpoint | Description |
|---|---|
| `GET /healthz` | Health of the **container** (does not depend on the telemetry API) |
| `GET /api/config` | Name, version, refresh interval, gauge definitions and band warnings |
| `GET /api/dashboard` | Validated snapshot: `viewer`, `health`, `devices`, `telemetry`, `identity`, `tests`. `?device_id=` selects **one** UPS (absent → the backend resolves the default) |
| `GET /api/devices` | Device list (`GET /api/v1/ups` forwarded, with `capabilities.battery_test`) |
| `POST /api/tests` | Requests the battery test (`?device_id=`, body `{"type":"duration_10s"}` or `{"type":"discharge_20pct"}` — only the types the device declares in `test_types`); replies `202` with the acknowledgement — **not** the result |
| `GET /api/tests/{test_id}` | Test report (partial while `running`) |
| `POST /api/tests/{test_id}/abort` | Cancellation, when the device declares `abort_supported` |

`/api/dashboard` status codes: `200` (usable data, even when the API replied `503` with missing/stale
telemetry — the real state comes in `stale`, `telemetry_valid` and `communication.state`), `404`
(`device_not_found`, `no_devices_configured`), `502` (`upstream_unreachable`, `upstream_timeout`,
`upstream_invalid_json`, `upstream_unexpected_status`, `upstream_contract_mismatch`), `500`
(`viewer_internal_error`).

Full contract: [docs/api-contract.md](./docs/api-contract.md).

### 7.3 Battery test (contract 3.0)

The battery test is requested by the Web Viewer (`POST .../tests` + report polling) in **two types**:
`duration_10s` (fixed ~10 s window, all protocols) and `discharge_20pct` (controlled discharge down
to 20%, capped at 30 min — **only** where the protocol can cancel the test, today the SMS). The
specification is in:

- [monitor/docs/web-viewer-integration.md](./monitor/docs/web-viewer-integration.md) — the button, the input/output mapping and the compatibility checklist;
- [monitor/docs/battery-test-api-contract.md](./monitor/docs/battery-test-api-contract.md) — **how the data is sent** (layout of `samples[]`/`normalized`, the two types, flow and the four charts);
- [monitor/docs/battery-test-quadrant.md](./monitor/docs/battery-test-quadrant.md) — **how to apply** that data in the *Battery Test quadrant*.

## 8. Inviolable rules

1. **Read-only — with one controlled exception.** No `PUT`/`PATCH`/`DELETE` is sent to the upstream
   API. The only `POST` is the **battery test**, behind the viewer backend and only on operator
   action; no command is sent directly to the UPS and no test is ever triggered on its own.
2. **Contract fidelity.** Field names, units and JSON paths are the API's. Nothing is renamed or
   reinterpreted.
3. **`null` never becomes `0`.** A missing field stays missing and is shown as "No data".
4. **Stale is not current.** A `stale` reading is displayed with the "Stale" label.
5. **Battery — rule per protocol.** In `megatec-q1`, `data.battery_charge.percent` is an **estimate**
   (voltage interpolation) and the battery voltage appears as a separate measurement; in
   `sms-1phase`, `data.battery.charge_percent` is **reported by the equipment** and is **not** an
   estimate.
6. **No inference of "mains normal".** The absence of the `OB` flag is not presented as normal mains.
7. **Color is never the only signal.** Every gauge and every notice combines color + value + text.
8. **Validated, configurable bands.** The red/amber/green limits were validated by the requester
   (2026-10-21), but are **not** official manufacturer recommendations and remain overridable
   through `VIEWER_GAUGE_THRESHOLDS`.
9. **No versioned secrets.** The upstream API does not authenticate; no token is used.
10. **The API delivers facts; the Web Viewer presents them.** Test autonomy is the extrapolation
    published by the API, marked `confidence: "low"`. When `estimate.available` is `false`, the
    interface shows the `reason` — it **never** turns the absence into a number.

## 9. Tests

| Suite | Command | Tests |
|---|---|---|
| Web Viewer backend | `npm run test:backend` | 80 |
| Web Viewer frontend | `npm run test:frontend` | 91 |
| Telemetry service | `cd monitor && python3 -m unittest discover -s tests -t .` | 97 |
| Legacy base — SMS | `cd SMS/Power_Sinus_NG_uPS3200S && python3 -m unittest discover -s tests -t .` | 48 |
| Legacy base — TS Shara | `cd TS_Shara/Universal_UPS_Senoidal_3200VA && python3 -m unittest discover -s tests -t .` | 46 |

All suites run **without hardware**. Details: [docs/tests.md](./docs/tests.md).

## 10. Legacy reference bases

The `SMS/` and `TS_Shara/` directories preserve the original per-device collectors and their isolated
REST APIs. They are kept as **reference and rollback** material; the supported mode is the unified
`monitor/` API. Because the serial port has an **exclusive lock**, the isolated services must stay
disabled while `upsmon` runs.

| Service | Port | Status |
|---|---|---|
| `upsmon-api` (unified) | 8080 | supported mode — serves both devices |
| TS Shara isolated API | 8081 | legacy; **cannot** run alongside |
| SMS isolated API | 8082 | legacy; **cannot** run alongside |

Each base keeps its own documentation: `SMS/Power_Sinus_NG_uPS3200S/docs/` and
`TS_Shara/Universal_UPS_Senoidal_3200VA/docs/`.

## 11. Known limitations

- **Gauge bands:** validated for the known fleet; for a different model/brand, adjust them through
  `VIEWER_GAUGE_THRESHOLDS`.
- **Identification:** shown only when the API publishes `identity`; missing fields appear as "—".
- **History:** out of scope for this version (current reading only). The **battery-test** history
  exists, but it lives in memory in the upstream API and is lost when the service restarts.
- **"Services powered by the UPS":** not implemented yet — it will be mapped manually (e.g. server,
  firewall, routers) and displayed **below** the "Operational state" block.
- **Style documentation:** scope §4.1 and rule `30-ui-ux` still describe a white background; the
  interface adopts the dark four-quadrant stage (decision D16 in
  [docs/technical-decisions.md](./docs/technical-decisions.md)).

## 12. License

UNLICENSED — internal project. See `package.json`.
