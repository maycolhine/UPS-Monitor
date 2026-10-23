# Technical decisions and open items

## 1. Decisions made

| # | Decision | Rationale |
|---|---|---|
| D1 | **Collect with our own implementation** (`pyserial` + parser in `api/protocol.py`) and publish through a **local REST API**, instead of depending on NUT | The equipment speaks the **binary SMS Brazil 1Phase** protocol; the NUT `sms_ser` driver implements the same protocol, but it was **not** validated end to end on this bench. The in-house implementation uses the same parsing rule and already delivers a consumable JSON contract. |
| D2 | Treat the transport as **serial over USB-Serial** (`/dev/ttyUSB0`), **not** USB-HID nor CDC-ACM | Evidence: **Prolific PL2303** converter `067b:23d3` (`pl2303` driver), with one Vendor-Specific interface. `usbhid-ups` is inapplicable. |
| D3 | Adopt `protocol = sms-1phase` as the protocol identifier | The equipment implements the **single-phase** variant of SMS Brazil (the same as `monofasico.xml`/`sms_ser`). |
| D4 | Baud **2400 8N1**, fixed in the protocol | It is the speed defined by the manufacturer; the NUT `sms_ser` driver also fixes it internally. |
| D5 | **Battery: the percentage COMES from the equipment**; the voltage is **derived** (`nominal × % / 100`) | Unlike Megatec/TS Shara: here the `Q` frame transmits the percentage (`PorcentagemTensaoBateria`), and it is the **voltage** that is not transmitted (rule identical to the `sms_ser` driver). |
| D6 | **Block `ModemManager`** for the device (udev rule) | Prevents injection of `AT` commands that corrupt the `/dev/ttyUSB0` port. |
| D7 | **Do not** implement shutdown automation in this phase | As per the project document: it requires its own design, testing and approval. |
| D8 | **Organize the repository by brand/model** (`<Brand>/<Model>/`), with generic tools at the root | Allows accumulating a knowledge base per model for the next tests. |
| D9 | Probe and collect **using only read commands** (`Q`, `I`, `F`) | The action commands (`M`, `L`, `T`, `S`, `R`, `D`, `C`) trigger a battery test or shut down the output — risk of draining the battery/shutting down the load (see [sms-1phase-protocol.md](sms-1phase-protocol.md) §2.1). |

### v2.0 decisions (local REST API)

| # | Decision | Rationale |
|---|---|---|
| D10 | **Expose the telemetry through an HTTP/REST API on the serial host itself**, instead of having the consumer talk directly to the port | The host with physical access to the USB is not necessarily the consumer's (Zabbix/dashboard). The API isolates protocol, port and battery derivation in a single point. |
| D11 | Implement the API with the **Python standard library** (`http.server`), keeping `pyserial` as the **only** external dependency | The production environment has no `pip`/Flask/FastAPI/uvicorn; it reduces the installation and update surface. |
| D12 | **Read-only also in the API** (no command endpoint; `POST`/`PUT`/`PATCH`/`DELETE` → 405) | Reinforces D9: eliminates any chance of the consumer triggering a battery test or shutdown by mistake. |
| D13 | Identify the equipment by a logical **`device_id`** (`sms-ups3200s-01`), not by the port name | The port (`/dev/ttyUSB0`) may change between reboots; the URLs and the consumer's items remain stable. |
| D14 | Keep only the **last valid reading in memory**, without a database | The goal is real-time monitoring; history is the consumer's responsibility (Zabbix). Restarting the service clears the reading. |
| D15 | **No HTTP request triggers a serial reading** (the handlers read only the in-memory snapshot) | Avoids coupling the HTTP latency to the hardware, prevents contention on the port and guarantees that the consumer does not interfere with the collection. |
| D16 | Publish `stale`/`telemetry_valid` and answer **HTTP 503** when the last reading is older than `stale_after_s` (20 s = 4× the interval) | Separates "application up" from "usable data"; prevents the consumer from treating an old reading as current. |
| D17 | Expose the **battery percentage as reported by the equipment** (`charge_source = "reported_by_device"`) and **label the voltage as derived** (`voltage_derived = true`) | Makes explicit what is measured by the UPS and what is computed by us — the inverse of the TS Shara case. |
| D18 | **Deduplicate logs** (the same repeated failure only after 300 s) and log a **heartbeat** every 12 valid collections | A UPS disconnected for hours must not flood the journal; the heartbeat proves that the collection is still alive. |
| D19 | A failure in reading the identification (`I`/`F`) **does not** invalidate the telemetry | The identification is static (revalidated every 1 h); its absence does not affect the measurements of the `Q` frame. |
| D20 | Run the API as a **systemd service** (`sms-api`, `Restart=always`, `StartLimitIntervalSec=0`) and use a **udev rule** to restart the service when the USB cable is reconnected | The API must always stay up (the consumer must not depend on a manual start); without the USB the service does **not** stop and the API answers `503` with the reason, allowing "API down" to be separated from "UPS without communication". |
| D21 | **Auto-detect the port by climbing the sysfs tree** from `/sys/class/tty/ttyUSB*`/`ttyACM*` up to finding `idVendor`/`idProduct` | The **USB-Serial** layout has one extra level (`1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0`) and only the parent device declares the IDs; the old routine (glob in the CDC-ACM layout) did not find the port. Fix recorded in [tests-and-evidence.md](tests-and-evidence.md) T8. |

