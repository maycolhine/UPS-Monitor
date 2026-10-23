# Unified REST API for UPS devices (`upsmon`) — contract v1 / revision 3.0

**Multi-device** and **multi-protocol** local collector + HTTP/REST API that exposes the
**last valid telemetry** of **all** monitored UPS devices on **a single HTTP port** and allows
**triggering a battery test** per device (`duration_10s` of ~10 s or `discharge_20pct` — controlled
discharge down to 20 %, where the protocol is able to cancel).

- **Objective:** one process, one HTTP port, N devices. The consumer (Zabbix, dashboard, script) talks
  to a single address and selects the device via `device_id` — without knowing which serial port, which
  protocol or which configuration file is behind it.
- **Two kinds of endpoint:**
  - **Read (telemetry):** `GET /health`, `GET /api/v1`, `GET /api/v1/ups`,
    `GET .../telemetry`, `GET .../identity`. None of them causes serial I/O.
  - **Write (battery test, new in 3.0):** `POST .../tests` (request) and `POST .../tests/{id}/abort`
    (cancellation), **enabled per device** (`allow_battery_test`). They also do **not** touch the serial
    port: they only validate preconditions and enqueue/mark the request, which is executed by the
    collector's own loop.
- **Replaces** the per-device APIs from the previous stages:
  - [TS Shara `rest-api.md`](../../TS_Shara/Universal_UPS_Senoidal_3200VA/docs/rest-api.md) → port **8081**
    (`tsshara-3200va-01`);
  - [SMS `rest-api.md`](../../SMS/Power_Sinus_NG_uPS3200S/docs/rest-api.md) → port **8082**
    (`sms-ups3200s-01`).
    Both remain available as reference/rollback; the unified API is the supported mode.
- **Scope:** collection, protocol interpretation, in-memory state, REST API and **on-demand battery
  tests** — `duration_10s` (fixed window) and `discharge_20pct` (controlled discharge up to the target) —
  with a predictability report and a sampled timeline. It does **not** include a database, other control
  commands (`S`/`M`/`L`/`C`/`R`), a web application or the definitive Zabbix integration.
- **Evidence:** 2026-10-22, on the reference host (Ubuntu 24.04.5 LTS). `pyserial` as the only external
  dependency; everything else uses the standard library.

---

## 1. Data flow

```text
UPS A (TS Shara, Megatec/Q1)              UPS B (SMS, Brazil 1Phase)
  USB CDC-ACM 0483:5740 -> /dev/ttyACM0     USB-Serial 067b:23d3 -> /dev/ttyUSB0
            \                                        /
             v                                      v
        drivers/megatec_q1.py                 drivers/sms_1phase.py     (pure functions, no I/O)
             \                                        /
              v                                      v
        Collector (1 thread per device)        Collector (1 thread per device)
          serial_link.py                        serial_link.py          (single serial I/O point)
              \                                        /
               v                                      v
        ============ in-memory state (snapshot per device) ============
                                    |
                          http_api.py (one HTTP port)
                                    |
                    HTTP consumers (Zabbix, scripts, dashboards)
```

**Battery test flow (3.0)**

```text
POST /api/v1/ups/{device_id}/tests   (HTTP handler: validates preconditions, enqueues)
              |
              v
   Collector._pending_test  (marked under lock; NO serial I/O here)
              |
     collector loop (collect_once, every poll_interval_s)
              |
              v
   1. send_action("T", duration) -> ACTION command, fire-and-forget (does not wait for a response)
                                  (`duration_10s`: with the duration; `discharge_20pct`: without duration, on purpose)
   2. sampling window          -> high-frequency readings (test_sample_interval_s)
                                  `duration_10s`: fixed ~10 s
                                  `discharge_20pct`: until the reported charge reaches the target (20 %) or the 30 min ceiling
                                  each reading becomes a sample (offset_s, normalized, measurements,
                                  status, battery) — the series is published on every sample
   3. termination             -> send_action("D") on the protocols that know how to cancel (SMS)
   4. finalization            -> aggregates the series (deltas) + first-order estimate
              |
              v
   GET .../tests/{test_id}    -> partial while running; complete at the end
```

**Structural rules**

1. Only the **collector** accesses the serial port (via `serial_link.py`), with an **exclusive lock**
   (`serial_exclusive = true`): there are no two processes on the same port. The HTTP layer **never**
   reads from or writes to the serial port — not even to request the test.
2. There is **one collector (one thread) per device**; the HTTP layer reads only the in-memory state.
   An HTTP request **never** causes a serial read nor the sending of the test command: the handler only
   validates and enqueues (`request_test`), and the collector loop — the sole owner of the port —
   executes the window.
3. **Total isolation:** a missing cable, a busy port or a protocol with an error on one device
   **does not** affect the collection of the others nor the availability of the API.
4. There is no database: restarting the service loses the history (by design), including the latest
   battery test reports (kept in memory, `test_history_size` per device).
5. Communication failures **do not** generate fictitious values: `data` only exists if there was a
   valid read.
6. **One test at a time per device:** there is a cooldown between tests (`test_cooldown_s`), a minimum
   charge (`test_min_battery_percent`) and a refusal when the UPS is already on battery (`OB`) or with
   low battery (`LB`) — the goal is **never** to drain the battery.

## 2. Requirements and installation

| Item | Requirement |
|---|---|
| System | Linux with `/dev/ttyACM*` and/or `/dev/ttyUSB*` (validated on Ubuntu 24.04.5 LTS) |
| Python | 3.8+ (validated on 3.12.3) |
| External dependency | **`pyserial`** (`python3-serial`). Everything else uses the standard library |
| Permissions | service user in the `dialout` group (or an equivalent udev rule) |
| Port | all USB cables accessible to the **same** host (the service runs on the host of the cables) |

```bash
sudo apt install python3-serial                 # only dependency
sudo usermod -aG dialout "$USER"                # permission on /dev/ttyACM* and /dev/ttyUSB*
```

> `ModemManager` must ignore the devices (udev rule — §6); it injects `AT` commands that corrupt the
> port. With the exclusive lock, the API detects the conflict and reports `port_unavailable` instead of
> reading garbage.

## 3. Execution

Run it from the `monitor/` folder (where the `upsmon/` package is).

### 3.1 Service mode (continuous)

```bash
cd monitor
python3 -m upsmon --config /etc/upsmon/upsmon.conf
# equivalent: python3 scripts/run_api.py --config /etc/upsmon/upsmon.conf
```

The service listens on `http_host:http_port` (default **127.0.0.1:8080**) and logs the active endpoints
and the served devices. It shuts down cleanly with `SIGINT`/`SIGTERM`.

### 3.2 Check mode (one collection of each device, without starting the API)

```bash
python3 -m upsmon --config /etc/upsmon/upsmon.conf --check
```

Runs **one** collection cycle per device and prints a JSON indexed by `device_id` to `stdout`.
The logs go to `stderr`, so the output is safe for pipes (`| python3 -m json.tool`).
Exit codes: `0` = all with valid telemetry, `3` = at least one without valid telemetry,
`2` = configuration error, `1` = failure to listen on the HTTP port.

### 3.3 List the configured devices

```bash
python3 -m upsmon --config /etc/upsmon/upsmon.conf --list
```

### 3.4 One-off read (without starting the API)

```bash
python3 scripts/monitor_collector.py                          # all, text format
python3 scripts/monitor_collector.py --device sms-ups3200s-01  # only one
python3 scripts/monitor_collector.py --json                    # contract JSON
python3 scripts/monitor_collector.py --identify                # includes I/F
```

