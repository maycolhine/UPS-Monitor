# Spec — Data specification for the SMS Power Sinus NG uPS3200S UPS (USB → Zabbix)

**Equipment:** SMS Power Sinus NG uPS3200S (nameplate: **3200 VA**, input **220 V~**, output **220 V~**,
**60 Hz**)
**Firmware identification:** `Power Sinus` (version `1.2`)
**Interface:** USB-Serial (Prolific PL2303 converter) → `/dev/ttyUSB0` — **not HID nor CDC-ACM**
**Protocol:** **SMS Brazil 1Phase** (binary), **poll-based**
**Reference driver:** NUT 2.8.1 `sms_ser` (`Network UPS Tools - SMS Brazil UPS driver 1.00`)
**Last update:** 2026-10-22

> This document **consolidates** the other documents of the model. It is the single reference specification for
> converting the frames received over USB into monitoring metrics.
> Sources: [README](README.md), [hardware-inventory](docs/hardware-inventory.md),
> [sms-1phase-protocol](docs/sms-1phase-protocol.md),
> [nut-installation-and-configuration](docs/nut-installation-and-configuration.md),
> [variables-and-mapping](docs/variables-and-mapping.md),
> [tests-and-evidence](docs/tests-and-evidence.md), [decisions-and-open-items](docs/decisions-and-open-items.md).

> **Note on "decrypting":** the protocol **is not encrypted**. The data arrives as **fixed-width binary
> bytes**; the work is to **decode** (parse) each field, the scale (tenths, big-endian) and the
> **status bits**. That is what this document describes.
>
> **Difference from the TS Shara:** there the protocol is **ASCII text** (Megatec/Q1); here it is **binary**
> (SMS Brazil 1Phase). And the inverse for the battery: **here the percentage comes from the equipment and the voltage is derived**.

---

## 1. Scope

Define, field by field, **everything the equipment sends over USB**, to allow:

