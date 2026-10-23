# Tests and evidence

Chronological record of the experiments. Environment: Ubuntu 24.04.5 (the reference host), TS Shara
Senoidal 3200 UNIV. UPS over USB, TS App closed, cable connected only to Ubuntu.

## T1 — System and USB inventory — 2026-10-20 12:17

- **Goal:** record the OS/kernel and identify the UPS in the USB tree.
- **Commands:** `lsb_release -a`, `uname -a`, `date`, `lsusb`, `lsusb -t`, reading of `/sys/bus/usb/devices/`.
- **Result:** UPS identified as `0483:5740 STMicroelectronics STM32 Virtual ComPort`,
  CDC class (`02`), port `/dev/ttyACM0`. **It is not HID.**
- **Conclusion:** `usbhid-ups` discarded; the transport is serial.

## T2 — Passive read (search for spontaneous transmission)

- **Goal:** check whether the UPS sends data without being polled.
- **Method:** open `/dev/ttyACM0` at 2400/9600/19200/115200 and read for ~1 s.
- **Result:** **0 bytes** at all bauds. The protocol is **poll-based**.

## T3 — Probing known Megatec commands

- **Commands tested:** `Q1`, `Q`, `F`, `I`, `T`, `M`, `D`, `V`, `QS`, `?`, `!?`, `TL`.
- **Result:** only **`Q1`**, **`I`** and **`F`** responded.
- **Samples:**
  - `Q1\r` → `(228.0 228.0 115.0 074 60.0 22.8 26.0 10001100`
  - `I\r`  → `#TS -222  091225 Senoid  32 V01020805A`
  - `F\r`  → `#Univ. 100 24.00 60.0`

## T4 — Full command scan

- **Method:** send `A`–`Z`, `a`–`z`, `0`–`9` (each + `<CR>`) and record the responses.
- **Result:** **3 of 64** commands responded (F, I, Q1). **Minimal** protocol implementation.

## T5 — Autodetection and operation by NUT (`nutdrv_qx`)

- **Command:** `nutdrv_qx` driver with `port=/dev/ttyACM0`, protocol autodetection.
- **Result:** detected protocol = **Megatec 0.07**; battery initialized
  (`Autodetected 1 as number of battery packs [24/22.00]`); stable polling loop; no communication errors.
- **Conclusion:** **NUT officially supports the device** — no custom driver is needed.

## T6 — NUT variable dump

- **Command:** `nutdrv_qx -a ts_shara -d 2`.
- **Result:** see [variables-and-tsapp-comparison.md](variables-and-tsapp-comparison.md).
- **Highlights:** `ups.status: OB CAL`, `battery.charge: 23` (derived), `input.voltage: 228.0`,
  `output.voltage: 115.0`, `ups.load: 88`, `ups.temperature: 26.0`.

## T7 — Battery voltage monitoring over time

- **Goal:** observe the variation of readings under normal operation.
- **`battery.voltage` samples (V):** 22.8 → 22.6 → 22.4 → 22.0 → 21.4 → 20.4 → 19.8 → 18.0 → 16.8 → 17.4 → 15.2.
- **Observation:** a **monotonic and pronounced drop** throughout the session (~12:20–12:36), with `ups.status` remaining at `OB`.
  On a healthy device of the same family, the NUT DDL records `battery.voltage ≈ 27.4 V` (in float/charge).
- **Hypotheses:** (a) device genuinely in battery mode; (b) `OB` bit stuck at 1 by firmware combined with a weak/discharged
  battery. Requires physical verification + comparison with the TS App.

## T8 — Validation of the repository scripts

- `probe_serial.py` → port discovery and probing OK (3 commands recognized).
- `ts_shara_collector.py --identify` → reading and parsing OK, with device identification.
- `ts_shara_collector.py --json` → intact JSON, ready for Zabbix.

## T9 — Retest on a new unit (no load) — 2026-10-20 15:41

- **Goal:** revalidate status and battery on a unit of the **same model** and **with no load** (only the charger of
  an Asus Vivobook notebook, 19 V / 2.37 A), avoiding a repeat of the battery discharge that occurred on the previous unit.
- **Commands:** read-only — `Q1`, `I`, `F` (via `ts_shara_collector.py --identify`). **No** `T`/`TL`/`S`.
- **Samples:**
  - `Q1` → `(001.0 001.0 115.0 008 60.0 24.0 26.0 10001001`
  - `I`  → `#TS SHARA        SENO3.2kVA 26.000.000` (manufacturer layout **differs** from the previous unit)
  - `F`  → `#115.0 100 24.00 60.0`
- **Result:**
  - `input.voltage = 1.0 V` → unit **without mains power** (explains the `OB`).
  - `battery.voltage = 24.0 V` **stable** (no drop) → healthy battery.
  - `status = 10001001` → `OB` + `STANDBY` + `BEEP` (no `TEST`).
- **Conclusion:** confirms P1 (the `OB` is correct when there is no mains) and reassesses P2 (the earlier drop was induced by the
  battery test). The identity parser was adjusted to the fixed-width layout.

## T10 — Automated test suite of the API (v2.0) — 2026-10-21 12:19

- **Goal:** validate protocol, collector and HTTP layer **without hardware**, via dependency injection
  (fake serial link and controlled clock).
- **Command:** `python3 -m unittest discover -s tests -t . -v`.
- **Result:** **46 tests, all OK** (`test_protocol.py`, `test_collector.py`, `test_http_api.py`).
  The HTTP layer is exercised with real requests on `127.0.0.1` (ephemeral port), covering
  `200/404/405/503`, `/health` `ok`/`degraded`/`down` and the requirement "HTTP request does not trigger a serial reading".