> Use the one-off read **only** when the API is not running: the exclusive lock prevents two
> applications on the same port (the script reports `port_unavailable` if the port is in use).

### 3.5 systemd service (recommended mode for production)

```bash
cd monitor
sudo scripts/install_service.sh
```

The script ([`scripts/install_service.sh`](../scripts/install_service.sh)) does:

1. installs `/etc/systemd/system/upsmon-api.service`
   ([example](../config/examples/upsmon-api.service)) — `Restart=always`, `RestartSec=5` and
   `StartLimitIntervalSec=0`, that is, it **restarts indefinitely** and a missing cable at boot does not
   exhaust the attempts. The `User=` is adjusted to whoever called `sudo`, and the `WorkingDirectory` to
   this folder;
2. installs `/etc/upsmon/upsmon.conf` (preserves an existing configuration);
3. installs `/etc/udev/rules.d/99-upsmon.rules`
   ([rule](../config/examples/99-upsmon.rules)) — `dialout` permission, `ModemManager` ignoring both
   devices and **restarting the service when any cable is reconnected**;
4. `systemctl daemon-reload`, `udevadm --reload-rules/--trigger` and `systemctl enable --now upsmon-api`;
5. warns if the legacy services (`ts-shara-api.service`, `sms-api.service`) still exist (§8).

> **Unit name:** the unit is named **`upsmon-api.service`** on purpose — `upsmon.service`
> **already belongs to the NUT package** (it is an alias of `nut-monitor.service`) and must not be
> overwritten.

> **Note about paths with spaces:** systemd unit files do **not** use quotes
> (`WorkingDirectory` reads the entire value to the end of the line) and the `%` sign must be escaped as
> `%%` (which is why the `Documentation` URL uses `%%20` instead of the space). The script already
> generates the file this way.

Equivalent manual installation and monitoring:

```bash
sudo install -m 0644 config/examples/upsmon-api.service /etc/systemd/system/
sudo install -d /etc/upsmon
# owner root, group dialout, mode 0640: the service runs as $USER:dialout and needs to READ
# this file. Installed as root:root the configparser reads nothing and the service dies
# with "no device configured".
sudo install -m 0640 -g dialout config/examples/upsmon.conf /etc/upsmon/upsmon.conf
sudo install -m 0644 config/examples/99-upsmon.rules /etc/udev/rules.d/
sudo systemctl daemon-reload && sudo udevadm control --reload-rules && sudo udevadm trigger
sudo systemctl enable --now upsmon-api
systemctl status upsmon-api --no-pager
journalctl -u upsmon-api -f
```

### 3.6 Behavior without the USB cable (availability control)

**The service does not terminate when a USB is disconnected.** The collector of that device keeps trying
every `poll_interval_s`; the other devices continue normally. The API separates three planes:

| Situation | `/health` | Device `/telemetry` |
|---|---|---|
| One device reading and another without a cable | **503** `degraded` | 200 (with cable) / 503 (without cable) |
| All reading | **200** `ok` | 200 |
| None reading | **503** `degraded` | 503, `data = null` |
| Dead collector (exception in the thread) | **503** `down` | 503 |
| Cable removed **after** there was a valid read | device state `stale` | 503, last read preserved |

- `/api/v1/ups` keeps responding **200** with the `communication_state` of each device — the consumer
  discovers the devices even when none is reading.
- No fictitious value is published: without a valid read, `data` is `null`.

## 4. Configuration

Precedence (the last wins): **defaults** → **INI file** (`--config`) → **environment variables**
(`UPSMON_<FIELD_IN_UPPERCASE>`) → **command line**.

The INI file has **one** service section (`[upsmon]`) and **one block per device**
(`[device:<device_id>]`); the block identifier is the `device_id` used in the URLs.

```ini
[upsmon]
http_host = 127.0.0.1
http_port = 8080
log_level = INFO
log_file =

[device:tsshara-3200va-01]
brand = TS Shara
model = Universal UPS Senoidal 3200VA
protocol = megatec-q1
transport = usb-serial-cdc-acm
usb_vendor_id = 0483
usb_product_id = 5740
battery_voltage_low_v = 20.1      # driver option (0 %)
battery_voltage_high_v = 26.8     # driver option (100 %)

[device:sms-ups3200s-01]
brand = SMS
model = Power Sinus NG uPS3200S
protocol = sms-1phase
transport = usb-serial
usb_vendor_id = 067b
usb_product_id = 23d3
battery_voltage_nominal_v = 24    # driver option (voltage derivation)
allow_battery_test = true         # enables POST .../tests ON THIS device
```

Full example: [`config/examples/upsmon.conf`](../config/examples/upsmon.conf).

### 4.1 Service fields (`[upsmon]`)

