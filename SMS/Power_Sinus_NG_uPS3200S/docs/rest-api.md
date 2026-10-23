# UPS telemetry REST API (v2.0)

Local collector + **read-only** HTTP/REST API that exposes the **last valid telemetry** of the
**SMS Power Sinus NG uPS3200S** UPS (protocol **SMS Brazil 1Phase** over **USB-Serial Prolific**) as
**versioned JSON**.

- **Goal:** turn the serial reading into a service consumable over HTTP, without the consumer needing
  to know the serial port, the protocol or the equipment's configuration file.
- **Scope:** collection, protocol interpretation, in-memory state and REST API. It does **not** include a web
  application, database, control commands, Docker or definitive Zabbix integration (later stages).
- **Evidence for this version:** 2026-10-22, the reference host (Ubuntu 24.04.5 LTS), unit
  `sms-ups3200s-01` on `/dev/ttyUSB0` (auto-detected via `067b:23d3`).

---

## 1. Data flow

```text
SMS Power Sinus NG uPS3200S UPS (3200VA)
      |  USB-Serial Prolific 067b:23d3  ->  /dev/ttyUSB0  (2400 8N1, <CR>)
      v
serial_link.py      accesses the port (only component with serial access; exclusive lock)
      v
protocol.py         builds the Q/I/F commands and interprets the 18-byte binary frames
                    (pure functions, no I/O)
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
4. There is no database and no telemetry file: restarting the service loses the history (by design).
5. Communication failures **do not** produce fictitious values: the `data` field exists only if there was a valid reading.

## 2. Requirements and installation

| Item | Requirement |
|---|---|
| System | Linux with `/dev/ttyUSB*` (validated on Ubuntu 24.04.5 LTS) |
| Python | 3.8+ (validated on 3.12.3) |
| External dependency | **`pyserial`** (`python3-serial`). Everything else uses the standard library |
| Permissions | service user in the `dialout` group (or an equivalent udev rule) |
| Port | the UPS USB port accessible to the host (the service must run **on** the host that has the cable) |

```bash
sudo apt install python3-serial                 # the only dependency
sudo usermod -aG dialout "$USER"                # read/write permission on /dev/ttyUSB0
```

Prior check of the device (optional, read-only):

```bash
python3 scripts/sms_collector.py --identify     # a single reading (Q + I + F)
```

> `ModemManager` must ignore the device (udev rule — see
> [nut-installation-and-configuration.md](nut-installation-and-configuration.md) §4); it injects `AT` commands that
> corrupt the port. With the exclusive lock (`serial_exclusive = true`), the API detects the conflict and reports
> `port_unavailable` instead of reading garbage.

## 3. Running

### 3.1 Service mode (continuous)

```bash
cd SMS/Power_Sinus_NG_uPS3200S
python3 -m api --config /etc/sms-api/sms_api.conf
# equivalent: python3 scripts/run_api.py --config ...
```

The service listens on `http_host:http_port` (default **127.0.0.1:8082**) and logs the active endpoints.
It shuts down cleanly with `SIGINT`/`SIGTERM`.

### 3.2 Check mode (one collection, without starting the API)

```bash
python3 scripts/run_api.py --check
```

Runs **one** collection cycle, prints the contract JSON on `stdout` and exits.
Logs go to `stderr`, so the output is safe for pipes (`| python3 -m json.tool`) and scripts.
Exit codes: `0` = valid telemetry (equivalent to HTTP 200), `3` = no valid telemetry (`503`),
`2` = configuration error, `1` = failure to listen on the HTTP port.

### 3.3 systemd service (recommended mode for production)

The supported way to keep the API **always up** is the `sms-api` service. Installation is done by a
script that copies the unit, the configuration and the udev rule, adjusting the user and the project folder to the host:

```bash
cd SMS/Power_Sinus_NG_uPS3200S
sudo scripts/install_service.sh
```

The script ([`scripts/install_service.sh`](../scripts/install_service.sh)) does:

1. install `/etc/systemd/system/sms-api.service`
   ([example](../config/examples/sms-api.service)) — `Restart=always`, `RestartSec=5` and
   `StartLimitIntervalSec=0`, that is, **the service is restarted indefinitely** if it goes down, and a cable
   absent at boot does not exhaust the attempts;
2. install `/etc/sms-api/sms_api.conf` (preserves an existing configuration);
3. install `/etc/udev/rules.d/99-sms-ups.rules`
   ([rule](../config/examples/99-sms-ups.rules)) — `dialout` permission, `ModemManager` ignoring the
   device and **automatic service restart when the cable is reconnected**;
4. `systemctl daemon-reload`, `udevadm --reload-rules/--trigger` and `systemctl enable --now sms-api`.

> **Note on paths with spaces:** systemd unit files **do not** use quotes
> (`WorkingDirectory` reads the whole value up to the end of the line) and the `%` sign must be escaped as `%%`
> (that is why the `Documentation` URL uses `%%20` instead of the space). The script already generates the file this way.

Equivalent manual installation and monitoring:

```bash
sudo install -m 0644 config/examples/sms-api.service /etc/systemd/system/
sudo install -d /etc/sms-api
sudo install -m 0640 config/examples/sms_api.conf /etc/sms-api/
sudo install -m 0644 config/examples/99-sms-ups.rules /etc/udev/rules.d/
sudo systemctl daemon-reload && sudo udevadm control --reload-rules && sudo udevadm trigger
sudo systemctl enable --now sms-api
systemctl status sms-api --no-pager
journalctl -u sms-api -f
```

### 3.4 Behavior without the USB cable (availability control)

**The service does not stop when the USB is disconnected.** The collector keeps trying every
`poll_interval_s`, and the API stays up so the consumer can **distinguish** "API down"
from "UPS without communication":

| Situation | HTTP | Where it appears |
|---|---|---|
| USB connected and reading | `/health` **200** (`status=ok`), `/telemetry` **200** | `communication.state = ok` |
| Cable removed or port nonexistent/busy | `/health` **503** (`degraded`), `/telemetry` **503** with `data = null` | `state = disconnected` or `port_unavailable` + `last_error` |
| Cable removed **after** a valid reading exists | `/telemetry` **503** | last reading preserved and marked `stale`; `last_success_utc` kept |
| Cable reconnected | back to **200** | auto-detection by VID:PID reopens the port; the udev rule also restarts the service |

- `/api/v1/ups` keeps answering **200** with `communication_state` of the failure — the consumer discovers the
  equipment and sees the reason for the unavailability.
- `GET /health` exposes `checks.serial_communication` (`ok`, `port_unavailable`, `disconnected`, `timeout`, …)
  for direct use as *readiness/liveness* (e.g.: `curl -fsS http://127.0.0.1:8082/health`).