## 2. Open items

### P1 — NUT `sms_ser` driver not validated live

- The driver exists on this host (`/lib/nut/sms_ser`, `SMS Brazil UPS driver 1.00 (2.8.1)`) and the
  `ups.conf` block is ready in [`../config/examples/ups.conf`](../config/examples/ups.conf).
- **Pending:** run the manual test (`NUT_STATEPATH=/tmp /lib/nut/sms_ser -s sms01 -x port=/dev/ttyUSB0 -d 1`)
  **with the API stopped** (exclusive lock on the port) and compare the variables with the API contract.
- Reference: [nut-installation-and-configuration.md](nut-installation-and-configuration.md).

### P2 — Battery voltage is derived (not measured)

- The protocol **does not transmit** the battery voltage; it is computed as `nominal × percentage / 100`
  (rule of `sms_ser`). With `nominal = 24 V` and `100 %`, it always results in `24.0 V`.
- **Impact:** the voltage follows the percentage, not the real pack voltage — it does **not** serve to detect
  a battery degraded by undervoltage. The reliable indicator is the **percentage** and the `LB` bit.
- **Pending action:** assess `battery.voltage` only as a derived field (already labeled in the API) and base
  alarms on the percentage + `LB` bit.

### P3 — No manufacturer app for cross-comparison

