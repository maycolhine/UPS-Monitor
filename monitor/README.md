# `upsmon` — Unified UPS REST API

Local **multi-device** and **multi-protocol** collector with an HTTP/REST API: **one
process**, **one HTTP port** and **N devices**, addressed by `/api/v1/ups/{device_id}`. The API is
**read-only** for telemetry and exposes **a single write command** — the **battery test**
(`POST .../tests`, enabled per device), in two types: `duration_10s` (~10 s) and `discharge_20pct`
(controlled discharge down to 20%). It produces a **predictability report** with a sampled
**timeline** (load drop, output voltage/frequency oscillation, temperature variation, UPS load and
estimated runtime).

**Reference host:** Ubuntu 24.04.5 LTS, Python 3.12, with `pyserial` as the only external
dependency.

---

## Monitored devices

| `device_id` | Brand / Model | Protocol | Transport | Device port |
|---|---|---|---|---|
| `tsshara-3200va-01` | TS Shara Universal UPS Senoidal 3200VA | `megatec-q1` (ASCII text) | USB CDC-ACM `0483:5740` | `/dev/ttyACM0` |
| `sms-ups3200s-01` | SMS Power Sinus NG uPS3200S | `sms-1phase` (binary) | USB-Serial `067b:23d3` | `/dev/ttyUSB0` |

## Quick start

```bash
cd monitor

python3 -m upsmon --config /etc/upsmon/upsmon.conf --list     # configured devices
python3 -m upsmon --config /etc/upsmon/upsmon.conf --check    # one collection per device (JSON)
python3 -m upsmon --config /etc/upsmon/upsmon.conf            # starts the API (default 127.0.0.1:8080)

# without an installed configuration, use the repository example:
python3 -m upsmon --config config/examples/upsmon.conf --list
```

```bash
curl -s http://127.0.0.1:8080/health | python3 -m json.tool
curl -s http://127.0.0.1:8080/api/v1/ups | python3 -m json.tool
curl -s http://127.0.0.1:8080/api/v1/ups/tsshara-3200va-01/telemetry | python3 -m json.tool
curl -s http://127.0.0.1:8080/api/v1/ups/sms-ups3200s-01/telemetry   | python3 -m json.tool
```

Single dependency:

