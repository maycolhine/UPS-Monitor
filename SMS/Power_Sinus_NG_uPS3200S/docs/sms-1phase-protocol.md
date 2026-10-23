# Protocol reverse engineering — SMS Power Sinus NG uPS3200S (SMS Brazil 1Phase)

Central document of the reverse engineering: it describes **how the data arrives** over the USB cable and **how to interpret it**.
All the samples below are **real**, captured on **2026-10-22** via `/dev/ttyUSB0`.

Unlike the TS Shara (which speaks Megatec/Q1 in **ASCII text**), this equipment uses a **binary**
protocol — the **SMS Brazil 1Phase** (the same one implemented by NUT's `sms_ser` driver). There is no
manufacturer app for this model on this bench; the protocol was reconstructed from the equipment's **real
responses** and validated against the specification that ships with SMS's **PowerView**
(`monofasico.xml`) and against the `sms_ser` driver.

## 1. Physical and link layer

| Parameter | Value |
|---|---|
| Transport | Serial over **USB-Serial** (Prolific PL2303 converter) → `/dev/ttyUSB0` |
| **VID:PID** | **`067b:23d3`** — Prolific Technology, Inc. USB-Serial Controller |
| Kernel driver | `pl2303` (over `usbserial`) |
| Baud | `2400` |
| Format | 8 data bits, 1 stop bit, no parity (**8N1**) |
| Terminator | `<CR>` (`\r`, `0x0D`) — both in the command and in the response |
| Communication model | **Poll-based** (master asks, UPS answers) |

The UPS **does not transmit spontaneously**: a command must be sent to get a response.

> **Difference from the TS Shara:** there the transport is USB **CDC-ACM** (`/dev/ttyACM0`); here it is a classic
> **USB-Serial** converter (`/dev/ttyUSB0`). This even changes the sysfs path (see
> [hardware-inventory.md](hardware-inventory.md) §2) and is what requires the port auto-detection by VID:PID
> to climb the sysfs tree from `/sys/class/tty/tty*` (see [tests-and-evidence.md](tests-and-evidence.md) T8).

## 2. Read commands (7 bytes)

Scan of the available and effectively used **read** commands:

| Key | Command sent (hex) | Function | Response |
|---|---|---|---|
| `Q` | `51 FF FF FF FF B3 0D` | **Meters + status** (main frame) | 18 bytes starting with `=` |
| `I` | `49 FF FF FF FF BB 0D` | **Identification** (model + firmware version) | 18 bytes starting with `:` |
| `F` | `46 FF FF FF FF BE 0D` | **Nominal characteristics** | 18 bytes starting with `;` |

Format of **every** command (7 bytes):

```
<CMD> 0xFF 0xFF 0xFF 0xFF <CHECKSUM> 0x0D
```

- `<CMD>` is the ASCII code of the key (`Q` = `0x51`, `I` = `0x49`, `F` = `0x46`).
- The **four** `0xFF` bytes are fixed parameters (`Param1..Param4 = -1`).
- `<CHECKSUM>` = `(4 - ord(CMD)) & 0xFF` — matches the XML formula (`(CMD + 4×(-1)) × -1`):

  | Key | `ord` | `4 - ord` | checksum |
  |---|---|---|---|
  | `Q` | 81 (`0x51`) | −77 | `0xB3` |
  | `I` | 73 (`0x49`) | −69 | `0xBB` |
  | `F` | 70 (`0x46`) | −66 | `0xBE` |

### 2.1 Action commands

The protocol also defines **action** commands (battery test, beep, shutdown). They **exist** and
**must not be sent** during monitoring: they trigger a battery test (drains the battery) or shut down the
output.

| Key | `ord` / value | Effect (as per `monofasico.xml` and `sms_ser`) |
|---|---|---|
| `M` | 77 (`0x4D`) | **Beeper** control |
| `L` | 76 (`0x4C`) | **Battery test until the low level** (*low battery*) |
| `T` | 84 (`0x54`) | **Timed battery test** — **with a duration parameter** (see §2.2) |
| `S` | 83 (`0x53`) | **Shutdown** (*shutdown*) |
| `R` | 82 (`0x52`) | Shutdown + restoration |
| `D` | 68 (`0x44`) | **Cancel test** |
| `C` | 67 (`0x43`) | Cancel shutdown |

### 2.2 The `T` command is PARAMETERIZED — the critical discovery of the incident

Unlike the read commands (which fix the four parameters at `0xFF`), `T` uses **`Param1` as the test
duration, in seconds**. This is explicit in NUT's reference driver `sms_ser.c`:

```c
/* sms_ser.c — sms_prepare_test_battery_nsec() */
buffer[0] = 'T';
buffer[1] = (uint8_t)(delay % 256);   /* <-- Param1 = DURATION IN SECONDS */
buffer[2] = 255;
buffer[3] = 255;
buffer[4] = 255;
buffer[5] = (buffer[0]+buffer[1]+buffer[2]+buffer[3]+buffer[4]) * 255;  /* checksum */
buffer[6] = ENDCHAR;

/* sms_ser.c — sms_prepare_test_battery_low()  -> key 'L', test until low battery */
/* sms_ser.c — sms_prepare_cancel_test()       -> key 'D', cancels the test     */
```

The NUT driver chooses the command by the received instruction:

| NUT instruction | Command | Semantics |
|---|---|---|
| `test.battery.start <seconds>` | `T` **with** `Param1 = seconds` | Test **by time** |
| `test.battery.start.quick` | `L` | Test **until low battery** |
| `test.battery.stop` | `D` | Cancels the test |

**Checksum with parameters other than `0xFF`:** the simplified formula `(4 - ord(CMD)) & 0xFF` used in the
reads **only holds** when the four parameters are `0xFF`. The **general** formula (the same as the C above) is:

```
checksum = (-sum(bytes[0..5])) & 0xFF      # bytes[0] = CMD, bytes[1..4] = Param1..Param4
```

Real bytes of each command (`Param1` explicit in `T`):

| Command | Bytes (hex) | Note |
|---|---|---|
| `L` | `4C FF FF FF FF B8 0D` | Test **until low battery** (full battery discharge) |
| `T` with duration 10 s | `54 0A FF FF FF A5 0D` | **Timed** test of 10 s — the **correct** one |
| `T` with `Param1 = 0xFF` | `54 FF FF FF FF B0 0D` | ⚠️ read by the firmware as "**no duration**" → behaves like `L` |
| `D` | `44 FF FF FF FF C0 0D` | Cancels the test |

> **INCIDENT 2026-10-22 (reported in [tests-and-evidence.md](tests-and-evidence.md) T10).** The test
> triggered by the *frontend*/API used `T` → `54 FF FF FF FF B0 0D` (the `Param1` stays `0xFF` because the command
> building routine fixes the four parameters). The firmware interpreted `0xFF` as **indefinite duration** and
> ran the test **until the battery drained** — the same effect as the `L` command. Result: the `TEST` bit stayed
> on for an indefinite time, with `OB`+`BOOST`+`BEEP`, and the battery dropped from **100 % to 18 %**. The
> cancellation was done with `D`.
>
> **Conclusion:** `T` is **not** a "10 s test" by itself — what defines the duration is `Param1`. Without that
> parameter, the equipment **has no** time limit to finish the test.
>
> **Fix (applied on 2026-10-22):** the `upsmon` driver started sending `T` **with** `Param1` = duration
> (`action_bytes`; cap `0xFE`, since `0xFF` is reserved) and the collector started sending `D` when **closing the
> window** (not only on *abort*). Validated live in [tests-and-evidence.md](tests-and-evidence.md) T11.

> **SAFETY ALERT:** no action command was sent during the protocol **discovery** — the
> collector and the API implement **only** `Q`, `I` and `F` (decision D9 in
> [decisions-and-open-items.md](decisions-and-open-items.md)). The `T` (sent incorrectly) and the `D` only came
> to be used later, with the `upsmon` battery test function (contract 3.0). Writing to the serial port
> with any of these bytes can **drain the battery** or **shut down the load**.

## 3. General format of the responses (18 bytes)

Every response has **18 bytes**, terminated by `<CR>` (`0x0D`):

```
[0]      start byte    (varies by command)
[1..15]  fields        (15 bytes)
[16]     checksum
[17]     <CR> = 0x0D
```

- **Checksum:** `CK = (-sum(bytes[0..15])) & 0xFF`.
- **Accepted start bytes:**

  | Command | Accepted starts | Observed |
  |---|---|---|
  | `Q` | `<` `0x3C`, `=` `0x3D`, `>` `0x3E` | `=` (`0x3D`) |
  | `I` / `F` | `:` `0x3A`, `;` `0x3B` | `:` for `I`, `;` for `F` |

## 4. Main frame — `Q` command (meters + status)

### 4.1 Format

```
[0]=  [1..2] [3..4] [5..6] [7..8] [9..10] [11..12] [13..14] [15]<CR>
```

Each numeric field takes **2 bytes, big-endian, in tenths** (divide by 10).

### 4.2 Field by field

| Offset | Bytes | Field (XML `monofasico.xml`) | NUT `sms_ser` | Our field | Example |
|---|---|---|---|---|---|
| 0 | 1 | Type / start | start char | — | `=` |
| 1–2 | 2 | `UltimaTensao` | `lastinputVac` | `input_voltage_extended_v` | `0.0` |
| 3–4 | 2 | `TensaoEntrada` | `inputVac` | `input_voltage_v` | `217.7` |
| 5–6 | 2 | `TensaoSaida` | `outputVac` | `output_voltage_v` | `217.7` |
| 7–8 | 2 | `PotenciaSaida` | `outputpower` | `load_percent` | `20.0` |
| 9–10 | 2 | `FrequenciaSaida` | `outputHz` | `output_frequency_hz` | `59.9` |
| 11–12 | 2 | `PorcentagemTensaoBateria` | `batterylevel` | `battery_charge_percent` | `100.0` |
| 13–14 | 2 | `Temperatura` | `temperatureC` | `temperature_c` | `49.1` |
| 15 | 1 | status bits | bits | `status` | `0x29` |

> **Mind the order:** unlike Megatec, there is **no separator space** and the `input_voltage_extended_v`
> field (bytes 1–2) comes **before** the input voltage. In the capture, it came as `0`.

### 4.3 Status bits (byte 15)

`b0` is the least significant bit. The frame is displayed as `b7 b6 b5 b4 b3 b2 b1 b0`.

| Bit | Tag | `1` means |
|---|---|---|
| b0 | `BEEP` | Beeper on |
| b1 | `FSD` | Shutdown active (*shutdown*) |
| b2 | `TEST` | Battery test in progress |
| b3 | `UPSOK` | Inverter/mains OK (no fault) |
| b4 | `BOOST` | Boost/Buck active |
| b5 | `BYPASS` | Bypass active |
| b6 | `LB` | Low battery (*low battery*) |
| b7 | `OB` | Mains absent / running on battery (*on battery*) |

### 4.4 Real samples of the `Q` command

```
Q -> 3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d
Q -> 3d 00 00 08 79 08 81 00 c8 02 58 03 e8 01 eb 29 97 0d
Q -> 3d 00 00 08 85 08 81 00 be 02 57 03 e8 01 eb 29 96 0d
```

Decoding of the first one (byte 16 = `0x90` = checksum, byte 17 = `0x0D`):

```
input (extended)    = 0x0000 / 10 =   0.0 V
input               = 0x0881 / 10 = 217.7 V
output              = 0x0881 / 10 = 217.7 V
load                = 0x00c8 / 10 =  20.0 %
output frequency    = 0x0257 / 10 =  59.9 Hz
battery             = 0x03e8 / 10 = 100.0 %
temperature         = 0x01eb / 10 =  49.1 C
status              = 0x29 = 00101001 -> b0=BEEP, b3=UPSOK, b5=BYPASS
checksum            = 0x90  (-(sum of the first 16) & 0xFF)  OK
```

Checksum verification: sum of the first 16 bytes = 1136; `(-1136) & 0xFF = 0x90` ✔

## 5. Identification frame — `I` command

**Fixed-width** format:

```
[0]=':'  [1..12]=model (12)  [13..15]=version (3)  [16]=CK  [17]=<CR>
```

Real sample:

```
I -> 3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d
     ':' 'P''o''w''e''r'' ''S''i''n''u''s'' '  '1''.''2'  CK  CR
```

| Slice | Bytes | Value | Field |
|---|---|---|---|
| `[1..12]` | 12 | `Power Sinus ` → `Power Sinus` | `model` |
| `[13..15]` | 3 | `1.2` | `firmware` |

## 6. Nominal characteristics frame — `F` command

**Fixed-width** format (textual labels, with padding spaces):

```
[0]=';'  [1..7]=voltage range (7)  [8..10]=current range (3)  [11..13]=battery voltage (3)  [14..15]=frequency (2)  [16]=CK  [17]=<CR>
```

Real sample:

```
F -> 3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d
     ';' '2''2''0'' '' '' '' '  '0''0''0'  ' ''2''4'  '6''0'  CK  CR
```

| Slice | Bytes | Label | Value | Field |
|---|---|---|---|---|
| `[1..7]` | 7 | `220    ` → `220` | 220 | `nominal.voltage_v` (V) |
| `[8..10]` | 3 | `000` | 0 | `nominal.input_current_a` (A) |
| `[11..13]` | 3 | ` 24` → `24` | 24 | `nominal.battery_voltage_v` (V) |
| `[14..15]` | 2 | `60` | 60 | `nominal.frequency_hz` (Hz) |

> The labels may contain spaces and, in other models, non-numeric text (e.g.: `Univ.`); that is why the parser
> extracts only the digits and returns `null` when the label has no number (never a fictitious value).
>
> The XML describes the same four ranges with the names `FaixaTensao` / `FaixaCorrente` / `TensaoBateria` /
> `Frequencia`; the `sms_ser` driver reads the same four fields in the same order — hence the cross-validation.

## 7. Battery: the percentage COMES from the equipment; the voltage is DERIVED

This is the **conceptual difference** with respect to the TS Shara:

- The `Q` frame transmits the battery charge **percentage** (`PorcentagemTensaoBateria`, bytes 11–12).
  It is **not** our estimate — it comes from the equipment (here, `100.0 %`).
- The battery **voltage** is **not** transmitted. It is **derived**, as the NUT `sms_ser` driver does:

```
battery.voltage = nominal_voltage_battery × percentage / 100
battery.packs   = nominal_voltage_battery / 12      (12 V batteries in series)
```

With `nominal = 24 V` (confirmed by the `F` command) and `100 %`:

```
voltage = 24 × 100 / 100 = 24.0 V
packs   = 24 / 12        = 2
```

In the API, this block is explicitly labeled:

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

## 8. Nameplate nominal values × commands

| Quantity | Equipment nameplate | `F` command (real) |
|---|---|---|
| Power | 3200 VA | — (not provided by the protocol) |
| Input voltage | 220 V~ | 220 |
| Output voltage | 220 V~ | — (not provided; measured in the `Q` frame ≈ 217.7 V) |
| Frequency | 60 Hz | 60 |
| Battery (internal) | — | 24 V (2 × 12 V) |

## 9. Quick decoding (history of one sample)

```
Command  : Q  (51 FF FF FF FF B3 0D)
Response : 3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d
Decoded:
  input (extended)    =   0.0 V
  input               = 217.7 V
  output              = 217.7 V
  load                =  20.0 %
  output frequency    =  59.9 Hz
  battery             = 100.0 %
  temperature         =  49.1 C
  status              = 00101001 -> BEEP + UPSOK + BYPASS
```

## 10. References

- SMS Brazil specification — protocol files that ship with SMS's **PowerView**
  (`monofasico.xml`, `verificaProtocolo.xml`): defines the commands, the four `0xFF` parameters, the checksum
  formula and the field names.
- NUT (Network UPS Tools) — **`sms_ser`** driver / `sms_ser.c` / `sms_ser.h`: implementation of the
  single-phase variant, used to **validate** the field-by-field mapping (voltages, load, frequency, battery
  percentage, temperature, status bits and the battery voltage derivation).