| Field | Default | Description |
|---|---|---|
| `http_host` | `127.0.0.1` | Listening interface (IP of the machine itself) |
| `http_port` | `8080` | **Single** TCP port of all devices |
| `log_level` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL` |
| `log_file` | *(empty)* | Empty = log to `stderr` (systemd collects it in the journal) |

Environment variables: `UPSMON_HTTP_HOST`, `UPSMON_HTTP_PORT`, `UPSMON_LOG_LEVEL`, `UPSMON_LOG_FILE`.

### 4.2 Fields of each device (`[device:<device_id>]`)

| Field | Default | Description |
|---|---|---|
| *(block name)* | — | `device_id` used in the URLs |
| `brand` / `model` | *(empty)* | Displayed in `/api/v1/ups` (informational) |
| `protocol` | *(empty)* | **Required**: `megatec-q1` or `sms-1phase` |
| `transport` | `usb-serial` | Physical transport (informational) |
| `serial_port` | *(empty)* | Empty = auto-detects the port by VID:PID |
| `serial_baud` | `2400` | Nominal baud of both protocols |
| `serial_timeout_s` | `1.0` | Port read timeout |
| `serial_exclusive` | `true` | Exclusive lock: prevents two processes on the port |
| `command_wait_s` | `0.4` | Wait between sending the command and reading |
| `usb_vendor_id` / `usb_product_id` | *(empty)* | VID:PID for port auto-detection |
| `poll_interval_s` | `5.0` | Interval between collection cycles |
| `stale_after_s` | `20.0` | Age from which the read is considered stale |
| `identity_refresh_s` | `3600.0` | Re-read interval for `I`/`F` |

**Unrecognized fields** of a `[device:*]` block go to `options` and become available to the driver —
this is how battery calibration is parameterized per device:

| Driver option | Protocol | Default | Meaning |
|---|---|---|---|
| `battery_voltage_low_v` | `megatec-q1` | `20.1` | Battery voltage corresponding to **0 %** |
| `battery_voltage_high_v` | `megatec-q1` | `26.8` | Battery voltage corresponding to **100 %** |
| `battery_voltage_nominal_v` | `sms-1phase` | `24` | Nominal voltage (the `F` command confirms and prevails) |

**Battery test options** (`[device:*]`; all optional):

| Option | Default | Meaning |
|---|---|---|
| `allow_battery_test` | `false` | **Enables** `POST .../tests` on this device. Without `true`, the request responds **403** `test_disabled` |
| `test_duration_s` | `10.0` | Sampling window. **Keep it at 10 s**: it is the short protocol test (Megatec `T`), which does not take the battery to the limit |
| `test_sample_interval_s` | `0.4` | Interval between samples within the window (the "high frequency": ~25 samples in 10 s by default) |
| `test_cooldown_s` | `300.0` | Minimum time between two tests of the **same** device (battery protection) |
| `test_min_battery_percent` | `50.0` | Minimum charge (%) to allow the test; below that → **409** `battery_too_low` |
| `test_history_size` | `20` | How many recent reports are kept in **memory** (there is no database) |

The protocol (`megatec-q1` / `sms-1phase`) declares whether the test is supported and whether there is a
**cancellation** command — the consumer queries this in `GET /api/v1/ups` (see §5.2 and §6.8).

The configuration is validated at startup; inconsistencies (e.g. `stale_after_s < poll_interval_s`,
duplicated `device_id`, missing or unknown `protocol`) terminate the process with exit code `2`.

### 4.3 Command-line options

`--config --list --check --http-host --http-port --log-level --log-file`.

## 5. Endpoints

| Method | Path | Response |
|---|---|---|
| GET | `/health` | Availability of the application, of each collector and of the communication of each device |
| GET | `/api/v1` | Contract index (endpoints, devices, versions, `capabilities`) |
| GET | `/api/v1/ups` | All configured devices and their endpoints (includes `capabilities.battery_test`) |
| GET | `/api/v1/ups/{device_id}/telemetry` | Last valid telemetry + device collection state |
| GET | `/api/v1/ups/{device_id}/identity` | Identification and nominal characteristics of the device |
| POST | `/api/v1/ups/{device_id}/tests` | **Requests** the battery test (`type`: `duration_10s` \| `discharge_20pct`; asynchronous → **202**) |
| GET | `/api/v1/ups/{device_id}/tests` | Latest tests of the device (in memory; `?limit=N`, default 10) |
| GET | `/api/v1/ups/{device_id}/tests/{test_id}` | Report of one test (**partial** while `running`, complete at the end) |
| POST | `/api/v1/ups/{device_id}/tests/{test_id}/abort` | **Cancels** a test in progress (**202**) |

The test `POST`s are the **only** write of the API — and they exist only on the `/tests` path, only for
devices with `allow_battery_test = true`. Any other method (`PUT`, `PATCH`, `DELETE`) or `POST` on any
other path responds **405** `method_not_allowed`: telemetry remains **read-only**.

### 5.1 HTTP codes

| Code | When it occurs |
|---|---|
| `200` | Data available: `/health` `ok`; valid and fresh telemetry; identity available; test report/list |
| `202` | Battery test **accepted** (request enqueued) or cancellation requested — the execution is asynchronous |
| `400` | `POST` body is not a valid JSON object, or `type` is not a string (`invalid_request`) |
| `403` | Test not enabled on the device (`test_disabled`) |
| `404` | Non-existent path (`not_found`), unconfigured `device_id` (`device_not_found`) or unknown `test_id` (`test_not_found`) |
| `405` | Method not allowed on the resource (`method_not_allowed`) |
| `409` | Request refused by the test preconditions (`test_unavailable`, `test_in_progress`, `on_battery`, `battery_low`, `battery_too_low`, `test_cooldown`) or abort of a test that is not running (`test_not_running`) |
| `422` | Unknown test type (`unsupported_test_type`) or protocol without a test (`test_not_supported`) |
| `503` | Application up, but no usable data: `/health` `degraded`/`down`, missing or **stale** telemetry, identity unavailable |

### 5.2 Examples

`GET /health` → **200** (all devices reading)

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "status": "ok",
  "checked_at_utc": "2026-10-22T14:05:11.204Z",
  "uptime_seconds": 61.512,
  "devices_total": 2,
  "devices_ok": 2,
  "devices": {
    "sms-ups3200s-01": {
      "telemetry_valid": true,
      "stale": false,
      "state": "ok",
      "serial_port": "/dev/ttyUSB0",
      "collector_thread": "ok",
      "telemetry_freshness": "ok",
      "communication": "ok",
      "identity": "ok",
      "last_success_utc": "2026-10-22T14:05:10.001Z",
      "age_seconds": 1.203
    },
    "tsshara-3200va-01": {
      "telemetry_valid": false,
      "stale": false,
      "state": "port_unavailable",
      "serial_port": null,
      "collector_thread": "ok",
      "telemetry_freshness": "no_data",
      "communication": "port_unavailable",
      "identity": "unavailable",
      "last_success_utc": null,
      "age_seconds": null
    }
  }
}
```

`status` = `ok` when **all** devices have valid telemetry; `degraded` when the application is up but
some device has no usable read; `down` when some collection thread has died.
`/health` responds **200** only when `ok` (for use as *readiness*: `curl -fsS .../health`).

`GET /api/v1/ups` → **200**

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "count": 2,
  "devices": [
    {
      "device_id": "tsshara-3200va-01",
      "brand": "TS Shara",
      "model": "Universal UPS Senoidal 3200VA",
      "transport": "usb-serial-cdc-acm",
      "protocol": "megatec-q1",
      "serial_port": "/dev/ttyACM0",
      "communication_state": "ok",
      "telemetry_valid": true,
      "telemetry_endpoint": "/api/v1/ups/tsshara-3200va-01/telemetry",
      "identity_endpoint": "/api/v1/ups/tsshara-3200va-01/identity",
      "capabilities": {
        "battery_test": {
          "supported": true, "enabled": false, "test_types": ["duration_10s"],
          "duration_s": 10.0, "sample_interval_s": 0.4, "cooldown_s": 300.0,
          "min_battery_percent": 50.0, "abort_supported": false
        }
      }
    },
    {
      "device_id": "sms-ups3200s-01",
      "brand": "SMS",
      "model": "Power Sinus NG uPS3200S",
      "transport": "usb-serial",
      "protocol": "sms-1phase",
      "serial_port": "/dev/ttyUSB0",
      "communication_state": "ok",
      "telemetry_valid": true,
      "telemetry_endpoint": "/api/v1/ups/sms-ups3200s-01/telemetry",
      "identity_endpoint": "/api/v1/ups/sms-ups3200s-01/identity",
      "capabilities": {
        "battery_test": {
          "supported": true, "enabled": true, "test_types": ["duration_10s"],
          "duration_s": 10.0, "sample_interval_s": 0.4, "cooldown_s": 300.0,
          "min_battery_percent": 50.0, "abort_supported": true
        }
      }
    }
  ]
}
```

`capabilities.battery_test` is the test's **discovery contract**: `enabled` says whether the device
accepts `POST .../tests`, `abort_supported` says whether `POST .../tests/{id}/abort` exists (`false` on
the TS Shara) and the other fields are the effective parameters of the device.

`GET /api/v1/ups/{device_id}/telemetry` → **identical** envelope for both protocols; the **content** of
`measurements` and the battery block change according to the protocol (§7).

`GET /api/v1/ups/inexistente/telemetry` → **404**

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "error": {
    "code": "device_not_found",
    "message": "device 'inexistente' is not configured (available: sms-ups3200s-01, tsshara-3200va-01)"
  }
}
```

