# Identified variables and mapping (protocol → API → NUT → Zabbix)

This model **does not have** a manufacturer application for cross-comparison (unlike the TS Shara's TS App).
The validation was done against the **protocol specification** (`monofasico.xml`, which ships with SMS's
PowerView) and against the **NUT `sms_ser` driver**. Below is the complete mapping between the protocol fields, the
REST API contract, the names used by `sms_ser` and the suggested items for Zabbix.

## 1. `Q` frame (meters + status) → API contract

Each numeric field takes **2 bytes, big-endian, in tenths** (divide by 10). Offsets per
[sms-1phase-protocol.md](sms-1phase-protocol.md) §4.

| Offset | Field (XML `monofasico.xml`) | NUT driver `sms_ser` | API field (`data.measurements`) | Example |
|---|---|---|---|---|
| 1–2 | `UltimaTensao` | `lastinputVac` | `input_voltage_extended_v` | `0.0 V` |
| 3–4 | `TensaoEntrada` | `inputVac` | `input_voltage_v` | `217.7 V` |
| 5–6 | `TensaoSaida` | `outputVac` | `output_voltage_v` | `217.7 V` |
| 7–8 | `PotenciaSaida` | `outputpower` | `load_percent` | `20.0 %` |
| 9–10 | `FrequenciaSaida` | `outputHz` | `output_frequency_hz` | `59.9 Hz` |
| 11–12 | `PorcentagemTensaoBateria` | `batterylevel` | `battery.charge_percent` | `100.0 %` |
| 13–14 | `Temperatura` | `temperatureC` | `temperature_c` | `49.1 °C` |
| 15 | status bits | bits | `status.raw_bits` / `flags` | `0x29` → `00101001` |

> **Order of the voltages:** unlike Megatec, there is **no separator** and the "last voltage" (`UltimaTensao`,
> bytes 1–2) comes **before** the input voltage. In the capture, it came as `0`.

## 2. Status bits (byte 15)

| Bit | API flag | `1` means | Suggested state in Zabbix |
|---|---|---|---|
| b0 | `BEEP` | Beeper on | informative |
| b1 | `FSD` | Shutdown active (*shutdown*) | event |
| b2 | `TEST` | Battery test in progress | informative |
| b3 | `UPSOK` | Inverter/mains OK (no fault) | `0` → failure |
| b4 | `BOOST` | Boost/Buck active | informative |
| b5 | `BYPASS` | Bypass active | informative (validate — P5) |
| b6 | `LB` | Low battery (*low battery*) | **critical** |
| b7 | `OB` | Mains absent / running on battery | **mains outage** |

## 3. Battery: percentage × voltage (the **opposite** of Megatec)

In the SMS 1Phase protocol:

- the charge **percentage COMES FROM the equipment** (`PorcentagemTensaoBateria`, bytes 11–12) — it is not an estimate;
- the **voltage** **is not transmitted** and is **derived**, as the `sms_ser` driver does:

```
battery.voltage = nominal_voltage_battery × percentage / 100
battery.packs   = nominal_voltage_battery / 12      (12 V batteries in series)
```

With `nominal = 24 V` (confirmed by the `F` command) and `100 %`:

```
voltage = 24 × 100 / 100 = 24.0 V
packs   = 24 / 12        = 2
```

In the API this block is explicitly labeled:

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

> **Consequence:** `battery.voltage` does **not** measure the pack — it follows the percentage. For battery diagnosis,
> use the **percentage** and the `LB` bit (see [decisions-and-open-items.md](decisions-and-open-items.md) P2).

## 4. Cross-validation procedure (optional — PowerView)

It is only possible if there is access to SMS's **PowerView**. If so, compare in normal operation (mains present,
**without** causing a power outage or a battery test):

| Quantity | Ubuntu (API/collector) | PowerView | Note |
|---|---|---|---|
| Input voltage | _to be confirmed_ | _to be confirmed_ | `Q` frame bytes 3–4 |
| Output voltage | _to be confirmed_ | _to be confirmed_ | `Q` frame bytes 5–6 |
| Frequency | _to be confirmed_ | _to be confirmed_ | `Q` frame bytes 9–10 |
| Load | _to be confirmed_ | _to be confirmed_ | `Q` frame bytes 7–8 |
| Battery percentage | _to be confirmed_ | _to be confirmed_ | `Q` frame bytes 11–12 (comes from the equipment) |
| Temperature | _to be confirmed_ | _to be confirmed_ | `Q` frame bytes 13–14 |
| State (flags) | _to be confirmed_ | _to be confirmed_ | byte 15 — validate P5 |

> Without PowerView, the available validation is the one **crossed with `sms_ser`** (same protocol, same fields).

## 5. Useful variables for Zabbix

| Variable | Source | Suggested use in Zabbix |
|---|---|---|
| `status.raw_bits` | API/NUT | State (mains/battery/LB/…); base for mains-outage triggers |
| `input_voltage_v` | API/NUT | Detect absence/anomaly of the mains |
| `output_voltage_v` | API/NUT | Output health |
| `output_frequency_hz` | API/NUT | Frequency anomaly |
| `load_percent` | API/NUT | Overload |
| `battery.charge_percent` | API/NUT | Battery level (reported by the equipment) |
| `battery.voltage_v` | API/NUT (**derived**) | Reference only — see §3 |
| `temperature_c` | API/NUT | Overheating |
| `battery.runtime` | — | **unavailable** in the protocol (P4) |

The final item names must follow the naming standard adopted in Zabbix.