- There is no (on this bench) manufacturer application for this model, unlike TS Shara's TS App.
- The cross-validation was done against the **protocol specification** (`monofasico.xml`, which ships with
  SMS's PowerView) and against the **NUT `sms_ser` driver**.
- **Pending action:** if there is access to SMS's **PowerView**, compare a simultaneous reading to confirm
  units and rounding (procedure in
  [variables-and-mapping.md](variables-and-mapping.md) §4).

### P4 — Runtime (`battery.runtime`)

- **Not provided** by the SMS 1Phase protocol. Without `runtimecal`/discharge model, there is no way to estimate it.
- **Pending action:** define whether the runtime will be estimated (requires a discharge curve) or kept out of scope.

### P5 — Interpretation of the status bits

- In the bench capture the status byte was `0x29` = `00101001` → **`BEEP` + `UPSOK` + `BYPASS`**, with
  input ≈ 218 V (mains present) and load 20 %.
- **Pending:** confirm the meaning of `BYPASS`/`UPSOK` in this model (bit by bit) against `monofasico.xml`
  and observe the byte at different moments (mains outage, test, low battery) to validate the 8 bits before
  creating triggers in Zabbix.

### P6 — Production preparation

- Ensure the `dialout` group/permissions and configure the API.
- udev rule `99-sms-ups.rules`: **file ready** in `config/examples/`, installed by
  `scripts/install_service.sh` (only the installation with `sudo` on the host is missing).
- Define the final naming of the items in Zabbix.

### P7 — REST API: acceptance (v2.0)

- Validated on the bench (2026-10-22, unit `sms-ups3200s-01`): collection, JSON contract, failure codes,
  port auto-detection by VID:PID and **48 automated tests**. Data published on `127.0.0.1:8082`.
- **Pending:** run `sudo scripts/install_service.sh` on the host; validate the automatic restart
  (`kill`/cable reconnection) and measure the stability over 24 h.
- There is no authentication in the API: publish only on the management network (or define a proxy/ACL).
- Decide whether the `device_id` `sms-ups3200s-01` remains for this unit.

### P8 — Zabbix data source

- Define whether Zabbix will consume the **REST API** (Option C of [zabbix-integration.md](zabbix-integration.md)) or the
  collector/NUT (Options A/B). The API already delivers the same fields in stable JSON.

### P9 — `sms-1phase` driver: `T` WITHOUT a duration parameter (incident T10) — **RESOLVED 2026-10-22**

- **Problem (two fronts):**
  1. The driver's command building fixed the four parameters at `0xFF`. In the **test** command `T` this
     makes the firmware read "**no duration defined**" and run the test **until the battery drains** — the same
     effect as the `L` command. The **correct** `T` requires `Param1` = duration in seconds (e.g.: `54 0A FF FF FF A5 0D`).
  2. The collector **closed the sampling window** (~10 s) but **did not send `D`** on this normal closure (the
     `D` was only sent on the `aborted` path), so the UPS **remained in test** even with the API reporting the
     report as `completed`.
- **Evidence:** incident of 2026-10-22 — battery from **100 % to 18 %** and bits `TEST`+`OB`+`BOOST`+`BEEP`
  active for an indefinite time ([tests-and-evidence.md](tests-and-evidence.md) T10).
- **Fix applied:**
  1. `drivers/sms_1phase.py`: new `action_bytes(command, duration_s)` builds the `T` **with** `Param1` = duration
     (cap `0xFE` — `0xFF` is reserved) and uses the general checksum formula `(-sum(bytes[0..4])) & 0xFF`;
     `command_bytes` (reads) keeps the four `0xFF`.
  2. `collector.py`: the driver's cancel command (`CMD_TEST_ABORT`) is sent on **every** closure
     in which the UPS may remain in test (`FINISH_REASONS_NEEDING_ABORT`: `duration_elapsed`, `watchdog`,
     `aborted`, `stopping`); the window duration is passed on to `send_action`.
- **Validation:** a 10 s test triggered by the API and ended on its own — `status = completed`,
  `finish_reason = duration_elapsed`, `duration_s = 10.4` and `TEST`/`OB` cleared in the following readings
  ([tests-and-evidence.md](tests-and-evidence.md) T11). Automated suite: **90 tests OK**.
- Protocol reference: [sms-1phase-protocol.md](sms-1phase-protocol.md) §2.2.
- **Manual cancellation (if needed):** `scripts/cancel_battery_test.py`.

## 3. Items explicitly out of scope (in this phase)

- Ordered shutdown of loads / contingency automation.
- SNMP implementation.
- Energy collection (kWh) — not available in the protocol.
- Own web application/dashboard, database and consumer in Docker.
- Definitive Zabbix integration (the API is the source; the final configuration is a later stage — P8).

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `ModemManager` interfering with the port (`AT`) | Loss/corruption of reading | udev rule `ID_MM_DEVICE_IGNORE` |
| Action commands sent by mistake (`T`/`L`/`S`) | Drains the battery / shuts down the load | Read-only in all layers (D9/D12) |
| `T` sent **without** the duration parameter (`Param1 = 0xFF`) | Test runs **until the battery drains** and does not stop on its own (incident T10) | `T` with `Param1` = duration + `D` at the end of the window — **applied** (P9) |
| Battery at `LB` | Unexpected shutdown of the load | Trigger base on the `LB` bit + percentage (P5) |
| Incorrect interpretation of the status bits | False alarms in Zabbix | Open item P5 before creating triggers |
| Character train at another speed on the port | Corrupted reading | Fixed baud 2400 8N1 (D4) + frame checksum |
| Device reboot changes `/dev/ttyUSB0` | Collection failure | Auto-detection by VID:PID (D21); udev rule for a stable name in NUT |
| Two processes opening the serial port | Corrupted reading | Exclusive lock in the API (`serial_exclusive`), with a recorded `port_unavailable` failure |
| Consumer treating an old reading as current | Incorrect metric/alarm | `stale`/`telemetry_valid` in the contract and HTTP 503 (D16) |
| Battery voltage derived read as measured | Incorrect battery diagnosis | Field labeled `voltage_derived = true` (D17/P2) |
| API exposed without authentication | Improper access to the telemetry | Publish only on the management network (P7) |
