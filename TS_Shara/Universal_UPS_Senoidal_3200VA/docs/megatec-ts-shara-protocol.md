# Protocol reverse engineering — TS Shara (Megatec/Q1)

Central reverse-engineering document: it describes **how the data is sent** by the UPS and **how to interpret it**.
All samples below are real, captured on 2026-10-20 via `/dev/ttyACM0`.

## 1. Physical and link layer

| Parameter | Value |
|---|---|
| Transport | Serial over USB CDC-ACM (`/dev/ttyACM0`) |
| Nominal baud | `2400` (per the Megatec specification) |
| Observed baud | The CDC-ACM port **ignores** the baud; intact responses at 2400, 9600, 19200 and 115200 |
| Format | 8 data bits, 1 stop bit, no parity (8N1) |
| Terminator | `<CR>` (`\r`, 0x0D) |
| Communication model | **Poll-based** (master asks, UPS answers) |

The UPS **does not transmit data spontaneously**: a passive read of up to 1024 bytes returned **0 bytes** at
all bauds tested. A command must be sent to get a response.

## 2. Recognized commands

Full scan (`A-Z`, `a-z`, `0-9`, terminated by `<CR>`): **only 3 commands responded**.

| Command | Send | Response | Function |
|---|---|---|---|
| `Q1` | `Q1\r` | `(228.0 228.0 115.0 093 60.0 19.8 26.0 10001101\r` | Status + instantaneous measurements |
| `I` | `I\r` | `#TS -222  091225 Senoid  32 V01020805A\r` | Identification (manufacturer/model/firmware) |
| `F` | `F\r` | `#Univ. 100 24.00 60.0\r` | Nominal ratings |

Commands **without response** that are **not** read commands: `T` (battery test of ~10 s), `TL` (test until the
battery drops) and `S` (shutdown). They are **action commands**: the UPS **executes them without responding**
(empty return). Details (sending, effect and how to observe via `Q1`) in section **3.1** of [Spec.md](../Spec.md).

With no response **and** no effect (not supported): `Q`, `D`, `M`, `V`, `N`, `C` and any other letter/digit.

> **ALERT:** `T`/`TL` were sent by mistake during testing and **discharged the battery** of unit 1, shutting down
> the load. For reading, use **only** `Q1`, `I` and `F`.

## 3. Status and measurements frame — command `Q1`

Format (Megatec specification, "Advance-Intelligent UPS"):

```
(MMM.M NNN.N PPP.P QQQ RR.R S.SS TT.T b7b6b5b4b3b2b1b0<CR>
```

| Field | Example | Unit | Description |
|---|---|---|---|
| `(` | — | — | Start byte |
| `MMM.M` | `228.0` | V | **Input** voltage |
| `NNN.N` | `228.0` | V | Input fault voltage (glitch/mains absent) |
| `PPP.P` | `115.0` | V | **Output** voltage |
| `QQQ` | `093` | % | Output current **= load** (% of nominal) |
| `RR.R` | `60.0` | Hz | Input frequency |
| `S.SS` / `SS.S` | `19.8` | V | **Battery** voltage (format depends on the type: standby = `SS.S`) |
| `TT.T` | `26.0` | °C | Temperature |
| `b7..b0` | `10001101` | — | 8 status bits (ASCII `0`/`1`) |

### Meaning of the status bits (Megatec specification)

| Bit | Name | `1` means |
|---|---|---|
| b7 | Utility Fail | Mains absent / running on battery |
| b6 | Battery Low | Low battery |
| b5 | Bypass/Boost | Boost/Buck or Bypass active |
| b4 | UPS Failed | UPS fault |
| b3 | UPS Type | `1` = **standby/line-interactive**, `0` = online |
| b2 | Test in Progress | Battery test in progress |
| b1 | Shutdown Active | Shutdown active |
| b0 | Beeper On | Beeper on |

> **Bench note:** bit b7 (`OB`) appeared as `1` on both units. In the retest of the unloaded unit this was
> confirmed **correct**: `input.voltage ≈ 1 V` (no mains) → running on battery. See
> [decisions-and-open-items.md](decisions-and-open-items.md) (P1).

## 4. Identification frame — command `I`

The frame starts with `#` and uses **fixed widths**: manufacturer (15 characters) + separator + model (10) +
separator + version. The **content** of the manufacturer field varies between units of the same model (the
numeric suffix is apparently internal/batch), so the parser must use fixed positions, not text heuristics.

Two units of the same model, both real:

```
#TS -222  091225 Senoid  32 V01020805A<CR>      (old bench — under load)
#TS SHARA        SENO3.2kVA 26.000.000<CR>      (new bench — no load)
```

NUT segments this frame as follows:

| Slice | Unit 1 | Unit 2 | Interpretation |
|---|---|---|---|
| first 15 characters | `TS -222  091225` | `TS SHARA` | `device.mfr` |
| characters 16–25 | `Senoid  32` | `SENO3.2kVA` | `device.model` |
| last characters (after the 2nd separator) | `V01020805A` | `26.000.000` | `ups.firmware` |

## 5. Ratings frame — command `F`

```
#Univ. 100 24.00 60.0<CR>
```

| Field | Value | Interpretation |
|---|---|---|
| `Univ.` | — | Nominal voltage label (Universal/bivolt → not numeric) |
| `100` | 100.0 | `input.current.nominal` |
| `24.00` | 24.00 V | `battery.voltage.nominal` (2 × 12 V batteries in series) |
| `60.0` | 60.0 Hz | `input.frequency.nominal` |

## 6. Manufacturer notes (source: NUT DDL)

The model **"Universal UPS Senoidal 3200VA"** is in the NUT DDL. The datasheet records that, **when the voltage
selector (physical, under the device) is set to 220 V, the UPS keeps reporting the output at around 110–115 V** — a
behavior the manufacturer does not correct because the measuring point is before the switch in the circuit.
Therefore, **`output.voltage` ≈115 V is expected even in 220 V installations**.

## 7. Quick decoding (history of one sample)

```
Command  : Q1\r
Response : (228.0 228.0 115.0 093 60.0 19.8 26.0 10001101\r
Decoded:
  input         = 228.0 V
  input(fault)  = 228.0 V
  output        = 115.0 V
  load          = 93 %
  frequency     = 60.0 Hz
  battery       = 19.8 V
  temperature   = 26.0 °C
  status        = 10001101 -> b7=OB, b6=0, b5=0, b4=0, b3=standby, b2=TEST, b1=0, b0=BEEP
```