- No fictitious value is published: without a valid reading, `data` is `null`.

> **Bench observation (2026-10-22):** with the API already up, a second process on the port
> (`sms_collector.py` in parallel) fails with `port_unavailable` —
> `Could not exclusively lock port /dev/ttyUSB0: [Errno 11] Resource temporarily unavailable` — and the API
> keeps publishing normally. This is the expected behavior (D15).

## 4. Configuration

Precedence (the last one wins): **defaults** → **INI file** (`--config`, `[sms_api]` section) →
**environment variables** (`SMS_API_<FIELD_NAME_IN_UPPERCASE>`) → **command line**.

| Field | Default | Description |
|---|---|---|
| `device_id` | `sms-ups3200s-01` | Logical identifier used in the URLs (brand-model-sequence pattern) |
| `device_brand` | `SMS` | Brand shown in `/api/v1/ups` |
| `device_model` | `Power Sinus NG uPS3200S` | Model shown in `/api/v1/ups` |
| `protocol` | `sms-1phase` | Reading protocol (informative in the contract) |
| `transport` | `usb-serial` | Physical transport (informative in the contract) |
| `serial_port` | *(empty)* | Empty = auto-detect by `usb_vendor_id`:`usb_product_id` |
| `serial_baud` | `2400` | Baud of the SMS protocol (fixed on the equipment) |
| `serial_timeout_s` | `1.0` | Port read timeout |
| `serial_exclusive` | `true` | Exclusive lock: prevents two processes on the port |
| `command_wait_s` | `0.5` | Wait between sending the command and reading the response |
| `usb_vendor_id` / `usb_product_id` | `067b` / `23d3` | VID:PID of the Prolific PL2303 converter |
| `poll_interval_s` | `5.0` | Interval between collection cycles |
| `stale_after_s` | `20.0` | Age from which the reading is considered outdated |
| `identity_refresh_s` | `3600.0` | Re-read interval of `I`/`F` (identification and ratings) |
| `battery_voltage_nominal_v` | `24` | Nominal battery voltage; used to **derive** the voltage from the percentage |
| `http_host` | `127.0.0.1` | Listening interface (IP of the machine itself) |
| `http_port` | `8082` | API TCP port |
| `log_level` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |
| `log_file` | *(empty)* | Empty = log to `stderr` (systemd collects it in the journal) |

