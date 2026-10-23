# TS Shara UPS monitoring over USB — Documentation

**Project:** Monitoring of a TS Shara Senoidal 3200 UNIV. UPS over USB and Zabbix
**Device:** TS Shara UPS Senoidal 3200 UNIV. 2BS USB (label: 3200 VA, code `4450`)
**Technical owner:** Infrastructure Team — Runtec
**Platform:** Ubuntu 24.04.5 LTS (reference host)
**Evidence date:** 2026-10-20
**Status:** Discovery complete; collection validated; **not approved for production**

---

## Executive summary

The goal of the first stage was to answer three questions:

1. Is it possible to collect the UPS information through Ubuntu? **Yes.**
2. Do the obtained data cover what the TS App (Windows) shows? **Yes, fully** (input voltage, output voltage, frequency, temperature and load), with the battery percentage **derived**.
3. Is it necessary to develop a custom protocol? **No.** The device speaks **Megatec/Q1** and is natively supported by NUT.

### Main discovery

The UPS **is not a USB HID device** (so `usbhid-ups` is discarded). It presents itself as
**`0483:5740 STMicroelectronics STM32 Virtual ComPort`** — a **CDC-ACM serial port** (`/dev/ttyACM0`).
The **Megatec/Q1 protocol** travels over this port, responding to the commands `Q1`, `I` and `F`.

The **`nutdrv_qx` driver of NUT 2.8.1** automatically detected the protocol as **Megatec 0.07**, initialized the
device and started reading the data continuously. The model **"Universal UPS Senoidal 3200VA"** is also listed in the
[official NUT Device Data Library (DDL)](https://networkupstools.org/ddl/TS_Shara/Universal_UPS_Senoidal_3200VA.html).

### Point of attention

In this bench's measurements, the reported status was **`OB` (On Battery)** constantly, **despite the measured input
voltage of ~228 V**, and the **battery voltage showed a continuous drop** (≈22.6 V → 19.8 V throughout the session).
This needs to be confirmed against the physical state of the device and compared with the TS App — see
[decisions-and-open-items.md](docs/decisions-and-open-items.md).

---

## Documentation index

| Document | Content |
|---|---|
| [Spec.md](Spec.md) | **Consolidated specification** of the USB data (field-by-field decoding) |
| [docs/rest-api.md](docs/rest-api.md) | **REST API (v2.0)**: installation, execution, configuration, endpoints, JSON contract and failures |
| [docs/hardware-inventory.md](docs/hardware-inventory.md) | OS, kernel and USB evidence (Stage 1) |
| [docs/megatec-ts-shara-protocol.md](docs/megatec-ts-shara-protocol.md) | Protocol reverse engineering: commands, frames and fields |
| [docs/nut-installation-and-configuration.md](docs/nut-installation-and-configuration.md) | NUT installation, `ups.conf`, tests and `ModemManager` |
| [docs/variables-and-tsapp-comparison.md](docs/variables-and-tsapp-comparison.md) | NUT variables and comparison with the TS App |
| [docs/tests-and-evidence.md](docs/tests-and-evidence.md) | Record of each experiment with date/time |
| [docs/decisions-and-open-items.md](docs/decisions-and-open-items.md) | Technical decisions and open items |
| [docs/zabbix-integration.md](docs/zabbix-integration.md) | Zabbix integration plan (Stage 4) |

## REST API (v2.0)

Local collector + **read-only** HTTP API that publishes the last valid telemetry as versioned JSON
(`/health`, `/api/v1/ups`, `/api/v1/ups/{device_id}/telemetry`, `/api/v1/ups/{device_id}/identity`).

> **Mode supported today:** the device is served by the **unified API `upsmon`**, on `127.0.0.1:8080`
> (`device_id = tsshara-3200va-01`), together with the SMS UPS — see
> [monitor/README.md](../../monitor/README.md) and
> [monitor/docs/unified-api.md](../../monitor/docs/unified-api.md). This standalone API (port **8081**)
> remains as a reference and *rollback*; the serial port has an exclusive lock, so the two **do not** run
> at the same time.

```bash
python3 scripts/run_api.py --check                # one collection: prints the contract JSON and exits
python3 scripts/run_api.py                        # starts the API (default 127.0.0.1:8081)
sudo scripts/install_service.sh                   # installs as a systemd service (always up) + udev rule
python3 -m unittest discover -s tests -t . -v     # 46 tests (no hardware)
```

- Mode supported in production: **systemd service `ts-shara-api`** (`Restart=always`), installed by
  `sudo scripts/install_service.sh`; the udev rule restarts the service when the USB cable is reconnected.
- Without the USB cable the service **stays up**: `/health` answers `503 degraded` and `/telemetry` `503` with
  `communication.state` (`port_unavailable`/`disconnected`) — no fictitious value. Details in section 3.4 of
  [docs/rest-api.md](docs/rest-api.md).
- Only the collector component accesses the serial port; **no HTTP request triggers a new reading**.
- No database: the last valid reading stays in memory (restarting clears the history).
- No control command (`T`/`TL`/`S`) is implemented — the API is 100% read-only (D9).
- Details, JSON contract and test procedure: [docs/rest-api.md](docs/rest-api.md).

## Quick reproduction

```bash
python3 ../../scripts/discovery/probe_serial.py
python3 scripts/ts_shara_collector.py --identify
python3 scripts/ts_shara_collector.py --json   # includes battery_charge_percent (calibrated — see Spec.md 7.3)
python3 scripts/run_api.py --check             # telemetry in the REST API contract
```