1. Collecting locally on Ubuntu (via the REST API/collector of this repository or via NUT's `sms_ser`);
2. Converting into metrics readable by monitoring (Zabbix);
3. Publishing the data in versioned JSON through the REST API.

---

## 2. Physical and link layer

| Parameter | Value | Note |
|---|---|---|
| Transport | Serial over **USB-Serial** | Prolific PL2303 converter → `/dev/ttyUSB0` |
| **VID:PID** | **`067b:23d3`** | Prolific Technology, Inc. USB-Serial Controller |
| Kernel driver | `pl2303` (over `usbserial`) | **not** HID nor CDC-ACM |
| Interfaces | `1` (`1-1:1.0`), class `ff` (Vendor Specific) | 3 endpoints |
| Baud | `2400` | fixed in the protocol (also fixed in `sms_ser`) |
| Format | 8N1 | 8 data, no parity, 1 stop |
| Encoding | **Binary** | numeric fields of 2 bytes, big-endian, in tenths |
| Command terminator | `<CR>` = `\r` = `0x0D` | sent **by** the host |
| Response terminator | `<CR>` = `\r` = `0x0D` | sent **by** the UPS |
| Communication model | **Poll-based** | the UPS **does not** transmit on its own |
| Linux permission | `root:dialout` | use the `dialout` group or a udev rule |

**Recommended udev rule** (permission + blocking of `ModemManager`, which injects `AT` commands):

```bash
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="23d3", MODE="0660", GROUP="dialout"
SUBSYSTEM=="usb", ATTR{idVendor}=="067b", ATTR{idProduct}=="23d3", ENV{ID_MM_DEVICE_IGNORE}="1"
```

> The sysfs layout is different from CDC-ACM (there is an intermediate level: `1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0`).
> Details in [hardware-inventory.md](docs/hardware-inventory.md) §2.

---

## 3. Protocol: supported commands

Every command has **7 bytes**: `<CMD> 0xFF 0xFF 0xFF 0xFF <CHECKSUM> 0x0D`, with
`<CHECKSUM> = (4 − ord(CMD)) & 0xFF`.

| Send | Command (hex) | Response (real example) | Function |
|---|---|---|---|
| `Q` | `51 FF FF FF FF B3 0D` | `3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d` | **Status + measurements** (main frame) |
| `I` | `49 FF FF FF FF BB 0D` | `3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d` | **Identification** (model + firmware) |
| `F` | `46 FF FF FF FF BE 0D` | `3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d` | **Nominal characteristics** |

### 3.1 Action commands — **DO NOT USE**

The protocol also defines **action** commands. They **exist** and **must not be sent** during monitoring:
they trigger a battery test (drains the battery) or shut down the output. Listed only to **recognize and avoid**.

| Key | `ord` | Effect (as per `monofasico.xml`) |
|---|---|---|
| `M` | 77 | **Beeper** control |
| `L` | 76 | **Battery test until low battery** |
| `T` | 84 | **Timed battery test** |
| `S` | 83 | **Shutdown** (*shutdown*) |
| `R` | 82 | Shutdown + restoration |
| `D` | 68 | Cancel test |
| `C` | 67 | Cancel shutdown |

> **SAFETY ALERT:** none of these commands was sent. The collector and the API implement **only**
> `Q`, `I` and `F` (decision D9). Writing any of these bytes to the port can **drain the battery** or
> **shut down the load**.

---

## 4. General format of the responses (18 bytes)

Every response has **18 bytes**, terminated by `<CR>` (`0x0D`):

```
[0]      start byte    (varies by command)
[1..15]  fields        (15 bytes)
[16]     checksum
[17]     <CR> = 0x0D
```

- **Response checksum:** `CK = (−sum(bytes[0..15])) & 0xFF`.
- **Accepted start bytes:**

  | Command | Accepted starts | Observed |
  |---|---|---|
  | `Q` | `<` `0x3C`, `=` `0x3D`, `>` `0x3E` | `=` (`0x3D`) |
  | `I` / `F` | `:` `0x3A`, `;` `0x3B` | `:` for `I`, `;` for `F` |

---

## 5. Main frame — `Q` command (meters + status)

### 5.1 Format

```
[0]=  [1..2] [3..4] [5..6] [7..8] [9..10] [11..12] [13..14] [15]<CR>
```

Each numeric field takes **2 bytes, big-endian, in tenths** (divide by 10).

### 5.2 Field by field

| Offset | Field (XML `monofasico.xml`) | NUT driver `sms_ser` | API field | Example |
|---|---|---|---|---|
| 0 | Type / start | start char | — | `=` |
| 1–2 | `UltimaTensao` | `lastinputVac` | `input_voltage_extended_v` | `0.0 V` |
| 3–4 | `TensaoEntrada` | `inputVac` | `input_voltage_v` | `217.7 V` |
| 5–6 | `TensaoSaida` | `outputVac` | `output_voltage_v` | `217.7 V` |
| 7–8 | `PotenciaSaida` | `outputpower` | `load_percent` | `20.0 %` |
| 9–10 | `FrequenciaSaida` | `outputHz` | `output_frequency_hz` | `59.9 Hz` |
| 11–12 | `PorcentagemTensaoBateria` | `batterylevel` | `battery.charge_percent` | `100.0 %` |
| 13–14 | `Temperatura` | `temperatureC` | `temperature_c` | `49.1 °C` |
| 15 | status bits | bits | `status` | `0x29` |

### 5.3 Status bits (byte 15)

`b0` is the least significant bit; the frame is displayed as `b7 b6 b5 b4 b3 b2 b1 b0`.

| Bit | Flag | `1` means |
|---|---|---|
| b0 | `BEEP` | Beeper on |
| b1 | `FSD` | Shutdown active (*shutdown*) |
| b2 | `TEST` | Battery test in progress |
| b3 | `UPSOK` | Inverter/mains OK (no fault) |
| b4 | `BOOST` | Boost/Buck active |
| b5 | `BYPASS` | Bypass active |
| b6 | `LB` | Low battery (*low battery*) |
| b7 | `OB` | Mains absent / running on battery (*on battery*) |

### 5.4 Decoded example: `0x29`

```
frame  : 3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d
status : 0x29 = 00101001
bits   :  b7 b6 b5 b4 b3 b2 b1 b0
value  :   0  0  1  0  1  0  0  1
```

→ `BEEP` + `UPSOK` + `BYPASS` (mains present, load 20 %, battery 100 %).

---

## 6. Identification frame — `I` command

**Fixed-width** format:

```
[0]=':'  [1..12]=model (12)  [13..15]=version (3)  [16]=CK  [17]=<CR>
```

Real sample:

```
I -> 3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d
```

| Slice | Bytes | Value | Field |
|---|---|---|---|
| `[1..12]` | 12 | `Power Sinus ` → `Power Sinus` | `device.model` |
| `[13..15]` | 3 | `1.2` | `firmware` |

---

## 7. Nominal characteristics frame — `F` command

**Fixed-width** format (textual labels with padding spaces):

```
[0]=';'  [1..7]=voltage range (7)  [8..10]=current range (3)  [11..13]=battery voltage (3)  [14..15]=frequency (2)  [16]=CK  [17]=<CR>
```

Real sample:

```
F -> 3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d
```

| Slice | Bytes | Label | Value | API field |
|---|---|---|---|---|
| `[1..7]` | 7 | `220    ` | 220 | `nominal.voltage_v` (V) |
| `[8..10]` | 3 | `000` | 0 | `nominal.input_current_a` (A) |
| `[11..13]` | 3 | ` 24` | 24 | `nominal.battery_voltage_v` (V) |
| `[14..15]` | 2 | `60` | 60 | `nominal.frequency_hz` (Hz) |

> The labels may contain spaces and, in other models, non-numeric text (e.g.: `Univ.`); the parser extracts
> only the digits and returns `null` when there is no number (never a fictitious value).

---

## 8. Battery: the percentage COMES from the equipment; the voltage is DERIVED

This is the **conceptual difference** with respect to the TS Shara:

- the `Q` frame transmits the charge **percentage** (`PorcentagemTensaoBateria`, bytes 11–12) — it comes from the
  equipment, it is **not** our estimate;
- the battery **voltage** is **not** transmitted; it is **derived**, as `sms_ser` does:

```
battery.voltage = nominal_voltage_battery × percentage / 100
battery.packs   = nominal_voltage_battery / 12      (12 V batteries in series)
```

With `nominal = 24 V` and `100 %` → `24.0 V` and `packs = 2`. In the API:

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

> **Consequence (P2):** `battery.voltage` does **not** measure the pack — it follows the percentage. For diagnosis,
> use the **percentage** and the `LB` bit.

---

## 9. Complete mapping → API → Zabbix

| Source (frame) | API field | Zabbix metric (suggestion) | Type | Suggested trigger |
|---|---|---|---|---|
| `Q` byte 15 | `status.raw_bits` | `status.raw_bits` | text | b7 `OB` → mains outage; b6 `LB` → critical |
| `Q` bytes 3–4 | `input_voltage_v` | `input.voltage` | numeric | `< 100 V` for 30 s → mains absent |
| `Q` bytes 1–2 | `input_voltage_extended_v` | `input.voltage.extended` | numeric | reference (`0` in the capture) |
| `Q` bytes 5–6 | `output_voltage_v` | `output.voltage` | numeric | outside ~200–230 V → warning |
| `Q` bytes 7–8 | `load_percent` | `ups.load` | numeric | `> 90 %` for 5 min → overload |
| `Q` bytes 9–10 | `output_frequency_hz` | `output.frequency` | numeric | outside 57–63 Hz → warning |
| `Q` bytes 11–12 | `battery.charge_percent` | `battery.charge` | numeric | `< 30 %` → warning |
| (derived) | `battery.voltage_v` | `battery.voltage` | numeric | reference only (derived — §8) |
| `Q` bytes 13–14 | `temperature_c` | `ups.temperature` | numeric | `> 45 °C` → warning |
| `I` | `device.model` / `firmware` | inventory | text | — |
| `F` | `nominal.*` | ratings | numeric | reference |
| — | — | `battery.runtime` | — | **not available** in the protocol (P4) |

---

## 10. Real samples (record — 2026-10-22)

| Command | Raw frame |
|---|---|
| `Q` | `3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d` |
| `Q` | `3d 00 00 08 79 08 81 00 c8 02 58 03 e8 01 eb 29 97 0d` |
| `Q` | `3d 00 00 08 85 08 81 00 be 02 57 03 e8 01 eb 29 96 0d` |
| `I` | `3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d` |
| `F` | `3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d` |

Decoding of the first one (`Q`):

```
input (extended)    = 0x0000 / 10 =   0.0 V
input               = 0x0881 / 10 = 217.7 V
output              = 0x0881 / 10 = 217.7 V
load                = 0x00c8 / 10 =  20.0 %
output frequency    = 0x0257 / 10 =  59.9 Hz
battery             = 0x03e8 / 10 = 100.0 %
temperature         = 0x01eb / 10 =  49.1 C
status              = 0x29 = 00101001 -> BEEP + UPSOK + BYPASS
checksum            = 0x90  (sum of the first 16 = 1136; (-1136) & 0xFF = 0x90)  OK
```

---

## 11. Conversion rules (summary for the collector/Zabbix)

1. Send `Q`, `I`, `F` (read-only) and read 18 bytes up to `<CR>`. **Never** send `M`, `L`, `T`, `S`, `R`,
   `D` or `C` (§3.1).
2. Validate the checksum `(−sum(bytes[0..15])) & 0xFF` before interpreting.
3. Read each field as 2 bytes **big-endian** in **tenths** (§5.2).
4. Derive the 8 status bits and convert them into flags (`OB`, `LB`, `BYPASS`, …).
5. Battery percentage **comes from the equipment**; voltage **derived** (§8).
6. Publish numeric metrics in SI as per §5.2 (V, %, Hz, °C).
7. Availability items: `nodata()` on the master item → **communication** failure (distinct from a UPS failure).

---

## 12. Known limitations

| Limitation | Impact | Handling |
|---|---|---|
| Battery voltage is **not** transmitted | `battery.voltage` is derived | labeled `voltage_derived = true` (P2) |
| No energy (kWh) | no accumulated consumption | out of scope |
| No runtime (`runtime`) | no `battery.runtime` | out of scope (P4) |
| Only 3 **read** commands (`Q`, `I`, `F`) | few extra data | firmware limitation |
| Action commands test/shut down **without** responding | risk of shutting down the load | **do not** use — §3.1 |
| `ModemManager` on the port | corrupts the communication | udev rule `ID_MM_DEVICE_IGNORE` |
| Fine meaning of `BYPASS`/`UPSOK` | risk of an incorrect trigger | validate the bits (P5) |

---

## 13. References

- SMS Brazil specification — protocol files that ship with SMS's **PowerView** (`monofasico.xml`,
  `verificaProtocolo.xml`): commands, four `0xFF` parameters, checksum formula and field names.
- NUT 2.8.1 — **`sms_ser`** driver / `sms_ser.c` / `sms_ser.h`: implementation of the single-phase variant, used
  to **validate** the field-by-field mapping and the battery voltage derivation.
