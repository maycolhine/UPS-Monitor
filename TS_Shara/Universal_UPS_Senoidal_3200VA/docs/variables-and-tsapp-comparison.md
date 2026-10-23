# Identified variables and comparison with the TS App

## 1. Full dump of the NUT driver (nutdrv_qx 2.8.1)

Output of `nutdrv_qx -a ts_shara -u <user> -d 2` (sample of 2026-10-20):

```
battery.charge: 23
battery.voltage: 22.0
battery.voltage.high: 26.00
battery.voltage.low: 20.80
battery.voltage.nominal: 24.0
device.mfr: TS -222  091225
device.model: Senoid  32
device.type: ups
input.current.nominal: 100.0
input.frequency: 60.0
input.frequency.nominal: 60
input.voltage: 228.0
input.voltage.fault: 228.0
output.voltage: 115.0
ups.beeper.status: enabled
ups.delay.shutdown: 30
ups.delay.start: 180
ups.firmware: V01020805A
ups.load: 88
ups.status: OB CAL
ups.temperature: 26.0
ups.type: offline / line interactive
```

## 2. Comparison with the TS App (Windows)

Fill the "TS App" column with a simultaneous reading to validate units and rounding
(do not cause a power outage — compare only under normal operation).

| Quantity | TS App (Windows) | Ubuntu — NUT / collector | Note |
|---|---|---|---|
| Input voltage | _to confirm_ | `input.voltage` = 228.0 V | |
| Output voltage | _to confirm_ | `output.voltage` = 115.0 V | ~110–115 V is expected even at 220 V (manufacturer note) |
| Frequency | _to confirm_ | `input.frequency` = 60.0 Hz | |
| Temperature | _to confirm_ | `ups.temperature` = 26.0 °C | |
| Load | _to confirm_ | `ups.load` = 88–95 % | output current as % of nominal |
| Battery percentage | _to confirm_ | `battery.charge` = 23 % | **derived**, does not come from the device (see §3) |
| Battery voltage | _to confirm_ | `battery.voltage` = 19.8–22.6 V | dropping during the session — see open items |
| State (online/battery) | _to confirm_ | `ups.status` = `OB CAL` | divergent from expected — see open items |
| Estimated runtime | _to confirm_ | not calculated | requires `runtimecal` in `ups.conf` |

## 3. About the battery percentage

The **Megatec/Q1 protocol does not transmit the battery percentage**. NUT **estimates** `battery.charge` from the
voltage, using the limits `battery.voltage.low = 20.80 V` and `battery.voltage.high = 26.00 V` ("guesstimated"
values by default, since the device does not send the real limits). Therefore:

- If the TS App shows an "official" percentage, it probably uses the **same estimation logic** (voltage) or a
  parallel proprietary protocol.
- For Zabbix, `battery.charge` must be treated as an **estimate**.

## 4. Useful variables for Zabbix

| NUT variable | Suggested use in Zabbix |
|---|---|
| `ups.status` | State (OL/OB/LB/…); basis for mains-loss triggers |
| `input.voltage` | Detect absence/anomaly of mains |
| `output.voltage` | Output health |
| `input.frequency` | Frequency anomaly |
| `ups.load` | Overload |
| `battery.voltage` | Battery health/age |
| `battery.charge` | Battery level (estimated) |
| `ups.temperature` | Overheating |
| `battery.runtime` | Runtime (if `runtimecal` configured) |

The final item names should follow the naming standard adopted in Zabbix.