```bash
sudo apt install python3-serial
sudo usermod -aG dialout "$USER"     # /dev/ttyACM0 and /dev/ttyUSB0
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Availability of the application and of each device (`ok` / `degraded` / `down`) |
| `GET` | `/api/v1` | Contract index |
| `GET` | `/api/v1/ups` | All configured devices (includes `capabilities.battery_test`) |
| `GET` | `/api/v1/ups/{device_id}/telemetry` | Last valid telemetry + collection state |
| `GET` | `/api/v1/ups/{device_id}/identity` | Identification and nominal ratings |
| `POST` | `/api/v1/ups/{device_id}/tests` | Triggers the **battery test** (`type`: `duration_10s` \| `discharge_20pct`) → `202` + `test_id` |
| `GET` | `/api/v1/ups/{device_id}/tests` | Summarized history (last N, in memory) |
| `GET` | `/api/v1/ups/{device_id}/tests/{test_id}` | Test report (partial while `running`) |
| `POST` | `/api/v1/ups/{device_id}/tests/{test_id}/abort` | Aborts an in-progress test → `202` |

The telemetry `GET` routes are **read-only**; the `POST` routes only **validate preconditions and
enqueue** the request — the collector loop is what talks to the serial port (the project's golden
rule). Any other `POST`/`PUT`/`PATCH`/`DELETE` receives **405**.
Full contract, HTTP codes, JSON envelope, battery test and communication states:
**[docs/unified-api.md](docs/unified-api.md)**.

## Structure

```text
monitor/
├── README.md                       # this index
├── docs/unified-api.md             # API contract, architecture, configuration and migration
├── docs/web-viewer-integration.md  # integration with the Web Viewer (same repository, Docker)
├── upsmon/                         # application (standard library + pyserial)
│   ├── config.py                   # [upsmon] section + [device:*] blocks, precedence and validation
│   ├── models.py                   # common JSON contract envelope
│   ├── serial_link.py              # serial transport: auto-detection by VID:PID + exclusive lock
│   ├── collector.py                # one collector (thread) per device, in-memory state + battery test execution
│   ├── http_api.py                 # multi-device HTTP/REST layer (telemetry + battery test)
│   ├── cli.py                      # python3 -m upsmon (--config --list --check)
│   └── drivers/
│       ├── megatec_q1.py           # TS Shara (Megatec/Q1)
│       └── sms_1phase.py           # SMS (Brazil 1Phase)
├── config/examples/                # upsmon.conf, upsmon-api.service and 99-upsmon.rules
├── scripts/                        # run_api.py, monitor_collector.py and install_service.sh
└── tests/                          # 97 automated tests (unittest, no hardware)
```

## Web Viewer (same repository, Docker)

The consumer of the API is the **Web Viewer** shipped in this same repository
(`src/backend` + `src/frontend`, Node/React in Docker). Everything
it needs to know to consume this API — device selection, multi-device `/health`, per-protocol fields,
flags and gauges — is in
**[docs/web-viewer-integration.md](docs/web-viewer-integration.md)**.

The **battery test** (new in contract `3.0`) is triggered by the Web Viewer (`POST .../tests` +
report polling) in **two types**: `duration_10s` (fixed window, all protocols) and `discharge_20pct`
(controlled discharge down to 20% — **only** where the protocol can cancel the test, today the SMS).
The specification is in:

- **[docs/web-viewer-integration.md §11](docs/web-viewer-integration.md#11-battery-test-new-in-contract-30)**
  — the button, the input/output mapping and the compatibility checklist;
- **[docs/battery-test-api-contract.md](docs/battery-test-api-contract.md)** — **how the data is
  sent** (layout of `samples[]`/`normalized`, the two types, flow and the four charts);
- **[docs/battery-test-quadrant.md](docs/battery-test-quadrant.md)** — **how to apply** that data in
  the *Battery Test quadrant*.

## systemd service

```bash
cd monitor
sudo scripts/install_service.sh
journalctl -u upsmon-api -f
```

The unit is named **`upsmon-api.service`** (not `upsmon.service`, which **already belongs to NUT**). It
keeps `Restart=always` and `StartLimitIntervalSec=0`: a cable missing at boot does not exhaust the
attempts, and a transient error restarts the service. The udev rule restarts the service when
**either** of the cables is reconnected.

## Tests

```bash
cd monitor
python3 -m unittest discover -s tests -t . -v     # 97 tests, no hardware
```

## Ports and migration

| Service | Port | Status |
|---|---|---|
| **`upsmon-api`** (unified) | **8080** | supported mode — serves both devices |
| `ts-shara-api` (isolated TS Shara) | 8081 | legacy; **cannot** run alongside (exclusive serial port lock) |
| SMS `run_api.py` (isolated) | 8082 | legacy; **cannot** run alongside |

Because the serial port has an **exclusive lock**, the old services must stay disabled while
`upsmon-api` runs. The full procedure (with *rollback*) is in
[docs/unified-api.md §8](docs/unified-api.md#8-migration-from-per-device-apis).

> **Security:** the telemetry `GET` routes only read (`Q1`/`I`/`F` on Megatec; `Q`/`I`/`F` on SMS). The
> **only** write command implemented is the **battery test** (`T` on Megatec; `T`/`D` on SMS), and
> only when `allow_battery_test = true` on the device. `discharge_20pct` (20% target) exists
> **only** on the SMS, which knows how to cancel the test. The other action commands (`TL`/`S`/`M`/`L`/`C`/`R`) are
> **not** implemented in any layer.
