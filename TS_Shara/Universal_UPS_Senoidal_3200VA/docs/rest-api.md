# UPS telemetry REST API (v2.0)

Local collector + **read-only** HTTP/REST API that exposes the **last valid telemetry** of the
TS Shara UPS (Megatec/Q1 over USB CDC-ACM) as **versioned JSON**.

- **Goal:** turn the serial reading into a service consumable over HTTP, so the consumer does not need to
  know the serial port, the protocol or the device configuration file.
- **Scope:** collection, protocol interpretation, in-memory state and REST API. It does **not** include a web
  application, a database, control commands, Docker or definitive Zabbix integration (later stages).
- **Evidence for this version:** 2026-10-21, the lab host (Ubuntu 24.04.5 LTS), unit
  `tsshara-3200va-01` on `/dev/ttyACM0`.

---

## 1. Data flow

```text
TS Shara UPS (3200VA)
      |  USB CDC-ACM 0483:5740  ->  /dev/ttyACM0  (2400 8N1, <CR>)
      v
serial_link.py      accesses the port (only component with serial access; exclusive lock)
      v
protocol.py         sends Q1 and interprets the Megatec/Q1 frame (pure functions, no I/O)
      v
models.py           standardized telemetry model (explicit units, ISO 8601 UTC)
      v
collector.py        in-memory state: last valid reading + communication metadata
      v
http_api.py         GET /health, /api/v1/...  (no request triggers a serial reading)
      v
HTTP consumers (Zabbix, scripts, dashboards)
```

**Structural rules**

1. Only the `api/serial_link.py` module touches the serial port, always in **read mode**.
2. The collector runs the queries every `poll_interval_s` (default **5 s**) and keeps the last valid reading.
3. An HTTP request **never** triggers a new serial reading: the handlers read only the in-memory state.
4. There is no database or telemetry file: restarting the service loses the history (by design).
5. Communication failures do **not** generate fictitious values: the `data` field exists only if there was a valid reading.

## 2. Requirements and installation

| Item | Requirement |
|---|---|
| System | Linux with `/dev/ttyACM*` (validated on Ubuntu 24.04.5 LTS) |
| Python | 3.8+ (validated on 3.12.3) |
| External dependency | **`pyserial`** (`python3-serial`). Everything else uses the standard library |
| Permissions | service user in the `dialout` group (or an equivalent udev rule) |
| Port | UPS USB accessible to the host (the service must run **on** the host that has the cable) |

```bash
sudo apt install python3-serial                 # only dependency
sudo usermod -aG dialout "$USER"                # read/write permission on /dev/ttyACM0
```

Prior device check (optional, read-only):

```bash
python3 ../../scripts/discovery/probe_serial.py
```

> `ModemManager` must ignore the device (udev rule — see
> [nut-installation-and-configuration.md](nut-installation-and-configuration.md)); it injects `AT` commands that
> corrupt the port. With the exclusive lock (`serial_exclusive = true`), the API detects the conflict and reports
> `port_unavailable` instead of reading garbage.

## 3. Running

### 3.1 Service mode (continuous)

```bash
cd TS_Shara/Universal_UPS_Senoidal_3200VA
python3 -m api --config /etc/ts-shara-api/ts_shara_api.conf
# equivalent: python3 scripts/run_api.py --config ...
```

The service listens on `http_host:http_port` (default **127.0.0.1:8081**) and logs the active endpoints.
It shuts down cleanly on `SIGINT`/`SIGTERM`.

### 3.2 Verification mode (one collection, without starting the API)

```bash
python3 scripts/run_api.py --check
```

Runs **one** collection cycle, prints the contract JSON to `stdout` and exits.
Logs go to `stderr`, so the output is safe for pipes (`| python3 -m json.tool`) and scripts.
Exit codes: `0` = valid telemetry (equivalent to HTTP 200), `3` = no valid telemetry (`503`),
`2` = configuration error, `1` = failure to listen on the HTTP port.

### 3.3 systemd service (recommended mode for production)

The supported way to keep the API **always up** is the `ts-shara-api` service. Installation is done by a
script that copies the unit, the configuration and the udev rule, adjusting the user and the project folder
for the host:

```bash
cd TS_Shara/Universal_UPS_Senoidal_3200VA
sudo scripts/install_service.sh
```

The script ([`scripts/install_service.sh`](../scripts/install_service.sh)) does:

1. installs `/etc/systemd/system/ts-shara-api.service`
   ([example](../config/examples/ts-shara-api.service)) — `Restart=always`, `RestartSec=5` and
   `StartLimitIntervalSec=0`, i.e. **the service is restarted indefinitely** if it crashes, and a cable
   missing at boot does not exhaust the attempts;
2. installs `/etc/ts-shara-api/ts_shara_api.conf` (preserves an existing configuration);
3. installs `/etc/udev/rules.d/99-ts-shara-ups.rules`
   ([rule](../config/examples/99-ts-shara-ups.rules)) — `dialout` permission, `ModemManager` ignoring the
   device and **automatic restart of the service when the cable is reconnected**;
4. `systemctl daemon-reload`, `udevadm --reload-rules/--trigger` and `systemctl enable --now ts-shara-api`.

> **Note on the path with spaces:** systemd unit files do **not** use quotes
> (`WorkingDirectory` reads the whole value up to the end of the line) and the `%` sign must be escaped as `%%`
> (that is why the `Documentation` URL uses `%%20` in place of the space). The script already generates the
> file that way.

Equivalent manual installation and monitoring:

```bash
sudo install -m 0644 config/examples/ts-shara-api.service /etc/systemd/system/
sudo install -d /etc/ts-shara-api
sudo install -m 0640 config/examples/ts_shara_api.conf /etc/ts-shara-api/
sudo install -m 0644 config/examples/99-ts-shara-ups.rules /etc/udev/rules.d/
sudo systemctl daemon-reload && sudo udevadm control --reload-rules && sudo udevadm trigger
sudo systemctl enable --now ts-shara-api
systemctl status ts-shara-api --no-pager
journalctl -u ts-shara-api -f
```

### 3.4 Behavior without the USB cable (availability control)

**The service does not stop when the USB is disconnected.** The collector keeps retrying every
`poll_interval_s`, and the API stays up so that the consumer can **distinguish** "API down"
from "UPS without communication":

| Situation | HTTP | Where it appears |
|---|---|---|
| USB connected and reading | `/health` **200** (`status=ok`), `/telemetry` **200** | `communication.state = ok` |
| Cable removed or port missing/busy | `/health` **503** (`degraded`), `/telemetry` **503** with `data = null` | `state = disconnected` or `port_unavailable` + `last_error` |
| Cable removed **after** a valid reading | `/telemetry` **503** | last reading preserved and marked `stale`; `last_success_utc` kept |
| Cable reconnected | back to **200** | autodetection by VID:PID reopens the port; the udev rule also restarts the service |

- `/api/v1/ups` keeps answering **200** with the failure's `communication_state` — the consumer discovers the
  device and sees the reason for the unavailability.
- `GET /health` exposes `checks.serial_communication` (`ok`, `port_unavailable`, `disconnected`, `timeout`, …)
  for direct use as *readiness/liveness* (e.g. `curl -fsS http://127.0.0.1:8081/health`).
- No fictitious value is published: without a valid reading, `data` is `null`.

## 4. Configuration

Precedence (the last one wins): **defaults** → **INI file** (`--config`, section `[ts_shara_api]`) →
**environment variables** (`TS_SHARA_API_<UPPERCASE_FIELD>`) → **command line**.

| Field | Default | Description |
|---|---|---|
| `device_id` | `tsshara-3200va-01` | Logical identifier used in the URLs (pattern brand-model-sequence) |
| `device_brand` | `TS Shara` | Brand shown in `/api/v1/ups` |
| `device_model` | `Universal UPS Senoidal 3200VA` | Model shown in `/api/v1/ups` |
| `protocol` | `megatec-q1` | Reading protocol (informational in the contract) |
| `transport` | `usb-serial-cdc-acm` | Physical transport (informational in the contract) |
| `serial_port` | *(empty)* | Empty = autodetect by `usb_vendor_id`:`usb_product_id` |
| `serial_baud` | `2400` | Megatec nominal baud (the CDC-ACM port ignores the value) |
| `serial_timeout_s` | `1.0` | Port reading timeout |
| `serial_exclusive` | `true` | Exclusive lock: prevents two processes on the port |
| `command_wait_s` | `0.4` | Wait between sending the command and reading the response |
| `usb_vendor_id` / `usb_product_id` | `0483` / `5740` | VID:PID of the STM32 Virtual ComPort |
| `poll_interval_s` | `5.0` | Interval between collection cycles |
| `stale_after_s` | `20.0` | Age from which the reading is considered outdated |
| `identity_refresh_s` | `3600.0` | Re-read interval of `I`/`F` (identification and nominal values) |
| `battery_voltage_low_v` | `20.1` | Battery voltage corresponding to 0 % (calibration — `Spec.md` §7.3.4) |
| `battery_voltage_high_v` | `26.8` | Battery voltage corresponding to 100 % (calibration — `Spec.md` §7.3.4) |
| `http_host` | `127.0.0.1` | Listening interface (IP of the machine itself) |
| `http_port` | `8081` | API TCP port |
| `log_level` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |
| `log_file` | *(empty)* | Empty = log to `stderr` (systemd collects it in the journal) |