## T11 — REST API against the real device — 2026-10-21 12:21

- **Goal:** validate the JSON contract end to end with the UPS connected (`/dev/ttyACM0`).
- **Commands:**
  - `python3 scripts/run_api.py --check` → valid telemetry, `exit 0`;
  - `python3 scripts/run_api.py --http-host 127.0.0.1 --http-port 8081` + `GET` on the five endpoints.
- **`Q1` sample:** `(222.0 222.0 112.0 011 60.0 27.4 26.0 00001001` → `STANDBY` + `BEEP` (no `OB`),
  `load = 11 %`, battery `27.4 V` → estimated charge `100 %` (saturated at the calibration `20.1–26.8 V`).
- **`I`/`F` sample:** `#TS -222  091225 Senoid  32 V01020805A` / `#Univ. 100 24.00 60.0`
  (`nominal.voltage_v = null`, because the label is `Univ.`).
- **Results:** `/health` → 200 `status=ok`; `/api/v1/ups` → 200; `/telemetry` → 200 with
  `telemetry_valid=true`; `/identity` → 200; nonexistent `device_id` → 404 `device_not_found`;
  `POST` → 405 `method_not_allowed`.
- **Conclusion:** contract, HTTP codes and the 5 s collection validated on the bench. Log with deduplication and heartbeat
  without noise (`total_attempts = total_successes`).

## T12 — Communication failures (simulated, without switching off the device) — 2026-10-21 12:22

- **Goal:** prove the failure handling **without generating fictitious values**.
- **"Port in use" scenario:** API running (exclusive lock) + `run_api.py --check` in parallel →
  `state = port_unavailable`, message `Could not exclusively lock port /dev/ttyACM0`, `data = null`.
- **"Nonexistent port" scenario:** `run_api.py --check --port /dev/ttyACM9` →
  `state = port_unavailable`, `serial_port = /dev/ttyACM9`, `data = null`.
- **"Corrupted response" scenario:** the first reading after opening the port returned binary bytes
  (third-party interference on the port, e.g. `ModemManager`/a previous process) →
  `state = invalid_response`, `consecutive_failures = 1`, `data = null`; subsequent cycles recovered
  automatically (without restarting the service).
- **Conclusion:** all failures are classified, recorded in `communication.last_error` and **do not**
  produce measurements. The last valid reading is preserved and becomes `stale` after `stale_after_s = 20 s`.

## T13 — systemd service and control without USB (validation) — 2026-10-21 15:19

- **Goal:** keep the API always up as a service and prove the behavior when the USB cable is not
  connected (the symptom observed was `ECONNREFUSED` on `127.0.0.1:8081` because there was no service).
- **Artifacts:**
  - [`config/examples/ts-shara-api.service`](../config/examples/ts-shara-api.service) — `Restart=always`,
    `RestartSec=5`, `StartLimitIntervalSec=0` (indefinite restart; a cable missing at boot does not exhaust attempts);
  - [`config/examples/99-ts-shara-ups.rules`](../config/examples/99-ts-shara-ups.rules) — `dialout` permission,
    `ModemManager` ignoring the device and **API restart when the cable is reconnected**;
  - [`scripts/install_service.sh`](../scripts/install_service.sh) — installs unit + config + udev rule and runs
    `enable --now` (requires `sudo`).
- **Validations without `sudo`:**
  - `systemd-analyze verify` on the unit generated by the installer → **OK**. Correction applied: the unit used
    `WorkingDirectory` **with quotes** and a raw `%20` in `Documentation`, which systemd rejected
    (`WorkingDirectory= path is not absolute` / `Invalid URL`); it now has no quotes and uses `%%20`.
  - `udevadm verify config/examples/99-ts-shara-ups.rules` → **1 file, 0 failures**.
  - `python3 -m unittest discover -s tests -t .` → **46 tests OK**.
- **Live validation — USB absent** (API on `127.0.0.1:18080` with `--port /dev/ttyACM9`, without touching the
  hardware):
  - `/health` → **503** `status=degraded`, `checks.serial_communication=port_unavailable`,
    `checks.telemetry_freshness=no_data`;
  - `/api/v1/ups` → **200** with `communication_state=port_unavailable` (the consumer sees the device and the reason);
  - `/telemetry` → **503**, `data=null`, `data_available=false`, `communication.last_error.code=port_unavailable`;
  - `/identity` → **503**. The service **stayed up** throughout the test.
- **Live validation — device connected:** `python3 scripts/run_api.py --check` → `exit 0`,
  `state=ok`, autodetected port `/dev/ttyACM0`, `Q1` with input **221.0 V**, output **111.0 V**,
  load **11 %**, battery **27.4 V**.
- **Conclusion:** the service does not stop without the cable and the API distinguishes "API down" (`ECONNREFUSED`) from
  "UPS without communication" (`503 degraded` with `state`/`last_error`). It remains to run
  `sudo scripts/install_service.sh` on the host and measure stability over 24 h (P6).

## Evidence to archive

- Outputs of `lsusb`, `lsusb -t` and reading of `/sys/bus/usb/devices/1-1/*`.
- Full log of the NUT driver (`nutdrv_qx -DDD`).
- Serial samples (text) and collector JSON.
- TS App capture (to be attached) for the T6 comparison.

> Sensitive data was omitted; USB captures may contain serial numbers and should be reviewed before
> versioning.