`POST /api/v1/ups` → **405** (the only path that accepts `POST` is `/api/v1/ups/{device_id}/tests`)

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "error": {
    "code": "method_not_allowed",
    "message": "method not allowed on this resource: telemetry is read-only and only /api/v1/ups/{device_id}/tests accepts POST"
  }
}
```

## 6. JSON contract

### 6.1 Common envelope

All responses (including errors) carry `api_version` (`v1`) and `contract_version` (`3.0`).
Dates in **ISO 8601 UTC** with milliseconds and a `Z` suffix. Numbers with the **unit explicit in the
field name**.

The `/telemetry` response is composed of:

| Key | Content |
|---|---|
| `api_version` / `contract_version` | Contract versions |
| `device_id` | Device identifier |
| `telemetry_valid` | `true` only if there is a **fresh** read (age ≤ `stale_after_s`) |
| `stale` | `true` if the last valid read has aged |
| `data_available` | `true` if there is any valid read (even stale) |
| `data` | Telemetry (or `null`) — `captured_at_utc`, `source`, `measurements`, `status`, `raw_frame`, `age_seconds` and the protocol battery block |
| `communication` | Collection state: `state`, counters, `last_error`, `serial_port`, `poll_interval_s`, `stale_after_s` |

### 6.2 Common measurements (`data.measurements`)

Present in **both** protocols, with the same name and unit:

| Field | Unit | Meaning |
|---|---|---|
| `input_voltage_v` | V | Input voltage |
| `output_voltage_v` | V | Output voltage |
| `load_percent` | % | Load percentage |
| `temperature_c` | °C | Internal temperature |

### 6.3 Protocol-specific measurements (extensions per protocol)

The project statement expressly asked to **not break** the existing monitoring items, so each protocol
**preserves the field names of the original API**:

| Field | Protocol | Origin |
|---|---|---|
| `input_voltage_fault_v` | `megatec-q1` | Input voltage (fault indication) — field 2 of the `Q1` frame |
| `input_frequency_hz` | `megatec-q1` | **Input** frequency — field 5 of the `Q1` frame |
| `battery_voltage_v` | `megatec-q1` | Battery voltage — field 6 of the `Q1` frame |
| `input_voltage_extended_v` | `sms-1phase` | Extended input scale — bytes 1–2 of the `Q` frame |
| `output_frequency_hz` | `sms-1phase` | **Output** frequency — bytes 9–10 of the `Q` frame |

> The name difference (`input_frequency_hz` × `output_frequency_hz`) is intentional: it is the name each
> device already published before the unification.

### 6.4 States (`data.status`)

`raw_bits` preserves the 8 bits as received; `active` lists the flags that are on; `flags` brings all
eight. The order presented is **b7 … b0** in both protocols (in SMS, `raw_byte` brings the decimal value
of the byte).

| Protocol | Bit | Flag | Meaning |
|---|---|---|---|
| `megatec-q1` | b7 | `OB` | Operating on battery |
| `megatec-q1` | b6 | `LB` | Low battery |
| `megatec-q1` | b5 | `BOOST` | Voltage boost |
| `megatec-q1` | b4 | `FAULT` | UPS fault |
| `megatec-q1` | b3 | `STANDBY` | Standby mode |
| `megatec-q1` | b2 | `TEST` | Test in progress |
| `megatec-q1` | b1 | `FSD` | Scheduled shutdown |
| `megatec-q1` | b0 | `BEEP` | Audible alarm |
| `sms-1phase` | b7 | `OB` | Mains absent / on battery |
| `sms-1phase` | b6 | `LB` | Low battery |
| `sms-1phase` | b5 | `BYPASS` | Bypass active |
| `sms-1phase` | b4 | `BOOST` | Boost/Buck active |
| `sms-1phase` | b3 | `UPSOK` | Inverter/mains OK (no fault) |
| `sms-1phase` | b2 | `TEST` | Test in progress |
| `sms-1phase` | b1 | `FSD` | Shutdown active |
| `sms-1phase` | b0 | `BEEP` | Beeper on |

### 6.5 Battery — **opposite** rule per protocol

| Protocol | Block | Source of the percentage | Voltage |
|---|---|---|---|
| `megatec-q1` | `battery_charge` | **estimated** by linear interpolation of the voltage | **comes** from the device (`battery_voltage_v`) |
| `sms-1phase` | `battery` | **comes** from the device (`charge_percent`) | **derived**: `nominal × percentage / 100` |

`battery_charge` (TS Shara):

```json
"battery_charge": {
  "percent": 100.0,
  "estimated": true,
  "method": "linear_voltage_interpolation",
  "calibration": { "voltage_low_v": 20.1, "voltage_high_v": 26.8 }
}
```

`battery` (SMS):

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

### 6.6 Identification and ratings (`/identity`)

- `data.device`: device identification. `megatec-q1` returns `manufacturer`, `model` and `firmware`
  (`I` frame, fixed widths); `sms-1phase` returns `model` and `firmware`.
- `data.nominal`: nominal characteristics (`F` frame) — `voltage_v`, `input_current_a`,
  `battery_voltage_v`, `frequency_hz` and the original textual labels.
- `configured`: logical identity, `brand`, `model`, `protocol`, `transport`, port in use (or configured),
  `serial_baud`, `poll_interval_s` and `stale_after_s`.
- `raw_frame` in both preserves the original frame, for auditing.

### 6.7 Communication states (`communication.state`)

| `state` | Meaning / cause | Effect on the contract |
|---|---|---|
| `starting` | Still no completed attempt | `telemetry_valid=false`, `data=null`, HTTP 503 |
| `ok` | Last attempt successful | Read published (HTTP 200 if fresh) |
| `stale` | Last valid read older than `stale_after_s` | `data` preserved, `telemetry_valid=false`, HTTP 503 |
| `port_unavailable` | Port not found, non-existent **or in use by another process** | No new read; HTTP 503 |
| `permission_denied` | User without access to the port | No new read; HTTP 503 |
| `disconnected` | USB disconnection during operation | No new read; HTTP 503 |
| `timeout` | No response within `command_wait_s` | No new read; HTTP 503 |
| `invalid_response` | Response without a recognizable frame | No new read; HTTP 503 |
| `incomplete_response` | Recognizable frame, but truncated | No new read; HTTP 503 |
| `checksum_error` | Frame checksum does not match (SMS) | No new read; HTTP 503 |
| `parse_error` | Non-numeric field / malformed frame | No new read; HTTP 503 |
| `out_of_range` | Value outside the plausible range (sanity) | No new read; HTTP 503 |
| `serial_error` | Other I/O failure on the port | No new read; HTTP 503 |

Each failure feeds `communication.last_error` (`code`, `message`, `at_utc`) and
`communication.consecutive_failures`. `last_success_utc` is **not** erased by subsequent failures, which
allows distinguishing "UPS in failure" from "collector without communication".

A failure in reading the identification (`I`/`F`) **does not** invalidate the telemetry: `/identity`
responds 503 and `/telemetry` continues normal.

### 6.8 Battery test (contract 3.0)

The test is an **action**: the UPS momentarily starts operating on battery, the collector samples at high
frequency and the series becomes a **predictability report** (charge drop, voltage and frequency
oscillation, temperature variation and estimated runtime) **with the complete timeline** in `samples[]`.

There are **two types** of test (`type` in the `POST`):

| `type` | What it does | How it ends | Where it exists |
|---|---|---|---|
| `duration_10s` (default) | **fixed** window of ~10 s (`test_duration_s`) | end of the window (or `watchdog`) | all protocols with a test |
| `discharge_20pct` | **no window**: runs until the reported charge falls to the **fixed target of 20 %** | target reached (`target_percent_reached`) or the safety ceiling of **30 min** (`watchdog`) | **only** where the protocol is able to **cancel** the test — today, only `sms-1phase` (`abort_supported: true`) |

`duration_10s` is the **only** type of `megatec-q1` (TS Shara): it does not know how to cancel the test,
so a "no window" test would only end when the battery dropped — which **shuts down the servers**. In this
protocol, therefore, the API **does not accept** `discharge_20pct` (`422 unsupported_test_type`).

For **any** type the API is the one that **commands the stop**: the endings in which the UPS may continue
in test (`duration_elapsed`, `target_percent_reached`, `battery_low`, `watchdog`, `aborted`, `stopping`)
always follow with the protocol's **cancellation command**, when it exists (§6.8.6).

> **WARNING — incident of 2026-10-22 (test that would not stop) — FIXED.** In `sms-1phase` the `T` command
> **requires the duration parameter** (`Param1` = time in seconds). The driver was sending `T` with
> `Param1 = 0xFF`, and the firmware interpreted `0xFF` as "**no defined duration**", running the test
> **discharging the battery down to the low level** (practical effect equivalent to the `L` command).
> Worse: the collector closed the sampling window in ~10 s (`finish_reason: "duration_elapsed"`), but
> **did not send the `D` cancellation** at the end of the window (the `D` was only sent on the `aborted`
> path), so the UPS **kept testing indefinitely** (`TEST`+`OB`+`BOOST`+`BEEP`), draining the battery from
> 100 % to 18 %.
> - **Defective** command sent: `T` → `54 ff ff ff ff b0 0d`.
> - **Correct** command for 10 s: `T` with `Param1 = 10` → `54 0a ff ff ff a5 0d`.
> - General checksum (any parameter): `(-sum(bytes[0..4])) & 0xFF` — the formula `(4 - ord(cmd)) & 0xFF`
>   only holds when the four parameters are `0xFF`.
> - **Fix applied on 2026-10-22:** the driver started sending `T` **with** `Param1 = test_duration_s`
>   (`action_bytes`; ceiling `0xFE`, since `0xFF` is reserved) and the collector started sending `D` on
>   **every** ending in which the UPS may continue in test. Validated live — see
>   [tests-and-evidence.md](../../SMS/Power_Sinus_NG_uPS3200S/docs/tests-and-evidence.md) T11.
> - **The same `0xFF` in `Param1` is what the `discharge_20pct` type uses on purpose** ("no duration"),
>   now with the cancellation guaranteed by the collector upon reaching the target — see
>   [battery-test-api-contract.md](battery-test-api-contract.md).

**Commands per protocol** (sent **only** by the collector):

| Protocol | Start | Cancellation | `abort_supported` |
|---|---|---|---|
| `sms-1phase` | `duration_10s`: `T` + `Param1` = duration → `54 0a ff ff ff a5 0d`; `discharge_20pct`: `T` + `Param1 = 0xFF` (no duration, on purpose) → `54 ff ff ff ff b0 0d` | `D` → `44 ff ff ff ff c0 0d` | `true` |
| `megatec-q1` | `T` → `54 0d` (`"T\r"`, without parameter) | — | `false` |

These are **action** commands (*fire-and-forget*): there is no response to read. The effect is observed in
the status read itself — the `TEST` flag turns on during the window (`OB` may also appear while the UPS is
on battery).

> The window **watchdog** (`requested duration + 2 s`, or the **30 min ceiling** in `discharge_20pct`)
> only **stops sampling**; what ends the test on the device is the `D` sent right after. In `sms-1phase`
> this is essential: the test does **not** end by itself when the duration is interpreted as undefined
> (incident T10).

#### 6.8.1 Input (request)

`POST /api/v1/ups/{device_id}/tests`

| Item | Required | Content |
|---|---|---|
| `Content-Type: application/json` | No | Missing/empty body is equivalent to `{}` |
| `type` | No | `"duration_10s"` (default when omitted) or `"discharge_20pct"` (only with `abort_supported: true`) |

```json
{ "type": "duration_10s" }
```

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/ups/sms-ups3200s-01/tests \
     -H 'Content-Type: application/json' \
     -d '{"type":"duration_10s"}' | python3 -m json.tool

# controlled discharge test: stops by itself at the 20 % target (or at the 30 min ceiling)
curl -s -X POST http://127.0.0.1:8080/api/v1/ups/sms-ups3200s-01/tests \
     -H 'Content-Type: application/json' \
     -d '{"type":"discharge_20pct"}' | python3 -m json.tool
```