Example file: [`config/examples/ts_shara_api.conf`](../config/examples/ts_shara_api.conf).

Command-line options: `--config --port --baud --device-id --interval --stale-after --http-host
--http-port --log-level --log-file --check`.

The configuration is validated at startup; inconsistent values (e.g. `stale_after_s < poll_interval_s`)
terminate the process with exit code `2` and a message on `stderr`.

## 5. Endpoints

| Method | Path | Response |
|---|---|---|
| GET | `/health` | Availability of the application, the collection loop and communication |
| GET | `/api/v1` | Contract index (available endpoints and versions) |
| GET | `/api/v1/ups` | Configured devices and their endpoints |
| GET | `/api/v1/ups/{device_id}/telemetry` | Last valid telemetry + collection state |
| GET | `/api/v1/ups/{device_id}/identity` | Device identification and nominal information |

Any other method (`POST`, `PUT`, `PATCH`, `DELETE`) answers **405** `method_not_allowed` — the API is
read-only and no command is sent to the UPS.

### 5.1 HTTP codes

| Code | When it occurs |
|---|---|
| `200` | Data available and sound (`/health` `status=ok`; valid and fresh telemetry; identity available) |
| `404` | Nonexistent path (`error.code = not_found`) or unconfigured `device_id` (`error.code = device_not_found`) |
| `405` | Method other than `GET` (`error.code = method_not_allowed`) |
| `503` | Application up, but no usable data: `/health` `degraded`/`down`, telemetry missing or **stale**, identity unavailable |

The three planes stay **separate** in the JSON, as required by the project:

- **application availability** → `checks.process` and `checks.collector_thread`;
- **validity/freshness of the last reading** → `telemetry_valid`, `stale`, `age_seconds`, `checks.telemetry_freshness`;
- **communication state with the UPS** → `communication.state`, `communication.last_error`.

### 5.2 Real examples (2026-10-21, unit connected)

`GET /health` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "status": "ok",
  "checked_at_utc": "2026-10-21T15:22:04.962Z",
  "uptime_seconds": 16.255,
  "device_id": "tsshara-3200va-01",
  "checks": {
    "process": "ok",
    "collector_thread": "ok",
    "serial_communication": "ok",
    "telemetry_freshness": "ok",
    "identity": "ok"
  },
  "collector": {
    "state": "ok",
    "telemetry_valid": true,
    "stale": false,
    "last_attempt_utc": "2026-10-21T15:22:03.711Z",
    "last_success_utc": "2026-10-21T15:22:00.112Z",
    "age_seconds": 4.85,
    "consecutive_failures": 0,
    "total_attempts": 4,
    "total_successes": 3,
    "last_error": null,
    "serial_port": "/dev/ttyACM0",
    "poll_interval_s": 5.0,
    "stale_after_s": 20.0
  }
}
```

`GET /api/v1/ups` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "count": 1,
  "devices": [
    {
      "device_id": "tsshara-3200va-01",
      "brand": "TS Shara",
      "model": "Universal UPS Senoidal 3200VA",
      "transport": "usb-serial-cdc-acm",
      "protocol": "megatec-q1",
      "serial_port": "/dev/ttyACM0",
      "communication_state": "ok",
      "telemetry_endpoint": "/api/v1/ups/tsshara-3200va-01/telemetry",
      "identity_endpoint": "/api/v1/ups/tsshara-3200va-01/identity"
    }
  ]
}
```

