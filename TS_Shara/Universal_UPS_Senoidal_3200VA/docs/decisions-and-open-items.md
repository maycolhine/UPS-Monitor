# Technical decisions and open items

## 1. Decisions made

| # | Decision | Rationale |
|---|---|---|
| D1 | **Use NUT (`nutdrv_qx`) as the collection method**, instead of a custom driver/protocol | The device speaks **Megatec/Q1**; the driver autodetected the protocol and operated without errors. The model is listed in the official NUT DDL. |
| D2 | Treat the transport as **serial CDC-ACM** (`/dev/ttyACM0`), **not USB-HID** | Evidence: `0483:5740` STM32 Virtual ComPort, CDC class (`02`). `usbhid-ups` is inapplicable. |
| D3 | Adopt an explicit `protocol = megatec` in `ups.conf` | Stabilizes behavior and avoids re-detection on every start. |
| D4 | Reference baud **2400** (Megatec), aware that the CDC port ignores the value | Intact responses at all bauds tested. |
| D5 | Treat `battery.charge` as an **estimate** | The protocol does not transmit the percentage; NUT computes it from the voltage. |
| D6 | **Block `ModemManager`** for the device (udev rule) | Prevents injection of `AT` commands that corrupt the port. |
| D7 | **Do not** implement shutdown automation in this phase | Per the project document: it requires its own design, tests and approval. |
| D8 | **Organize the repository by brand/model** (`<Brand>/<Model>/`), with generic tools at the root | Allows accumulating knowledge per model for future tests. |
| D9 | Probe only with **read** commands (`Q1`, `I`, `F`) | The `T`/`TL`/`S` commands (battery test) discharged the battery and shut down the load on the previous unit. |

### v2.0 decisions (local REST API)

| # | Decision | Rationale |
|---|---|---|
| D10 | **Expose the telemetry over an HTTP/REST API on the serial host itself**, instead of the consumer talking directly to the port | The host with physical access to the USB is not necessarily the same as the consumer (Zabbix/dashboard). The API isolates protocol, port and calibration in a single point. |
| D11 | Implement the API with the **Python standard library** (`http.server`), keeping `pyserial` as the **only** external dependency | The production environment has no `pip`/Flask/FastAPI/uvicorn; reduces the installation and update surface. |
| D12 | **Read-only in the API too** (no command endpoint; `POST`/`PUT`/`PATCH`/`DELETE` → 405) | Reinforces D9: eliminates any possibility of the consumer triggering a battery test or shutdown by mistake. |
| D13 | Identify the device by a logical **`device_id`** (`tsshara-3200va-01`), not by the port name | The port (`/dev/ttyACM0`) can change between reboots; URLs and consumer items remain stable. |
| D14 | Keep only the **last valid reading in memory**, with no database | The goal is real-time monitoring; history is the consumer's responsibility (Zabbix). Restarting the service clears the reading. |
| D15 | **No HTTP request triggers a serial reading** (the handlers read only the in-memory snapshot) | Avoids coupling HTTP latency to the hardware, prevents contention on the port and ensures the consumer does not interfere with collection. |
| D16 | Publish `stale`/`telemetry_valid` and answer **HTTP 503** when the last reading is older than `stale_after_s` (20 s = 4× the interval) | Separates "application up" from "usable data"; prevents the consumer from treating an old reading as current. |
| D17 | Expose the battery percentage **labeled as an estimate** (`estimated: true`, `method` and the calibration used) | Reinforces D5: the protocol does not transmit charge; the consumer needs to know the value is derived. |
| D18 | **Deduplicate logs** (the same failure repeated only after 300 s) and log a **heartbeat** every 12 valid collections | A UPS disconnected for hours must not flood the journal; the heartbeat proves collection is still alive. |
| D19 | A failure reading the identification (`I`/`F`) does **not** invalidate the telemetry | Identification is static (revalidated every 1 h); its absence does not affect the measurements of the Q1 frame. |
| D20 | Run the API as a **systemd service** (`ts-shara-api`, `Restart=always`, `StartLimitIntervalSec=0`) and use a **udev rule** to restart the service when the USB cable is reconnected | The API must stay up at all times (the consumer must not depend on a manual restart); without the USB the service does **not** stop and the API answers `503` with the reason, allowing "API down" to be distinguished from "UPS without communication". |