#### 6.8.2 Output — acceptance (`202 Accepted`)

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

In `discharge_20pct` the same payload comes with `"requested_duration_s": null`, `"target_percent": 20.0`,
`"timeout_s": 1800.0`, `"sample_interval_s": 2.0` and `expected_end_at_utc` = start + **30 min** (the
**ceiling**, not a predicted duration — the test usually ends earlier, when the charge reaches 20 %).

`status` already comes as `running` at acceptance because the request was only **enqueued**: the execution
starts on the next collector cycle (up to `poll_interval_s`, default 5 s). Therefore the report only
becomes ready a little after `expected_end_at_utc`. The consumer follows it by **polling** at `report_url`
(suggestion: `poll_interval_s` of the acceptance, **0.5 s**) — and, during the test, already receives the
**partial** `samples[]` to draw the live curve.

#### 6.8.3 Output — refusals (decided in memory, without touching the serial port)

| HTTP | `error.code` | When |
|---|---|---|
| `403` | `test_disabled` | `allow_battery_test` is not `true` on the device |
| `422` | `unsupported_test_type` | `type` outside those accepted **by this device** (e.g. `discharge_20pct` on `megatec-q1`) |
| `422` | `test_not_supported` | the device's protocol does not offer a test |
| `422` | `test_requires_battery_percent` | `discharge_20pct` with telemetry **without** a battery percentage (the target could not be evaluated) |
| `404` | `device_not_found` | `device_id` not configured |
| `400` | `invalid_request` | body is not a valid JSON object (or `type` is not a string) |
| `409` | `test_unavailable` | no **fresh** telemetry (state `stale`/`starting`) or collection loop terminated |
| `409` | `test_in_progress` | there is already a test in progress on this device |
| `409` | `on_battery` | the UPS is **already** on battery (flag `OB`) |
| `409` | `battery_low` | flag `LB` on |
| `409` | `battery_too_low` | charge below `test_min_battery_percent` |
| `409` | `battery_at_target` | `discharge_20pct` with the charge **already** at the target (≤ 20 %) — there is nothing to discharge |
| `409` | `test_cooldown` | still within `test_cooldown_s` of the last test |

#### 6.8.4 Output — report (`GET .../tests/{test_id}` → **200**)

While `status = "running"`, `samples` comes **partial** (what has already been sampled) and
`deltas`/`estimate` are still `null`. At the end, the report is complete:

> **Illustrative example** — the **shape** of the payload is this; the **numbers** below are example
> values (they are not a real measurement). The real report comes from your device.