`GET /api/v1/ups/tsshara-3200va-01/telemetry` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "device_id": "tsshara-3200va-01",
  "telemetry_valid": true,
  "stale": false,
  "data_available": true,
  "data": {
    "captured_at_utc": "2026-10-21T15:22:00.112Z",
    "source": "megatec-q1",
    "measurements": {
      "input_voltage_v": 222.0,
      "input_voltage_fault_v": 222.0,
      "output_voltage_v": 112.0,
      "load_percent": 11,
      "input_frequency_hz": 60.0,
      "battery_voltage_v": 27.4,
      "temperature_c": 26.0
    },
    "battery_charge": {
      "percent": 100.0,
      "estimated": true,
      "method": "linear_voltage_interpolation",
      "calibration": { "voltage_low_v": 20.1, "voltage_high_v": 26.8 }
    },
    "status": {
      "raw_bits": "00001001",
      "active": ["STANDBY", "BEEP"],
      "flags": {
        "OB": false, "LB": false, "BOOST": false, "FAULT": false,
        "STANDBY": true, "TEST": false, "FSD": false, "BEEP": true
      }
    },
    "raw_frame": "(222.0 222.0 112.0 011 60.0 27.4 26.0 00001001",
    "age_seconds": 4.853
  },
  "communication": {
    "state": "ok",
    "telemetry_valid": true,
    "stale": false,
    "last_attempt_utc": "2026-10-21T15:22:03.711Z",
    "last_success_utc": "2026-10-21T15:22:00.112Z",
    "age_seconds": 4.853,
    "consecutive_failures": 0,
    "total_attempts": 4,
    "total_successes": 3,
    "last_error": null,
    "serial_port": "/dev/ttyACM0",
    "poll_interval_s": 5.0,
    "stale_after_s": 20.0
  }
}
```

`GET /api/v1/ups/{device_id}/identity` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "device_id": "tsshara-3200va-01",
  "identity_available": true,
  "data": {
    "captured_at_utc": "2026-10-21T15:21:48.710Z",
    "device": {
      "manufacturer": "TS -222  091225",
      "model": "Senoid  32",
      "firmware": "V01020805A",
      "raw_frame": "#TS -222  091225 Senoid  32 V01020805A"
    },
    "nominal": {
      "voltage_label": "Univ.",
      "voltage_v": null,
      "input_current_a": 100.0,
      "battery_voltage_v": 24.0,
      "frequency_hz": 60.0,
      "raw_frame": "#Univ. 100 24.00 60.0"
    }
  },
  "configured": {
    "device_id": "tsshara-3200va-01",
    "brand": "TS Shara",
    "model": "Universal UPS Senoidal 3200VA",
    "protocol": "megatec-q1",
    "transport": "usb-serial-cdc-acm",
    "serial_port": "/dev/ttyACM0",
    "serial_baud": 2400,
    "poll_interval_s": 5.0,
    "stale_after_s": 20.0
  },
  "communication": { "state": "ok", "age_seconds": 4.855, "last_error": null, "...": "..." }
}
```

`GET /api/v1/ups/nonexistent/telemetry` → **404**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "error": {
    "code": "device_not_found",
    "message": "device 'nonexistent' is not configured (available: tsshara-3200va-01)"
  }
}
```

`POST /api/v1/ups` → **405**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "error": {
    "code": "method_not_allowed",
    "message": "the API is read-only: use GET (no command is sent to the UPS)"
  }
}
```

## 6. JSON contract

### 6.1 Common envelope

All responses (including errors) carry `api_version` (`v1`) and `contract_version` (`1.0`).
Dates in **ISO 8601 UTC** with milliseconds and a `Z` suffix. Numbers with an **explicit unit in the field name**.

### 6.2 Measurements (`data.measurements`)

| Field | Unit | Origin (Q1 frame) | Note |
|---|---|---|---|
| `input_voltage_v` | V | field 1 | Input voltage |
| `input_voltage_fault_v` | V | field 2 | Input voltage for **fault indication** |
| `output_voltage_v` | V | field 3 | Output voltage |
| `load_percent` | % | field 4 | Load percentage |
| `input_frequency_hz` | Hz | field 5 | Input frequency |
| `battery_voltage_v` | V | field 6 | Battery voltage |
| `temperature_c` | °C | field 7 | Internal temperature |

### 6.3 States (`data.status`)

`raw_bits` preserves the 8 bits as received; `active` lists the flags that are on; `flags` carries all eight.