## 2. Open items

### P1 — `OB` status: mains absent? — **reassessed in the retest (T9)**

- **Unit 1 (with servers):** constant `ups.status = OB CAL`, with `input.voltage ≈ 228 V`.
- **Unit 2 (same model, no load, 2026-10-20 15:41):** `input.voltage = 1.0 V` and `ups.status = 10001001`
  → `OB` + `STANDBY` + `BEEP` (no `TEST`).
- **Interpretation:** unit 2 is **not powered by the mains** (input ≈ 1 V), so `OB` is **correct**.
  The `OB` on unit 1 probably had the same cause (absent/unstable mains), and **not** a firmware defect.
- **Pending action:** confirm the presence of mains on unit 1 and compare with the TS App (P3).

### P2 — Battery voltage — **reassessed; the earlier drop was induced**

- **Unit 1 (under load):** `battery.voltage` dropped from ~22.6 V to **15.2 V** in ~16 min, with `ups.status = OB`.
  Probable cause: a **battery test** triggered by mistake (commands `T`/`TL`) **combined with the load** of the servers.
- **Unit 2 (no load, 2026-10-20 15:41):** `battery.voltage = 24.0 V` **stable** (2 × 12 V batteries in series),
  output current ≈ 8 % (only the Asus notebook charger, 19 V / 2.37 A). **No drop.**
- **Conclusion:** unit 2's battery is healthy; the earlier drop was induced by the test. **Never** send
  `T`/`TL`/`S` without explicit planning (D9).

### P3 — Effective comparison with the TS App

- A simultaneous TS App reading is still missing to fill the table in
  [variables-and-tsapp-comparison.md](variables-and-tsapp-comparison.md).

### P4 — Runtime (`battery.runtime`)

- Not calculated. Define `runtimecal` to enable it, if the runtime is considered reliable.

### P5 — Production preparation

- Ensure the `dialout` group/permissions and configure `/etc/nut`.
- udev rule `99-ts-shara-ups.rules`: **ready file** in `config/examples/`, installed by
  `scripts/install_service.sh` (only the installation with `sudo` on the host remains).
- Define the final naming of the Zabbix items.

### P6 — REST API: acceptance (v2.0)

- Tested on the bench (2026-10-21, unit `tsshara-3200va-01`): collection, JSON contract, failure codes and
  46 automated tests.
- **Prepared in this round (T13):** systemd unit with `Restart=always`, udev rule (permission + ModemManager
  + restart on reconnection) and `scripts/install_service.sh`; behavior without USB validated live
  (`503 degraded`, `data = null`, `last_error` filled).
- **Pending:** run `sudo scripts/install_service.sh` on the host; validate the automatic restart
  (`kill`/cable reconnection) and measure stability over 24 h.
- There is no authentication in the API: publish only on the management network (or define a proxy/ACL).
- Decide whether the `device_id` `tsshara-3200va-01` remains for this unit.

### P7 — Zabbix data source

- Define whether Zabbix will consume the **REST API** (Option C of [zabbix-integration.md](zabbix-integration.md)) or the
  collector/NUT (Options A/B). The API already delivers the same fields in stable JSON.

## 3. Items explicitly out of scope (in this phase)

- Ordered shutdown of loads / contingency automation.
- SNMP implementation.
- Energy collection (kWh) — not available in the protocol.
- Own web application/dashboard, database and Docker consumer.
- Definitive Zabbix integration (the API is the source; the final configuration is a later stage — P7).

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `ModemManager` interfering with the port | Loss/corruption of readings | udev rule `ID_MM_DEVICE_IGNORE` |
| Discharged/failed battery | Unexpected shutdown of the load | Open item P2 |
| Incorrect interpretation of the status | False alarms in Zabbix | Open item P1 before creating triggers |
| Device reboot changes `/dev/ttyACM0` | Collection failure | Autodetection by VID:PID in the API (D13); udev rule for a stable name in NUT |
| Two processes opening the serial port | Corrupted reading | Exclusive lock in the API (`serial_exclusive`), with a logged `port_unavailable` failure |
| Consumer treating an old reading as current | Incorrect metric/alarm | `stale`/`telemetry_valid` in the contract and HTTP 503 (D16) |
| API exposed without authentication | Unauthorized access to telemetry | Publish only on the management network (P6) |