```json
{
  "api_version": "v1",
  "contract_version": "3.0",
  "device_id": "sms-ups3200s-01",
  "test": {
    "test_id": "9f3c1a7b2d4e5061",
    "device_id": "sms-ups3200s-01",
    "type": "duration_10s",
    "status": "completed",
    "started_at_utc": "2026-10-22T15:04:16.901Z",
    "expected_end_at_utc": "2026-10-22T15:04:26.900Z",
    "ended_at_utc": "2026-10-22T15:04:27.033Z",
    "requested_duration_s": 10.0,
    "duration_s": 10.032,
    "sample_interval_s": 0.4,
    "finish_reason": "duration_elapsed",
    "test_flag_observed": true,
    "flags_seen": ["BEEP", "BYPASS", "OB", "TEST", "UPSOK"],
    "baseline": {
      "input_voltage_v": 218.6, "output_voltage_v": 217.7, "load_percent": 19.0,
      "temperature_c": 49.1, "frequency_hz": 59.9,
      "battery_charge_percent": 100.0, "battery_voltage_v": 24.0
    },
    "final": {
      "input_voltage_v": 218.6, "output_voltage_v": 217.4, "load_percent": 26.0,
      "temperature_c": 49.1, "frequency_hz": 59.9,
      "battery_charge_percent": 92.5, "battery_voltage_v": 22.2
    },
    "deltas": {
      "window_s": 10.032,
      "sample_count": 25,
      "metrics": {
        "battery_charge_percent": {
          "start": 100.0, "end": 92.5, "min": 92.5, "max": 100.0,
          "delta": -7.5, "ripple": 7.5, "max_abs_deviation": 7.5, "count": 25
        },
        "output_voltage_v": {
          "start": 217.7, "end": 217.4, "min": 217.4, "max": 218.0,
          "delta": -0.3, "ripple": 0.6, "max_abs_deviation": 0.6, "count": 25
        },
        "load_percent": {
          "start": 19.0, "end": 26.0, "min": 19.0, "max": 26.0,
          "delta": 7.0, "ripple": 7.0, "max_abs_deviation": 7.0, "count": 25
        }
      }
    },
    "estimate": {
      "available": true,
      "method": "linear_regression_trimmed",
      "window_s": 10.032,
      "readings_total": 25,
      "readings_used": 23,
      "transient_readings_dropped": 2,
      "drop_percent_in_window": 7.5,
      "drop_percent_used": 4.5,
      "discharge_rate_pp_per_min": 26.9,
      "reference_charge_percent": 95.5,
      "estimated_runtime_min": 3.6,
      "capped_at_min": 600.0,
      "confidence": "low"
    },
    "samples_count": 25,
    "error": null,
    "samples": [
      {
        "offset_s": 0.401,
        "measurements": {
          "input_voltage_extended_v": 0.0, "input_voltage_v": 218.6,
          "output_voltage_v": 218.0, "load_percent": 19.5,
          "output_frequency_hz": 59.9, "temperature_c": 49.1
        },
        "status": { "raw_bits": "00101101", "raw_byte": 45,
                    "active": ["BEEP", "TEST", "UPSOK", "BYPASS"],
                    "flags": { "OB": false, "LB": false, "BYPASS": true, "BOOST": false,
                               "UPSOK": true, "TEST": true, "FSD": false, "BEEP": true } },
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

**Reading the fields**

| Field | Meaning |
|---|---|
| `baseline` | Valid read **immediately before** the test (the reference for the comparison) |
| `final` | Last sample of the window |
| `duration_s` | Window **actually** sampled (may differ from `requested_duration_s`) |
| `finish_reason` | Why the window ended (table below) |
| `flags_seen` | Union of all flags seen in the window (reveals `OB`, `TEST`, `LB`…) |
| `test_flag_observed` | `true` if the UPS turned on the `TEST` flag (confirms that the test **really** occurred) |
| `samples[]` | High-frequency series: `offset_s`, `normalized`, `measurements`, `status`, `battery` |
| `deltas.metrics` | Aggregation per metric: `start`, `end`, `min`, `max`, `delta`, `ripple`, `max_abs_deviation`, `count` |
| `estimate` | Runtime predictability (§6.8.5) |
| `error` | `{code, message}` when the test fails (e.g. `no_samples`) |

**Normalized metrics** (same name in both protocols, already unifying the field differences). It is the
`samples[].normalized` block — and these same keys appear in `deltas.metrics` and in `baseline`/`final`:

| Key in `samples[].normalized` / `deltas.metrics` | Origin |
|---|---|
| `input_voltage_v`, `output_voltage_v`, `load_percent`, `temperature_c` | common core (§6.2) |
| `frequency_hz` | `output_frequency_hz` (SMS) or `input_frequency_hz` (TS Shara) |
| `battery_charge_percent`, `battery_voltage_v` | battery block of the protocol (§6.5) |

> It is `deltas.metrics.frequency_hz` — not `input_frequency_hz`/`output_frequency_hz` — that gathers the
> frequency for the report, precisely so that the same read works on both devices. Keys **without a
> value** are **omitted** from `normalized` (they do not come as `null`).
>
> **For charts, use `samples[].normalized`** (standardized names), not `samples[].measurements` (names
> specific to each protocol). The detailing of the series and of the four charts (output
> voltage/frequency, temperature, battery charge) is in
> [battery-test-api-contract.md](battery-test-api-contract.md).

**How to read oscillation:** `ripple` (max − min) and `max_abs_deviation` (largest deviation from `start`)
answer "did the voltage/frequency oscillate a lot?". In `battery_charge_percent`, `ripple` is the charge
drop in the window; in `load_percent`, `delta` answers "did the UPS load increase upon going on battery?".

**`finish_reason`**

| Value | Meaning |
|---|---|
| `duration_elapsed` | The requested window ended normally (expected case of `duration_10s`) |
| `target_percent_reached` | The reported charge reached the target (20 %) — **normal end** of `discharge_20pct` |
| `test_flag_cleared` | The UPS cleared the `TEST` flag before the end |
| `aborted` | Cancellation requested by the client (§6.8.6) |
| `battery_low` | The `LB` flag appeared — safety guard that **ends the test immediately** |
| `watchdog` | Maximum time limit reached (window `duration_s + 2 s`, or the 30 min ceiling in `discharge_20pct`) |
| `stopping` | The service was shut down during the window |
| `serial_error` | The sending of the test command failed (no sample) |

**`status`** (`running` → `completed` \| `aborted` \| `failed`): `failed` when no valid sample was obtained
or when the action command failed.

#### 6.8.5 Runtime estimate (`estimate`)

**First-order** estimate, by **linear** regression of the charge drop, **discarding the initial
transient**:

In the first moments of the test the charge drops much faster than in the rest of the window (ohmic /
electrolyte drop) and **that drop is not the real discharge rate**. The transient stretch is discarded
before the fit:

```text
transient     = initial readings whose drop between consecutive readings is GREATER
                than the typical drop of the window (median of the drops)
rate          = -slope of the regression (least squares) of the remaining readings
runtime_min   = adjusted_charge_at_end_of_window / rate / 60
```

| Field | Content |
|---|---|
| `available` | `false` when there is no measurable drop in the useful stretch (short window / noise) — the `reason` field explains it |
| `method` | `"linear_regression_trimmed"` |
| `readings_total` / `readings_used` | Battery readings in the window and how many entered the fit |
| `transient_readings_dropped` | Initial readings discarded as transient |
| `drop_percent_in_window` / `drop_percent_used` | Charge drop in the whole window and in the stretch used |
| `discharge_rate_pp_per_min` | Discharge rate of the stretch used |
| `reference_charge_percent` | Charge at the end of the window, adjusted by the regression |
| `estimated_runtime_min` | Estimated runtime, limited to `capped_at_min` (**600 min**) |
| `confidence` | **`"low"`** — 10 s is short and the real discharge is almost never linear |

> **Division of responsibility (decided in the project):** this API publishes **facts** (complete series,
> aggregations and the first-order extrapolation). The **definitive predictability model/policy** and the
> presentation stay with the **sibling project** (Web Viewer). The API **does not** turn
> `available: false` into a number.

#### 6.8.6 Interrupting a test in progress

`POST /api/v1/ups/{device_id}/tests/{test_id}/abort` → **202**

```json
{ "api_version": "v1", "contract_version": "3.0", "device_id": "sms-ups3200s-01",
  "test_id": "9f3c1a7b2d4e5061", "status": "aborting" }