Example file: [`config/examples/sms_api.conf`](../config/examples/sms_api.conf).

Command-line options: `--config --port --baud --device-id --interval --stale-after --http-host
--http-port --log-level --log-file --check`.

The configuration is validated at startup; inconsistent values (e.g.: `stale_after_s < poll_interval_s`)
terminate the process with exit code `2` and a message on `stderr`.

## 5. Endpoints

| Method | Path | Response |
|---|---|---|
| GET | `/health` | Availability of the application, the collection loop and the communication |
| GET | `/api/v1` | Contract index (available endpoints and versions) |
| GET | `/api/v1/ups` | Configured equipment and each one's endpoints |
| GET | `/api/v1/ups/{device_id}/telemetry` | Last valid telemetry + collection state |
| GET | `/api/v1/ups/{device_id}/identity` | Equipment identification and nominal information |

Any other method (`POST`, `PUT`, `PATCH`, `DELETE`) answers **405** `method_not_allowed` — the API is
read-only and no command is sent to the UPS.

### 5.1 HTTP codes

| Code | When it occurs |
|---|---|
| `200` | Data available and intact (`/health` `status=ok`; valid and fresh telemetry; identity available) |
| `404` | Nonexistent path (`error.code = not_found`) or `device_id` not configured (`error.code = device_not_found`) |
| `405` | Method other than `GET` (`error.code = method_not_allowed`) |
| `503` | Application up, but without usable data: `/health` `degraded`/`down`, telemetry missing or **outdated**, identity unavailable |

The three planes stay **separate** in the JSON, as requested in the project:

- **application availability** → `checks.process` and `checks.collector_thread`;
- **validity/freshness of the last reading** → `telemetry_valid`, `stale`, `age_seconds`, `checks.telemetry_freshness`;
- **state of the communication with the UPS** → `communication.state`, `communication.last_error`.

### 5.2 Real examples (2026-10-22, unit connected)

`GET /health` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "status": "ok",
  "checked_at_utc": "2026-10-22T13:36:09.354Z",
  "uptime_seconds": 189.635,
  "device_id": "sms-ups3200s-01",
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
    "last_attempt_utc": "2026-10-22T13:36:04.741Z",
    "last_success_utc": "2026-10-22T13:36:05.242Z",
    "age_seconds": 4.112,
    "consecutive_failures": 0,
    "total_attempts": 38,
    "total_successes": 38,
    "last_error": null,
    "serial_port": "/dev/ttyUSB0",
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
      "device_id": "sms-ups3200s-01",
      "brand": "SMS",
      "model": "Power Sinus NG uPS3200S",
      "transport": "usb-serial",
      "protocol": "sms-1phase",
      "serial_port": "/dev/ttyUSB0",
      "communication_state": "ok",
      "telemetry_endpoint": "/api/v1/ups/sms-ups3200s-01/telemetry",
      "identity_endpoint": "/api/v1/ups/sms-ups3200s-01/identity"
    }
  ]
}
```

`GET /api/v1/ups/sms-ups3200s-01/telemetry` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "device_id": "sms-ups3200s-01",
  "telemetry_valid": true,
  "stale": false,
  "data_available": true,
  "data": {
    "captured_at_utc": "2026-10-22T13:36:05.242Z",
    "source": "sms-1phase",
    "measurements": {
      "input_voltage_v": 218.1,
      "input_voltage_extended_v": 0.0,
      "output_voltage_v": 217.7,
      "load_percent": 20.0,
      "output_frequency_hz": 59.9,
      "temperature_c": 49.1
    },
    "battery": {
      "charge_percent": 100.0,
      "charge_source": "reported_by_device",
      "voltage_v": 24.0,
      "voltage_derived": true,
      "voltage_nominal_v": 24,
      "packs": 2
    },
    "status": {
      "raw_bits": "00101001",
      "raw_byte": 41,
      "active": ["BEEP", "UPSOK", "BYPASS"],
      "flags": {
        "BEEP": true, "FSD": false, "TEST": false, "UPSOK": true,
        "BOOST": false, "BYPASS": true, "LB": false, "OB": false
      }
    },
    "raw_frame": "3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d",
    "age_seconds": 4.112
  },
  "communication": {
    "state": "ok",
    "telemetry_valid": true,
    "stale": false,
    "last_attempt_utc": "2026-10-22T13:36:04.741Z",
    "last_success_utc": "2026-10-22T13:36:05.242Z",
    "age_seconds": 4.112,
    "consecutive_failures": 0,
    "total_attempts": 38,
    "total_successes": 38,
    "last_error": null,
    "serial_port": "/dev/ttyUSB0",
    "poll_interval_s": 5.0,
    "stale_after_s": 20.0
  }
}
```

