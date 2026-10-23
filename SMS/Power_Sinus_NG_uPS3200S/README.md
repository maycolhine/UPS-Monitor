# Monitoring the SMS Power Sinus NG uPS3200S UPS over USB — Documentation

**Project:** UPS monitoring over USB and Zabbix — model **SMS Power Sinus NG uPS3200S**
**Equipment:** SMS Power Sinus NG uPS3200S (nameplate: **3200 VA**, input **220 V~**, output **220 V~**, **60 Hz**)
**Technical owner:** Infrastructure Team — Runtec
**Platform:** Ubuntu 24.04.5 LTS (the reference host)
**Evidence date:** 2026-10-22
**Status:** Discovery complete; collection validated; **data published in the REST API**; **not approved for production**

---

## Executive summary

The goal of this stage was to answer three questions:

1. Is it possible to collect the UPS information from Ubuntu? **Yes.**
2. Is it necessary to develop a proprietary protocol? **No** — the equipment already implements an
   off-the-shelf protocol, **SMS Brazil 1Phase**, which NUT supports (`sms_ser`).
3. Does the data cover what the manufacturer presents? **Yes** — input/output voltage, output frequency,
   load, **battery percentage** (reported by the equipment) and temperature.

### Main discovery

The UPS **is not a USB HID device** (so `usbhid-ups` is discarded). It presents itself as a
**Prolific USB-Serial converter `067b:23d3`** (kernel driver `pl2303`), resulting in the port
**`/dev/ttyUSB0`**. Over that port travels a **binary** protocol — the **SMS Brazil 1Phase** — answering
to the commands `Q`, `I` and `F`.

> **Difference from the TS Shara:** there the transport is **CDC-ACM** (`/dev/ttyACM0`) and the protocol is
> **Megatec/Q1 in ASCII text**; here it is **USB-Serial** (`/dev/ttyUSB0`) and **binary**. And the battery sense is
> inverted: **in this model the percentage comes from the equipment and the voltage is derived**.

### Point of attention

There is no **manufacturer application** for this model on this bench (unlike the TS Shara's TS App). The
cross-validation was done against the **protocol specification** (`monofasico.xml`, which ships with
SMS's PowerView) and against the **NUT `sms_ser` driver**. In addition, the **battery voltage is derived** (not
measured) — see [decisions-and-open-items.md](docs/decisions-and-open-items.md) (P2).

---

## Documentation index

| Document | Content |
|---|---|
| [Spec.md](Spec.md) | **Consolidated specification** of the USB data (field-by-field decoding) |
| [docs/rest-api.md](docs/rest-api.md) | **REST API (v2.0)**: installation, running, configuration, endpoints, JSON contract and failures |
| [hardware-inventory.md](docs/hardware-inventory.md) | OS, kernel and USB evidence (Stage 1) |
| [sms-1phase-protocol.md](docs/sms-1phase-protocol.md) | Protocol reverse engineering: commands, frames, fields and bits |
| [nut-installation-and-configuration.md](docs/nut-installation-and-configuration.md) | NUT `sms_ser` driver: installation, `ups.conf`, tests and `ModemManager` |
| [variables-and-mapping.md](docs/variables-and-mapping.md) | Mapping protocol → API → NUT → Zabbix |
| [tests-and-evidence.md](docs/tests-and-evidence.md) | Record of each experiment with date/time |
| [decisions-and-open-items.md](docs/decisions-and-open-items.md) | Technical decisions and open items |
| [zabbix-integration.md](docs/zabbix-integration.md) | Zabbix integration plan (Stage 4) |

## REST API (v2.0)

Local collector + **read-only** HTTP API that publishes the last valid telemetry in versioned JSON
(`/health`, `/api/v1/ups`, `/api/v1/ups/{device_id}/telemetry`, `/api/v1/ups/{device_id}/identity`).

> **Mode supported today:** the device is served by the **unified `upsmon` API**, on `127.0.0.1:8080`
> (`device_id = sms-ups3200s-01`), together with the TS Shara UPS — see
> [monitor/README.md](../../monitor/README.md) and
> [monitor/docs/unified-api.md](../../monitor/docs/unified-api.md). This standalone API (port **8082**)
> remains as a reference and *rollback*; the serial port has an exclusive lock, so the two **do not** run
> at the same time.

```bash
python3 scripts/run_api.py --check                # one collection: prints the contract JSON and exits
python3 scripts/run_api.py                        # starts the API (default 127.0.0.1:8082)
sudo scripts/install_service.sh                   # installs as a systemd service (always up) + udev rule
python3 -m unittest discover -s tests -t . -v     # 48 tests (without hardware)
```

- Mode supported in production: **systemd service `sms-api`** (`Restart=always`), installed by
  `sudo scripts/install_service.sh`; the udev rule restarts the service when the USB cable is reconnected.
- Without the USB cable the service **stays up**: `/health` answers `503 degraded` and `/telemetry` `503` with
  `communication.state` (`port_unavailable`/`disconnected`) — no fictitious value. Details in section 3.4 of
  [docs/rest-api.md](docs/rest-api.md).
- Only the collector component accesses the serial port; **no HTTP request triggers a new reading**.
- No database: the last valid reading stays in memory (restarting clears the history).
- No action command (`M`/`L`/`T`/`S`/`R`/`D`/`C`) is implemented — the API is 100% read-only (D9).
- Details, JSON contract and test procedure: [docs/rest-api.md](docs/rest-api.md).

## Quick reproduction

```bash
python3 ../../scripts/discovery/probe_serial.py
python3 scripts/sms_collector.py --identify
python3 scripts/sms_collector.py --json        # includes battery_charge_percent and battery_voltage_v (derived)
python3 scripts/run_api.py --check             # telemetry in the REST API contract
```