```

- The `abort` only **marks** an event; the collector closes the window on the next cycle and records
  `finish_reason: "aborted"` and `status: "aborted"` — with **the samples already collected preserved**.
- In `sms-1phase` the collector **sends the cancellation** (`D`) to the UPS **on this path** (`aborted`).
  In `megatec-q1` there is no cancellation command: the "abort" only **stops sampling** (the UPS completes
  the 10 s test on its own).
- The `D` is also sent on the **normal termination** of the window (`duration_elapsed`/watchdog) and on the
  collector shutdown — in `sms-1phase` the test does not end by itself if the duration is interpreted as
  undefined (incident T10).
- Aborting a test that is **not** running → **409** `test_not_running`; non-existent `test_id` →
  **404** `test_not_found`.

#### 6.8.7 List (`GET .../tests?limit=N` → **200**)

Returns the recent tests (newest first) **without** the sample series, so the consumer can build a
history/trend chart:

```json
{
  "api_version": "v1", "contract_version": "3.0",
  "device_id": "sms-ups3200s-01", "count": 1,
  "tests": [
    { "test_id": "9f3c1a7b2d4e5061", "type": "duration_10s", "status": "completed",
      "started_at_utc": "2026-10-22T15:04:16.901Z",
      "expected_end_at_utc": "2026-10-22T15:04:26.900Z",
      "ended_at_utc": "2026-10-22T15:04:27.033Z",
      "duration_s": 10.032, "finish_reason": "duration_elapsed",
      "samples_count": 25, "flags_seen": ["BEEP", "BYPASS", "OB", "TEST", "UPSOK"],
      "estimate": { "available": true, "estimated_runtime_min": 2.2, "confidence": "low" },
      "error": null }
  ]
}
```

The history is **in memory** (`test_history_size` per device) and is lost when the service restarts.

> **Handover documents for the sibling project (Web Viewer):**
> [battery-test-api-contract.md](battery-test-api-contract.md) — **how the data is sent** (complete
> layout of `samples[]`, the two types, flow and the four charts); and
> [battery-test-quadrant.md](battery-test-quadrant.md) — **how to apply** this data in the *Battery Test
> quadrant*.

## 7. Modules of the `upsmon` package

| Module | Responsibility |
|---|---|
| `config.py` | Configuration: `[upsmon]` section + `[device:*]` blocks, precedence and validation |
| `models.py` | Common envelope of the contract (`Telemetry`, `Identity`, `CollectionState`, `Snapshot`) + battery test (`BatteryTest`, `TestSample`) |
| `serial_link.py` | Serial transport: auto-detection by VID:PID, exclusive lock, failure classification, `send_action` (action command without reading, receives the test duration) |
| `drivers/megatec_q1.py` | Megatec/Q1 driver (ASCII text) — TS Shara; `CMD_TEST_10S = "T"`, without cancellation |
| `drivers/sms_1phase.py` | SMS Brazil 1Phase driver (binary) — SMS; `CMD_TEST_10S = "T"` (duration in `Param1` via `action_bytes`), `CMD_TEST_ABORT = "D"` |
| `collector.py` | One collector (thread) per device, in-memory state, log deduplication and execution of the battery test (high-frequency window + report) |
| `http_api.py` | Multi-device HTTP/REST layer (read-only telemetry + test endpoints) |
| `cli.py` | Command-line entry point (`--config --list --check`) |

**Adding a protocol:** implement a driver in `drivers/` (a subclass of `Driver` with `protocol`, `CMD_*`,
`command_bytes`, `parse_status`, `parse_identity`, `parse_ratings` and, if there is a battery test,
`CMD_TEST_10S`/`CMD_TEST_ABORT`) and register it in `drivers/__init__.py::_registry()`. No other layer
changes: a new `[device:*]` block with `protocol = <new>` is enough.

## 8. Migration from the per-device APIs

The unified API **replaces** the two previous services. Since the serial port has an exclusive lock, the
old services **cannot** run at the same time as `upsmon-api`.

| Service / process | Before | After |
|---|---|---|
| `upsmon-api.service` (unified) | — | **8080** (all devices) |
| `ts-shara-api.service` (legacy) | 8080 | 8081 (disabled) |
| SMS `scripts/run_api.py` (ad-hoc) | 8081 | 8082 (terminated) |

Migration sequence (requires `sudo`):

```bash
cd monitor

# 1) disable the legacy TS Shara service (frees ports 8080 and serial /dev/ttyACM0)
sudo systemctl disable --now ts-shara-api.service

# 2) REMOVE the legacy udev rule: it restarts ts-shara-api when the TS Shara cable is
#    reconnected, and `systemctl restart` re-enables the unit even when disabled -- this
#    would take the serial port from upsmon. The 99-upsmon.rules covers both devices.
sudo rm -f /etc/udev/rules.d/99-ts-shara-ups.rules /etc/udev/rules.d/99-sms-ups.rules

# 3) terminate the ad-hoc SMS API (port 8081) -- confirm the PID on the port before terminating
ss -ltnp | grep ':8081'
kill <SMS_API_PID>

# 4) install and activate the unified API on 8080 (also reloads udev)
sudo scripts/install_service.sh

# 5) validate
python3 -m upsmon --config /etc/upsmon/upsmon.conf --list
python3 -m upsmon --config /etc/upsmon/upsmon.conf --check
curl -s http://127.0.0.1:8080/health | python3 -m json.tool
curl -s http://127.0.0.1:8080/api/v1/ups | python3 -m json.tool
```

**Rollback:** `sudo systemctl disable --now upsmon-api` and `sudo systemctl enable --now ts-shara-api`
(or `python3 scripts/run_api.py` in the model folder). When going back to the isolated APIs, reinstall the
model's udev rule (`sudo install -m 0644 config/examples/99-ts-shara-ups.rules /etc/udev/rules.d/`).
The two old APIs remain in the repository, on ports 8081 and 8082.

### 8.1 Impact on consumers (Zabbix)

- **Telemetry items remain valid:** the field names of `measurements`, `status`,
  `battery_charge`/`battery` and `raw_frame` were **preserved**. What changes is only the **port**
  (8080) — and, for the TS Shara, the port used to be 8080 and is now the same 8080 served by the unified
  app.
- **Port:** all URLs become `http://127.0.0.1:8080/api/v1/ups/{device_id}/...`.
- **`/health` changed shape:** before there were `checks.*` of a single device; now the payload is
  **multi-device** (`devices_total`, `devices_ok`, `devices.{device_id}.*`). *Trigger* items that read
  `checks.serial_communication` must now read `devices.{device_id}.communication` (or use the device's
  `/telemetry`, whose `communication.state` field did not change).

## 9. Log

- One logger per layer: `upsmon.collector`, `upsmon.api`, `upsmon.cli`.
- **Deduplication:** the same failure (context + code + message) is only written again after **300 s**;
  in the intermediate cycles it stays at `DEBUG` — it avoids filling the journal with the cable out for
  hours.
- **Heartbeat:** every **12** valid collections a summary is logged at `INFO` per device.
- Milestones logged: first valid telemetry, recovery after failures, updated identification, endpoints
  published at startup, and shutdown.
- All records are prefixed with the `device_id` (`[sms-ups3200s-01] ...`), for reading in the journal.

