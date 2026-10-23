# Zabbix integration (Stage 4)

This stage begins **after** reliable local readings — which already occur via NUT/collector. What remains for
production are the open items in [decisions-and-open-items.md](decisions-and-open-items.md) (P1/P2).

## 1. Recommended architecture

```text
TS Shara UPS (USB CDC-ACM)
        |  serial /dev/ttyACM0
        v
Ubuntu 24.04 — nutdrv_qx (Megatec protocol) + upsd          [Option A / B]
Ubuntu 24.04 — collector + local REST API (127.0.0.1:8081)  [Option C, v2.0]
        |  NUT protocol (TCP 3493) or HTTP/JSON
        v
Zabbix — collection, history, triggers and alerts
```

Three ways for Zabbix to obtain the data:

### Option A — Zabbix Agent 2 on the Ubuntu host (recommended)

The agent runs on the same Ubuntu that talks to the UPS and reads the data **locally**, avoiding exposing NUT on the network.

- Master item: `ts_shara.collect` calling the collector in JSON:
  ```conf
  UserParameter=ts_shara.collect,$(pwd)/TS_Shara/Universal_UPS_Senoidal_3200VA/scripts/ts_shara_collector.py --json
  ```
- Dependent items (JSONPath preprocessing):
  `input_voltage`, `output_voltage`, `input_frequency`, `load_percent`, `battery_voltage`,
  `temperature_c`, `status_raw`.

### Option B — Zabbix querying `upsd` over the LAN

Zabbix accesses NUT on port `3493` (NUT protocol) using an external item/script that runs `upsc`.
It requires exposing `upsd` on the network and configuring `LISTEN`/ACLs in `/etc/nut/upsd.conf`.

> There is no built-in native "NUT" template in Zabbix; the integration is done through items/scripts.

### Option C — Local REST API as the source (v2.0)

Zabbix **does not talk to the serial port**: it consumes the REST API on the same host
([rest-api.md](rest-api.md)), which already delivers the last valid telemetry in stable JSON.

```text
Zabbix Agent 2 (same host)
   -> GET http://127.0.0.1:8081/api/v1/ups/tsshara-3200va-01/telemetry
   -> dependent items by JSONPath
```

- Master item: `ts_shara.api.telemetry`, a wrapper of a few lines that performs the GET with a timeout and, on `503`
  (no usable data), prints `{"telemetry_valid": false, "data": null}` so the item remains supported.
- Dependent items (JSONPath): `$.data.measurements.input_voltage_v`, `$.data.measurements.output_voltage_v`,
  `$.data.measurements.load_percent`, `$.data.measurements.battery_voltage_v`,
  `$.data.measurements.temperature_c`, `$.data.battery_charge.percent`, `$.data.status.raw_bits`,
  `$.telemetry_valid`, `$.communication.state`.
- **Caution:** with the service up, the item **cannot** call `ts_shara_collector.py`/`run_api.py --check`,
  because the serial port is under an exclusive lock (D15). Always consume over HTTP.
- Update trigger: `http_host` can remain on the LAN; the item uses `127.0.0.1` (loopback).
- Identification/nominal values (rarely change) remain at `/identity`.

## 2. Suggested metrics and triggers

| Item | Source | Suggested trigger |
|---|---|---|
| `input.voltage` | NUT | `< 100 V` for > 30 s → **mains loss** |
| `ups.status` | NUT | contains `OB` → running on battery |
| `ups.status` | NUT | contains `LB` → low battery (critical) |
| `battery.charge` | NUT (estimated) | `< 30 %` → warning |
| `battery.runtime` | NUT (if `runtimecal`) | `< 300 s` → critical |
| `ups.load` | NUT | `> 90 %` for > 5 min → overload |
| `ups.temperature` | NUT | `> 45 °C` → warning |
| **Collection availability** | Agent | `nodata()` on the master item → communication failure (distinct from UPS failure) |
| `telemetry_valid` / `communication.state` | API (Option C) | `telemetry_valid = false` (or HTTP 503) → collection with no usable data |
| `/health` (`status`, `checks.*`) | API (Option C) | `status != ok` → degraded; `collector_thread = failed` → process without collection |

> The thresholds above are **suggestions**; they must be validated after resolving open items P1/P2.

## 3. Minimum security

- If using Option B: restrict `upsd`'s `LISTEN` to the management network and configure ACLs (`/etc/nut/upsd.users`).
- Prefer **Option A** (local collection), which does not expose NUT on the LAN.
- `zabbix-agent` needs access to `/dev/ttyACM0` (group `dialout`) **only** in Options A/B; in Option C
  it only consumes the API over loopback.
- In Option C, restrict access to port `8081` to the management network (the API has no authentication in this version).

## 4. Steps

1. Resolve P1/P2 (status and battery).
2. **Choose the data source (P7):** NUT (Options A/B) or REST API (Option C).
3. Copy `config/examples/ups.conf` to `/etc/nut/ups.conf` and start the services — **or** install the REST API
   (`config/examples/ts-shara-api.service` + `ts_shara_api.conf`) and validate with
   `python3 scripts/run_api.py --check` before starting the service.
4. Validate: `upsc ts_shara@localhost` (Option A/B) or
   `GET http://127.0.0.1:8081/api/v1/ups/tsshara-3200va-01/telemetry` (Option C).
5. Create the master item + dependent items in Zabbix (Option A or C) and import the template.
6. Define the final thresholds and test the triggers.
7. Document the final applied configuration in `zabbix-integration.md`.