| Bit | Flag | Meaning |
|---|---|---|
| b7 | `OB` | Running on battery (*on battery*) |
| b6 | `LB` | Low battery (*low battery*) |
| b5 | `BOOST` | Low input voltage / boost |
| b4 | `FAULT` | Fault (*fault*) |
| b3 | `STANDBY` | Standby mode |
| b2 | `TEST` | Test in progress |
| b1 | `FSD` | Scheduled shutdown (*fail-safe shutdown*) |
| b0 | `BEEP` | Beeper alarm |

### 6.4 Battery charge estimation

`data.battery_charge` is **always** presented as an estimate — the Megatec/Q1 protocol **does not transmit** the
charge percentage; it is derived from the battery voltage by linear interpolation between
`voltage_low_v` (0 %) and `voltage_high_v` (100 %), clamped to 0–100 %.

```json
"battery_charge": {
  "percent": 100.0,
  "estimated": true,
  "method": "linear_voltage_interpolation",
  "calibration": { "voltage_low_v": 20.1, "voltage_high_v": 26.8 }
}
```

- `percent` is `null` when there is no valid battery voltage in the reading.
- The calibration used appears in the response itself, so the consumer knows what it is reading.
- Rationale: [Spec.md §7.3.4](../Spec.md).

### 6.5 Identification and nominal information (`/identity`)

- `data.device`: `manufacturer`, `model`, `firmware` (command `I`, fixed widths 15/10 — see `Spec.md`);
- `data.nominal`: `voltage_label`, `voltage_v`, `input_current_a`, `battery_voltage_v`, `frequency_hz`
  (command `F`). In `#Univ. ...` the label is not numeric, so `voltage_v` is `null` (no fictitious value);
- `configured`: logical identity, protocol, transport, port, `poll_interval_s` and `stale_after_s`;
- `raw_frame` in both preserves the original frame, for auditing.

## 7. Failure handling

The collector **classifies** every failure into a contract code and keeps the last valid reading (if any),
only marking it as outdated. It never invents values.

| `communication.state` | Meaning / cause | Effect on the contract |
|---|---|---|
| `starting` | No attempt completed yet | `telemetry_valid=false`, `data=null`, HTTP 503 |
| `ok` | Last attempt succeeded | Reading published (HTTP 200 if fresh) |
| `stale` | Last valid reading older than `stale_after_s` | `data` preserved, `telemetry_valid=false`, HTTP 503 |
| `port_unavailable` | Port not found, nonexistent **or in use by another process** | No new reading; HTTP 503 |
| `permission_denied` | User without access to `/dev/ttyACM*` | No new reading; HTTP 503 |
| `disconnected` | USB disconnection during operation (`ENOENT`/port disappeared) | No new reading; HTTP 503 |
| `timeout` | No response within `command_wait_s` | No new reading; HTTP 503 |
| `invalid_response` | Response that does not contain a Q1 frame | No new reading; HTTP 503 |
| `incomplete_response` | Truncated/incomplete frame | No new reading; HTTP 503 |
| `parse_error` | Non-numeric field / malformed frame | No new reading; HTTP 503 |
| `out_of_range` | Value outside the plausible range (sanity) | No new reading; HTTP 503 |
| `serial_error` | Other I/O failure on the port | No new reading; HTTP 503 |

Each failure also feeds `communication.last_error` (`code`, `message`, `at_utc`) and
`communication.consecutive_failures`. `last_success_utc` is **not** cleared by subsequent failures, which
allows the consumer to distinguish "UPS in failure" from "collector without communication".

A failure in reading the identification (`I`/`F`) does **not** invalidate the telemetry: `/identity` answers 503
and `/telemetry` keeps working normally.

### 7.1 Real failure examples

Port in use by another process (exclusive lock active):

```json
"communication": {
  "state": "port_unavailable",
  "telemetry_valid": false,
  "data_available": false,
  "last_error": {
    "code": "port_unavailable",
    "message": "could not open /dev/ttyACM0 (in use by another process?): [Errno 11] Could not exclusively lock port /dev/ttyACM0: [Errno 11] Resource temporarily unavailable",
    "at_utc": "2026-10-21T15:22:24.582Z"
  },
  "serial_port": "/dev/ttyACM0"
}
```

Nonexistent port (invalid path configured):