## 10. Testing and validation

### 10.1 Automated tests (without hardware)

```bash
cd monitor
python3 -m unittest discover -s tests -t . -v     # 95 tests
```

| File | Coverage |
|---|---|
| [tests/test_drivers.py](../tests/test_drivers.py) | Driver registry, command bytes of both protocols (**includes the test action commands**: `T`/`D`), parsing of `Q1`/`Q`/`I`/`F`, battery helpers and per-device calibration |
| [tests/test_collector.py](../tests/test_collector.py) | Common envelope per protocol, in-memory state, failure classification, staleness, **isolation between devices**, **full test flow** (predictability report, abort with/without cancellation, termination by the `TEST` flag) and **preconditions** (cooldown, minimum charge, test in progress) |
| [tests/test_http_api.py](../tests/test_http_api.py) | Real HTTP with **two** devices on the same port: index (contract 3.0), `/api/v1/ups` with `capabilities`, telemetry and identity of each protocol, `/health` `ok`/`degraded`/`down`, 405, **test endpoints (202/403/404/409/422/400)** and the requirement "an HTTP request does not trigger a serial read" |

The tests use a fake serial link and a controlled clock (dependency injection), so they **do not** open the
real ports of the UPS devices.

### 10.2 Validation with the hardware (procedure)

```bash
# 1) confirm the loaded configuration
python3 -m upsmon --config /etc/upsmon/upsmon.conf --list

# 2) one collection per device (JSON indexed by device_id)
python3 -m upsmon --config /etc/upsmon/upsmon.conf --check | python3 -m json.tool

# 3) consume the API (with the service up)
for path in /health /api/v1/ups \
            /api/v1/ups/tsshara-3200va-01/telemetry \
            /api/v1/ups/sms-ups3200s-01/telemetry ; do
  echo "--- $path"
  curl -s -o /dev/stdout -w ' [HTTP %{http_code}]\n' "http://127.0.0.1:8080$path"
done
```

Failure scenarios reproducible without shutting down the device:

| Scenario | How to trigger | Expected |
|---|---|---|
| One device without a cable | disconnect only one USB | `/health` `degraded`; only the affected device goes to 503, the other continues 200 |
| Port in use | keep the API running and run `monitor_collector.py` in parallel | `port_unavailable` with an exclusive-lock message |
| USB disconnection | remove the cable and observe `/health` | `disconnected` (or `port_unavailable`); `last_success_utc` preserved; `stale` after `stale_after_s` |
| No read | start the API without the UPS devices | `/telemetry` 503, `data = null`, no fictitious values |

### 10.3 Battery test with the hardware (procedure)

> The test **switches to battery for ~10 s**. Do it with the UPS **without critical load** and watch the
> first run closely.

```bash
B=http://127.0.0.1:8080
DEV=sms-ups3200s-01

# 1) does the device accept a test? (supported/enabled/abort_supported)
curl -s "$B/api/v1/ups" | python3 -m json.tool | grep -A8 battery_test

# 2) trigger the test and store the test_id (the body is optional)
ACCEPTED=$(curl -s -X POST "$B/api/v1/ups/$DEV/tests" \
                -H 'Content-Type: application/json' -d '{"type":"duration_10s"}')
echo "$ACCEPTED" | python3 -m json.tool
TEST_ID=$(echo "$ACCEPTED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["test_id"])')

# 3) follow it until it leaves "running" (partial -> complete)
while :; do
  curl -s "$B/api/v1/ups/$DEV/tests/$TEST_ID" | python3 -m json.tool | grep '"status"'
  sleep 1
done

# 4) final report: charge drop, oscillation and estimated runtime
curl -s "$B/api/v1/ups/$DEV/tests/$TEST_ID" | python3 -m json.tool

# 5) history (without the sample series)
curl -s "$B/api/v1/ups/$DEV/tests?limit=5" | python3 -m json.tool
```

Cancellation (only `sms-1phase` sends the `D` command; on the TS Shara it only stops sampling):

```bash
curl -s -X POST "$B/api/v1/ups/$DEV/tests/$TEST_ID/abort" | python3 -m json.tool   # 202 aborting
```

After the test, the first thing to check is `test_flag_observed: true` (the UPS really entered test) and
`finish_reason: "duration_elapsed"`.

## 11. Security and limits

- **The write is a single one and it is optional per device:** only `POST .../tests` (and the `abort`)
  leave read-only mode, and they exist only for devices with `allow_battery_test = true` (default:
  **disabled**).
- **No other action command is implemented.** From Megatec only `T` (short test); from SMS only `T`
  (test) and `D` (cancellation). The others (`TL`/`S` in Megatec; `M`/`L`/`S`/`R`/`C` in SMS) **do not**
  exist in any layer — no consumer can turn off, silence or reset the UPS.
- **`duration_10s` never reaches low battery:** the window is fixed (~10 s) and there are guards that end
  it immediately (`LB`) or refuse the request (`OB`, charge below the minimum, cooldown).
- **`discharge_20pct` discharges on purpose, but in a controlled way:** it **only** exists where the
  protocol is able to **cancel** the test, the target is fixed at **20 %** and the API **commands the
  cancellation** upon reaching it (or at the 30 min ceiling, or if `LB` appears). There is no test down to
  the critical level.
- No sensitive data is published: only telemetry, identification, collection metadata and test reports.
- There is no authentication in this version — publish the port only on the management network (to enable
  the test, prefer restricting who can reach `POST .../tests`).

## 12. Versioning

| Version | Change |
|---|---|
| `v1` / contract `1.0` | First public version (per device): `/health`, `/api/v1`, `/api/v1/ups`, `/telemetry`, `/identity` |
| `v1` / contract `2.0` | **Multi-device**: one instance and one port for N devices; `/api/v1/ups` lists all; `device` gains `manufacturer`; `/health` starts aggregating by `device_id` |
| `v1` / contract `3.0` | **On-demand battery test** (major: the API stops being strictly read-only): `POST .../tests`, `GET .../tests`, `GET .../tests/{id}`, `POST .../tests/{id}/abort`; `capabilities.battery_test` in `/api/v1/ups`; `read_only: false` and `capabilities` in the index |

About the **2.0 → 3.0 break**: no existing field changed name, was removed or had its type changed —
telemetry remains identical. What changes is the **nature** of the API (it starts accepting writes). The
consumer that compares `contract_version` should treat `3.0` as a **warning**, not as an error (the Web
Viewer already does this — see [web-viewer-integration.md](web-viewer-integration.md)).

Incompatible changes will require a new prefix (`/api/v2`) and an increment of `contract_version`;
compatible additions only increment `contract_version`.

## 13. Out of scope (next stages)

- Web application / dashboards — the existing consumer is the sibling project **UPS Monitor — Web Viewer**
  (Docker). What it needs to know to consume this API — **including the battery test button and report** —
  is in [web-viewer-integration.md](web-viewer-integration.md) (§11).
- Definitive Zabbix integration (the port unification has already been done; the template/items is still a
  stage of its own) — see
  [zabbix-integration.md](../../TS_Shara/Universal_UPS_Senoidal_3200VA/docs/zabbix-integration.md)
  and [zabbix-integration.md](../../SMS/Power_Sinus_NG_uPS3200S/docs/zabbix-integration.md).
- **Second-order predictability model** (trend between tests, `tests[]` history): it stays with the
  sibling project — the API delivers the facts and the first-order linear extrapolation (§6.8.5).
