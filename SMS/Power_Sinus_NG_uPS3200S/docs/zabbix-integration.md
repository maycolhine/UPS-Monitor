# Zabbix integration (Stage 4)

This stage begins **after** reliable local readings — which already takes place via the REST API/collector. What is
missing for production are the open items in [decisions-and-open-items.md](decisions-and-open-items.md) (P5/P7).

## 1. Recommended architecture

```text
SMS Power Sinus NG uPS3200S (USB-Serial Prolific 067b:23d3)
        |  serial /dev/ttyUSB0  (2400 8N1, SMS 1Phase protocol)
        v
Ubuntu 24.04 — collector + local REST API (127.0.0.1:8082)  [Option C, v2.0]
Ubuntu 24.04 — sms_ser (NUT, SMS Brazil protocol) + upsd      [Option A / B]
        |  HTTP/JSON  or  NUT protocol (TCP 3493)
        v
Zabbix — collection, history, triggers and alerts
```

Three ways for Zabbix to obtain the data:

### Option A — Zabbix Agent 2 on the Ubuntu host (recommended)

The agent runs on the same Ubuntu that talks to the UPS and reads the data **locally**, avoiding exposing NUT on the network.

- Master item: `sms.collect` calling the collector in JSON:
  ```conf
  UserParameter=sms.collect,/opt/UPS\ Monitor/SMS/Power_Sinus_NG_uPS3200S/scripts/sms_collector.py --json
  ```
- Dependent items (JSONPath preprocessing):
  `input_voltage_v`, `output_voltage_v`, `output_frequency_hz`, `load_percent`,
  `battery_charge_percent`, `battery_voltage_v`, `temperature_c`, `status_raw`.

### Option B — Zabbix querying `upsd` over the LAN

Zabbix accesses NUT on port `3493` (NUT protocol) using an external item/script that runs `upsc`
(`upsc sms_ups3200s@localhost`). It requires exposing `upsd` on the network and configuring `LISTEN`/ACLs in
`/etc/nut/upsd.conf`. It depends on the live validation of the `sms_ser` driver (P1).

> There is no native "NUT" template built into Zabbix; the integration is done with items/scripts.

### Option C — local REST API as the source (v2.0)

Zabbix **does not talk to the serial port**: it consumes the REST API on the host itself
([rest-api.md](rest-api.md)), which already delivers the last valid telemetry in stable JSON.

```text
Zabbix Agent 2 (same host)
   -> GET http://127.0.0.1:8082/api/v1/ups/sms-ups3200s-01/telemetry
   -> dependent items via JSONPath
```

- Master item: `sms.api.telemetry`, a few-line wrapper that does the GET with a timeout and, on `503`
  (no usable data), prints `{"telemetry_valid": false, "data": null}` so the item remains supported.
- Dependent items (JSONPath): `$.data.measurements.input_voltage_v`, `$.data.measurements.output_voltage_v`,
  `$.data.measurements.load_percent`, `$.data.measurements.output_frequency_hz`,
  `$.data.measurements.temperature_c`, `$.data.battery.charge_percent`, `$.data.battery.voltage_v`,
  `$.data.status.raw_bits`, `$.telemetry_valid`, `$.communication.state`.
- **Caution:** with the service up, the item **must not** call `sms_collector.py`/`run_api.py --check`,
  because the serial port is exclusively locked (D15). Always consume HTTP.
- Update trigger: `http_host` may remain on the LAN; the item uses `127.0.0.1` (loopback).
- Identification/ratings (rarely change) stay in `/identity`.

## 2. Suggested metrics and triggers

| Item | Source | Suggested trigger |
|---|---|---|
| `input.voltage` | API/NUT | `< 100 V` for > 30 s → **mains outage** |
| `status.raw_bits` (b7 `OB`) | API | bit `OB` = `1` → running on battery |
| `status.raw_bits` (b6 `LB`) | API | bit `LB` = `1` → low battery (critical) |
| `battery.charge` | API/NUT (reported by the equipment) | `< 30 %` → warning |
| `load_percent` | API/NUT | `> 90 %` for > 5 min → overload |
| `battery.voltage` | API/NUT (**derived** — P2) | use only as a reference; alarm by the percentage + `LB` |
| `temperature_c` | API/NUT | `> 45 °C` → warning |
| `battery.runtime` | — | **not available** in the protocol (P4) |
| **Collection availability** | Agent | `nodata()` on the master item → communication failure (distinct from a UPS failure) |
| `telemetry_valid` / `communication.state` | API (Option C) | `telemetry_valid = false` (or HTTP 503) → collection without usable data |
| `/health` (`status`, `checks.*`) | API (Option C) | `status != ok` → degraded; `collector_thread = failed` → process without collection |

> The thresholds above are **suggestions**; they must be validated after resolving the open items P5/P7.

## 3. Minimum security

- If using Option B: restrict `upsd`'s `LISTEN` to the management network and configure ACLs (`/etc/nut/upsd.users`).
- Prefer **Option A** (local collection), which does not expose NUT on the LAN.
- `zabbix-agent` needs access to `/dev/ttyUSB0` (`dialout` group) **only** in Options A/B; in Option C
  it only consumes the API via loopback.
- In Option C, restrict access to port `8082` to the management network (the API has no authentication in this version).

## 4. Steps

1. Resolve P5/P7 (status bits and API acceptance).
2. **Choose the data source (P8):** NUT (Options A/B) or REST API (Option C).
3. Copy `config/examples/ups.conf` to `/etc/nut/ups.conf` and start the services — **or** install the REST API
   (`config/examples/sms-api.service` + `sms_api.conf`) and validate with
   `python3 scripts/run_api.py --check` before starting the service.
4. Validate: `upsc sms_ups3200s@localhost` (Option A/B) or
   `GET http://127.0.0.1:8082/api/v1/ups/sms-ups3200s-01/telemetry` (Option C).
5. Create the master item + dependents in Zabbix (Option A or C) and import the template.
6. Define the final thresholds and test the triggers.
7. Document the final applied configuration in `zabbix-integration.md`.