`GET /api/v1/ups/sms-ups3200s-01/identity` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "device_id": "sms-ups3200s-01",
  "identity_available": true,
  "data": {
    "captured_at_utc": "2026-10-22T13:32:59.733Z",
    "device": {
      "model": "Power Sinus",
      "firmware": "1.2",
      "raw_frame": "3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d"
    },
    "nominal": {
      "voltage_label": "220",
      "voltage_v": 220,
      "input_current_label": "000",
      "input_current_a": 0,
      "battery_voltage_label": "24",
      "battery_voltage_v": 24,
      "frequency_label": "60",
      "frequency_hz": 60,
      "raw_frame": "3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d"
    }
  },
  "configured": {
    "device_id": "sms-ups3200s-01",
    "brand": "SMS",
    "model": "Power Sinus NG uPS3200S",
    "protocol": "sms-1phase",
    "transport": "usb-serial",
    "serial_port": "/dev/ttyUSB0",
    "serial_baud": 2400,
    "poll_interval_s": 5.0,
    "stale_after_s": 20.0
  },
  "communication": { "state": "ok", "age_seconds": 1.684, "last_error": null, "...": "..." }
}
```

`GET /api/v1/ups/nonexistent/telemetry` → **404**

```json
{
  "api_version": "v1",
  "contract_version": "1.0",
  "error": {
    "code": "device_not_found",
    "message": "device 'nonexistent' is not configured (available: sms-ups3200s-01)"
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
Dates in **ISO 8601 UTC** with milliseconds and the `Z` suffix. Numbers with an **explicit unit in the field name**.

### 6.2 Measurements (`data.measurements`)

| Field | Unit | Origin (Q frame) | Note |
|---|---|---|---|
| `input_voltage_v` | V | bytes 3–4 | Input voltage (mains) |
| `input_voltage_extended_v` | V | bytes 1–2 | "Last voltage"/extended; came as `0.0` in the capture |
| `output_voltage_v` | V | bytes 5–6 | Output voltage |
| `load_percent` | % | bytes 7–8 | Output load percentage |
| `output_frequency_hz` | Hz | bytes 9–10 | Output frequency |
| `temperature_c` | °C | bytes 13–14 | Internal temperature |

> Details on offsets, scale (tenths, big-endian) and checksum: [sms-1phase-protocol.md](sms-1phase-protocol.md).

### 6.3 Battery (`data.battery`) — the **opposite** of Megatec

The `Q` frame **transmits the percentage** of battery charge (bytes 11–12). Therefore:

- `charge_percent` — value **reported by the equipment**; `charge_source = "reported_by_device"`
  (it is not our estimate);
- `voltage_v` — does **not** come in the frame: it is **derived** as `voltage_nominal_v × charge_percent / 100`
  (same rule as the NUT `sms_ser` driver); `voltage_derived = true`;
- `voltage_nominal_v` — the nominal used in the derivation (confirmed by command `F`; default `24`);
- `packs` — number of 12 V batteries in series (`voltage_nominal_v / 12`).

```json
"battery": {
  "charge_percent": 100.0,
  "charge_source": "reported_by_device",
  "voltage_v": 24.0,
  "voltage_derived": true,
  "voltage_nominal_v": 24,
  "packs": 2
}
```

- `voltage_v` is `null` when there is no valid percentage in the reading.
- Basis: [Spec.md §8](../Spec.md#L218-L246) and [sms-1phase-protocol.md](sms-1phase-protocol.md) §7.

### 6.4 States (`data.status`)

`raw_bits` preserves the 8 bits (`b7…b0`); `raw_byte` gives the byte in decimal; `active` lists the flags
that are on; `flags` gives all eight.

| Bit | Flag | Meaning |
|---|---|---|
| b7 | `OB` | Mains absent / running on battery (*on battery*) |
| b6 | `LB` | Low battery (*low battery*) |
| b5 | `BYPASS` | Bypass active |
| b4 | `BOOST` | Boost/Buck active |
| b3 | `UPSOK` | Inverter/mains OK (no fault) |
| b2 | `TEST` | Battery test in progress |
| b1 | `FSD` | Shutdown active (*fail-safe shutdown*) |
| b0 | `BEEP` | Beeper on |

> Bench example: `raw_byte = 41` → `00101001` → active `BEEP` + `UPSOK` + `BYPASS`.

### 6.5 Identification and nominal information (`/identity`)

- `data.device`: `model`, `firmware` (command `I`, fixed widths 12/3 — see
  [sms-1phase-protocol.md](sms-1phase-protocol.md) §5);
- `data.nominal`: `voltage_label`/`voltage_v`, `input_current_label`/`input_current_a`,
  `battery_voltage_label`/`battery_voltage_v`, `frequency_label`/`frequency_hz` (command `F`). The raw
  label is preserved together with the number; when the label is not numeric (e.g.: `Univ.` in other models), the
  number is `null` (no fictitious value);
- `configured`: logical identity, protocol, transport, port, `serial_baud`, `poll_interval_s` and
  `stale_after_s`;
- `raw_frame` in both preserves the original bytes, for auditing.

## 7. Failure handling

The collector **classifies** each failure into a contract code and keeps the last valid reading (if it exists),
only marking it as outdated. It never invents values.

| `communication.state` | Meaning / cause | Effect on the contract |
|---|---|---|
| `starting` | No attempt completed yet | `telemetry_valid=false`, `data=null`, HTTP 503 |
| `ok` | Last attempt successful | Reading published (HTTP 200 if fresh) |
| `stale` | Last valid reading older than `stale_after_s` | `data` preserved, `telemetry_valid=false`, HTTP 503 |
| `port_unavailable` | Port not found, nonexistent **or in use by another process** | No new reading; HTTP 503 |
| `permission_denied` | User without access to `/dev/ttyUSB*` | No new reading; HTTP 503 |
| `disconnected` | USB disconnection during operation (`ENOENT`/port disappeared) | No new reading; HTTP 503 |
| `timeout` | No response within `command_wait_s` | No new reading; HTTP 503 |
| `invalid_response` | Response that does not contain a `Q` frame (start ≠ `<`/`=`/`>`) | No new reading; HTTP 503 |
| `incomplete_response` | Truncated/incomplete frame (fewer than 18 bytes) | No new reading; HTTP 503 |
| `checksum_error` | Frame checksum does not match | No new reading; HTTP 503 |
| `parse_error` | Non-numeric field / malformed frame | No new reading; HTTP 503 |
| `out_of_range` | Value outside the plausible range (sanity) | No new reading; HTTP 503 |
| `serial_error` | Another I/O failure on the port | No new reading; HTTP 503 |

Each failure also feeds `communication.last_error` (`code`, `message`, `at_utc`) and
`communication.consecutive_failures`. `last_success_utc` is **not** erased by subsequent failures, which
lets the consumer distinguish "UPS in failure" from "collector without communication".

A failure in reading the identification (`I`/`F`) **does not** invalidate the telemetry: `/identity` answers 503 and
`/telemetry` keeps working normally.

### 7.1 Real failure examples

Port in use by another process (exclusive lock active) — captured on the bench on 2026-10-22:

```json
"communication": {
  "state": "port_unavailable",
  "telemetry_valid": false,
  "data_available": false,
  "last_error": {
    "code": "port_unavailable",
    "message": "could not open /dev/ttyUSB0 (in use by another process?): [Errno 11] Could not exclusively lock port /dev/ttyUSB0: [Errno 11] Resource temporarily unavailable",
    "at_utc": "2026-10-22T13:36:01.386Z"
  },
  "serial_port": "/dev/ttyUSB0"
}
```

Nonexistent port (invalid path configured):

```json
"communication": {
  "state": "port_unavailable",
  "last_error": {
    "code": "port_unavailable",
    "message": "serial port /dev/ttyUSB9 unavailable"
  },
  "serial_port": "/dev/ttyUSB9"
}
```

Invalid response on the port (example of a reading discarded without generating fictitious telemetry):

```json
"communication": {
  "state": "invalid_response",
  "telemetry_valid": false,
  "data_available": false,
  "consecutive_failures": 1,
  "last_error": {
    "code": "invalid_response",
    "message": "response to command Q does not start with '<', '=' or '>' (byte 0x41) (response: '...')"
  }
}
```

## 8. Logging

- A single logger per layer: `sms.collector`, `sms.api`, `sms.cli`.
- **Deduplication:** the same failure (context + code + message) is only written again after **300 s**;
  in the intermediate cycles it stays at `DEBUG`. This avoids flooding the journal when the UPS is offline for hours.
- **Heartbeat:** every **12** valid collections a summary is logged at `INFO` (input, output, load,
  battery, temperature and flags), confirming that the collection is still alive.
- Milestones logged: first valid telemetry, restoration after failures, updated identity,
  endpoints published at startup and shutdown.

## 9. Tests and validation

### 9.1 Automated tests (without hardware)

```bash
python3 -m unittest discover -s tests -t . -v     # 48 tests
```

| File | Coverage |
|---|---|
| [tests/test_protocol.py](../tests/test_protocol.py) | Command building (checksum), `Q` frame parsing, status bits, fixed widths of `I` and `F`, battery voltage derivation, sanity limits and protocol errors |
| [tests/test_collector.py](../tests/test_collector.py) | In-memory state, classified failures, preservation of the last reading, staleness, log deduplication |
| [tests/test_http_api.py](../tests/test_http_api.py) | Real HTTP on `127.0.0.1`: contract, codes 200/404/405/503, `/health` `ok`/`degraded`/`down` and the requirement "an HTTP request does not trigger a serial reading" |

The tests use a fake serial link and a controlled clock (dependency injection), with **real frames** from the
equipment pinned in [tests/support.py](../tests/support.py), so they do **not** open the real port.

### 9.2 Validation with the hardware (procedure)

```bash
# 1) one collection, JSON on stdout
python3 scripts/run_api.py --check | python3 -m json.tool --no-ensure-ascii
#    expected: "telemetry_valid": true and exit code 0

# 2) start the service
python3 scripts/run_api.py --http-host 127.0.0.1 --http-port 8082

# 3) consume (in another terminal)
python3 - <<'PY'
import json, urllib.request
for path in ("/health", "/api/v1/ups", "/api/v1/ups/sms-ups3200s-01/telemetry"):
    with urllib.request.urlopen("http://127.0.0.1:8082" + path, timeout=5) as response:
        print(path, response.status, json.dumps(json.load(response), ensure_ascii=False)[:200])
PY
```

Failure scenarios reproducible without turning off the equipment:

| Scenario | How to trigger | Expected |
|---|---|---|
| Wrong port | `--check --port /dev/ttyUSB9` | `state = port_unavailable`, `serial_port` = attempted port, no `data` |
| Port in use | keep the API running and run `--check`/`sms_collector.py` in parallel | `port_unavailable` with an exclusive lock message |
| USB disconnection | unplug the USB cable and observe `/health` | `state = disconnected` (or `port_unavailable`), `last_success_utc` preserved, `stale` after `stale_after_s` |
| Absence of reading | start the API without the UPS and query `/telemetry` | HTTP `503`, `data = null`, no fictitious values |

## 10. Security and limits

- **Read-only:** the API exposes no command endpoint. The action commands
  (`M` beeper, `L`/`T` battery test, `S`/`R` shutdown, `D`/`C` cancellations) are **not**
  implemented in any layer (decision D9).
- No sensitive data is published: only telemetry, identification and collection metadata.
- There is no authentication in this version — publish the port only on the management network.

## 11. Versioning

| Version | Change |
|---|---|
| `v1` / contract `1.0` | First public version: `/health`, `/api/v1`, `/api/v1/ups`, `/telemetry`, `/identity` |

Incompatible changes will require a new prefix (`/api/v2`) and an increment of `contract_version`;
compatible additions only increment `contract_version`.

## 12. Out of scope (next stages)

- Web application / dashboards.
- Consumer in Docker.
- Definitive Zabbix integration — see [zabbix-integration.md](zabbix-integration.md) (Option C: the API as a
  data source, via Zabbix Agent 2 on the same host).