```json
"communication": {
  "state": "port_unavailable",
  "last_error": {
    "code": "port_unavailable",
    "message": "serial port /dev/ttyACM9 unavailable"
  },
  "serial_port": "/dev/ttyACM9"
}
```

Corrupted response on the port (example of an invalid reading without generating fictitious telemetry):

```json
"communication": {
  "state": "invalid_response",
  "telemetry_valid": false,
  "data_available": false,
  "consecutive_failures": 1,
  "last_error": {
    "code": "invalid_response",
    "message": "response does not contain a Q1 frame (expected to start with '(') (response: '...')"
  }
}
```

## 8. Log

- A single logger per layer: `ts_shara.collector`, `ts_shara.api`, `ts_shara.cli`.
- **Deduplication:** the same failure (context + code + message) is only written again after **300 s**;
  in the intermediate cycles it stays at `DEBUG`. This avoids flooding the journal when the UPS is offline
  for hours.
- **Heartbeat:** every **12** valid collections a summary is logged at `INFO` (input, output, load,
  battery, flags), confirming that collection is still alive.
- Milestones logged: first valid telemetry, re-establishment after failures, updated identification,
  endpoints published at startup and shutdown.

## 9. Tests and validation

### 9.1 Automated tests (no hardware)

```bash
python3 -m unittest discover -s tests -t . -v     # 46 tests
```

| File | Coverage |
|---|---|
| [tests/test_protocol.py](../tests/test_protocol.py) | Q1 frame parsing, status bits, fixed widths of `I`, `F`, battery estimation, sanity limits, protocol errors |
| [tests/test_collector.py](../tests/test_collector.py) | In-memory state, classified failures, preservation of the last reading, staleness, log deduplication |
| [tests/test_http_api.py](../tests/test_http_api.py) | Real HTTP on `127.0.0.1`: contract, codes 200/404/405/503, `/health` `ok`/`degraded`/`down`, and the requirement "HTTP request does not trigger a serial reading" |

The tests use a fake serial link and a controlled clock (dependency injection), so they do **not** open the
UPS's real port.

### 9.2 Validation with the hardware (procedure)

```bash
# 1) one collection, JSON on stdout
python3 scripts/run_api.py --check | python3 -m json.tool --no-ensure-ascii
#    expected: "telemetry_valid": true and exit code 0

# 2) start the service
python3 scripts/run_api.py --http-host 127.0.0.1 --http-port 8081

# 3) consume (in another terminal)
python3 - <<'PY'
import json, urllib.request
for path in ("/health", "/api/v1/ups", "/api/v1/ups/tsshara-3200va-01/telemetry"):
    with urllib.request.urlopen("http://127.0.0.1:8081" + path, timeout=5) as response:
        print(path, response.status, json.dumps(json.load(response), ensure_ascii=False)[:200])
PY
```

Failure scenarios reproducible without switching off the device:

| Scenario | How to trigger | Expected |
|---|---|---|
| Wrong port | `--check --port /dev/ttyACM9` | `state = port_unavailable`, `serial_port` = attempted port, no `data` |
| Port in use | keep the API running and run `--check` in parallel | `port_unavailable` with an exclusive lock message |
| USB disconnection | unplug the USB cable and watch `/health` | `state = disconnected` (or `port_unavailable`), `last_success_utc` preserved, `stale` after `stale_after_s` |
| Absence of reading | start the API without the UPS and query `/telemetry` | HTTP `503`, `data = null`, no fictitious values |

## 10. Security and limits

- **Read-only:** the API exposes no command endpoint. The test/shutdown commands
  (`T`, `TL`, `S`) are **not** implemented at any layer (decision D9).
- No sensitive data is published: only telemetry, identification and collection metadata.
- There is no authentication in this version — publish the port only on the management network.

## 11. Versioning

| Version | Change |
|---|---|
| `v1` / contract `1.0` | First public version: `/health`, `/api/v1`, `/api/v1/ups`, `/telemetry`, `/identity` |

Incompatible changes will require a new prefix (`/api/v2`) and an increment of `contract_version`;
compatible additions only increment `contract_version`.

## 12. Out of scope (later stages)

- Web application / dashboards.
- Docker consumer.
- Definitive Zabbix integration — see [zabbix-integration.md](zabbix-integration.md) (Option C: the API as a
  data source, via Zabbix Agent 2 on the same host).
