# Spec — Data specification of the TS Shara UPS (USB → Zabbix)

**Device:** TS Shara UPS Senoidal 3200 UNIV. 2BS USB (label: 3200 VA, code `4450`)
**Model (firmware identification):** `SENO3.2kVA`
**Interface:** USB CDC-ACM (Virtual COM Port) → `/dev/ttyACM0` — **not USB-HID**
**Protocol:** Megatec/Q1 (Voltronic family), **poll-based**
**Reference driver:** NUT 2.8.1 `nutdrv_qx` (autodetects "Megatec 0.07")
**Last update:** 2026-10-20

> This document **consolidates** the other documents of the model. It is the single reference specification for
> converting the frames received over USB into monitoring metrics.
> Sources: [README](README.md), [hardware-inventory](docs/hardware-inventory.md),
> [megatec-ts-shara-protocol](docs/megatec-ts-shara-protocol.md),
> [nut-installation-and-configuration](docs/nut-installation-and-configuration.md),
> [variables-and-tsapp-comparison](docs/variables-and-tsapp-comparison.md),
> [tests-and-evidence](docs/tests-and-evidence.md), [decisions-and-open-items](docs/decisions-and-open-items.md).

> **Note on "decrypting":** the protocol **is not encrypted**. The data arrives as **ASCII text**; the
> work is to **decode** (parse) each field and the **status bits**. That is what this document describes.

---

## 1. Scope

Define, field by field, **everything the device sends over USB**, to allow:

1. Collecting locally on Ubuntu (via `nutdrv_qx` or a custom collector);
2. Converting to metrics readable by monitoring (Zabbix);
3. Comparing with what the **TS App** (Windows) presents.

---

## 2. Physical and link layer

| Parameter | Value | Note |
|---|---|---|
| Transport | USB CDC-ACM (Abstract Control Model) | `/dev/ttyACM0` |
| **VID:PID** | **`0483:5740`** | STMicroelectronics STM32 Virtual ComPort |
| `bDeviceClass` | `02` (Communications) | **no** HID interface → `usbhid-ups` does **not** apply |
| Interfaces | `1-1:1.0` (CDC ACM/AT) + `1-1:1.1` (CDC Data, bulk) | driver `cdc_acm` |
| Nominal baud | `2400` (Megatec) | the CDC port **ignores** the baud; tested OK at 2400–115200 |
| Format | 8N1 | 8 data bits, no parity, 1 stop bit |
| Encoding | ASCII | printable terms and digits |
| Command terminator | `<CR>` = `\r` = `0x0D` | sent **by** the host |
| Response terminator | `<CR>` = `\r` = `0x0D` | sent **by** the UPS |
| Communication model | **Poll-based** | the UPS **does not** transmit on its own (passive read = 0 bytes) |
| Linux permission | `root:dialout` | use the `dialout` group or a udev rule |

**Recommended udev rule** (permission + blocking `ModemManager`, which injects `AT` commands):

```bash
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", MODE="0660", GROUP="dialout"
SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="5740", ENV{ID_MM_DEVICE_IGNORE}="1"
```

---

## 3. Protocol: supported commands

Full scan (`A–Z`, `a–z`, `0–9` + `<CR>`): **only 3 commands respond**.

| Send | Response (real example) | Function |
|---|---|---|
| `Q1\r` | `(002.0 002.0 115.0 009 60.0 23.8 26.0 10001001\r` | **Status + measurements** (the main frame) |
| `I\r`  | `#TS SHARA        SENO3.2kVA 26.000.000\r` | **Identification** (manufacturer/model/version) |
| `F\r`  | `#115.0 100 24.00 60.0\r` | **Nominal ratings** |

**No data response** (return empty): `Q`, `D`, `M`, `V`, `N`, `C` and other letters/digits.
**Caution:** `T`, `TL` and `S` also return empty, **but they are not "unsupported"** — they are **action commands**
(battery test and shutdown) that the UPS **executes without responding**. See §3.1.

> **SAFETY ALERT:** `T` = battery test (~10 s); `TL` = test **until the battery drops**; `S` = shutdown.
> Issuing these commands **discharges the battery** and can **shut down the load**. Use **only** `Q1`, `I`, `F` for reading.

### 3.1 Battery test commands — `T` (10 s) and `TL` (until low battery)

These commands **exist** in the Megatec protocol and **were triggered by mistake** during testing (see §8), which
discharged the battery and shut down the load of unit 1. They are documented here to **recognize** and **avoid** their use.

#### 3.1.1 How they are sent

Same as the other commands: **ASCII text** + terminator `<CR>` (0x0D), on the same serial port (`/dev/ttyACM0`).

| Command | Bytes sent | What the UPS does |
|---|---|---|
| `T` | `54 0D` (`T\r`) | Starts a **~10-second battery test**: the output is fed by the battery for ~10 s and then returns to the mains (if present). |
| `TL` | `54 4C 0D` (`TL\r`) | Starts a **test until the battery reaches the low level**: the unit stays **on battery** for as long as the test lasts; upon detecting a low battery (`LB`), it ends and returns to the mains. |
| `S` | `53 0D` (`S\r`) | Shutdown (not a test; listed because it is equally "silent"). |

They are **fire-and-forget** commands: the host **sends and does not wait for a response frame**.

#### 3.1.2 What they return

**Nothing.** The response is **empty** (0 bytes) in both cases — the UPS **does not** send `(`, nor an echo, nor a confirmation.
That is precisely why, in the command scan (T4), `T`/`TL` were classified as "no response" and the
**side effect went unnoticed** at the moment they were sent.

> **Practical consequence:** an empty return **does not** mean "command ignored". The command was **accepted and executed**.

#### 3.1.3 How to observe the effect (you must query `Q1`)

The test in progress and its consequences are visible **in the `Q1` frame**, in the status bits and in the voltage:

| Indicator in `Q1` | During `T`/`TL` | Interpretation |
|---|---|---|
| b2 (`TEST`) | goes to `1` | **test in progress** |
| b7 (`OB`) | goes to `1` | output on battery (even with mains present) |
| `battery.voltage` (`SS.S`) | **drops** during the test | battery consumption |
| b6 (`LB`) | goes to `1` at the end of `TL` | **low battery** — end of the test |

In other words: **there is no response to the command**, but the result is **observable** by polling `Q1`.

#### 3.1.4 Bench evidence (unit 1 — under load)

After sending `T`/`TL`, monitoring via `Q1` recorded:

```
command sent    : T / TL           (response: empty)
Q1 during test  : (228.0 228.0 115.0 093 60.0 19.8 26.0 10001101
                                                        ^ b2 = TEST = 1
battery voltage : 22.8 V  ->  19.8 V  ->  15.2 V
result          : battery depleted -> shutdown of the load (servers)
```

The sample above (bits `10001101`) has **b2 = 1**, confirming the test in progress, and the voltage dropped from **22.8 V**
to **15.2 V** — below the deep-discharge limit of the 24 V pack.

#### 3.1.5 Usage rules

1. **Never** send `T`, `TL` or `S` on a unit with a **critical load** (servers, storage, etc.).
2. For **reading/monitoring**, use **only** `Q1`, `I` and `F`.
3. If a test is really necessary, schedule it with the **load off** and monitor `battery.voltage` + b6 (`LB`).
4. The collector (`scripts/ts_shara_collector.py`) **does not implement** these commands — by decision **D9**
   (see [decisions-and-open-items.md](docs/decisions-and-open-items.md)).

---

## 4. Main frame — command `Q1` (status + measurements)

### 4.1 Format

```
(MMM.M NNN.N PPP.P QQQ RR.R SS.S TT.T b7b6b5b4b3b2b1b0<CR>
```

The frame starts with `(` (0x28) and ends with `<CR>`; each field is separated by **a single space**.

### 4.2 Field by field

| # | Field | Example | Unit | Description | NUT variable |
|---|---|---|---|---|---|
| 0 | `(` | `(` | — | **Start** byte of the frame | — |
| 1 | `MMM.M` | `002.0` | V | **Input** voltage (mains) | `input.voltage` |
| 2 | `NNN.N` | `002.0` | V | Input **fault** voltage (glitch/mains absent held until the reading) | `input.voltage.fault` |
| 3 | `PPP.P` | `115.0` | V | **Output** voltage | `output.voltage` |
| 4 | `QQQ` | `009` | % | **Load** = output current as % of nominal | `ups.load` |
| 5 | `RR.R` | `60.0` | Hz | Input **frequency** | `input.frequency` |
| 6 | `SS.S`/`S.SS` | `23.8` | V | **Battery voltage** (standby → `SS.S`; online → `S.SS`) | `battery.voltage` |
| 7 | `TT.T` | `26.0` | °C | **Temperature** | `ups.temperature` |
| 8 | `b7..b0` | `10001001` | — | **8 status bits** (see §4.3) | `ups.status` |

> **Output voltage scale:** the NUT DDL records that, even with the physical selector at **220 V**, the device
> reports the output at **~110–115 V** (the measuring point is **before** the switch in the circuit). Therefore
> `output.voltage ≈ 115 V` is **expected**, not a defect.

### 4.3 Status bits (`b7`…`b0`)

Each bit is the ASCII character `'0'` or `'1'`. Order: **`b7` is the first character**, `b0` is the last.

| Bit | Character in the frame | Name | `1` means | Collector tag |
|---|---|---|---|---|
| b7 | 1st | Utility Fail | **Mains absent** → running on battery | `OB` |
| b6 | 2nd | Battery Low | **Low battery** | `LB` |
| b5 | 3rd | Bypass/Boost | Boost/Buck or Bypass active | `BOOST` |
| b4 | 4th | UPS Failed | **UPS fault** | `FAULT` |
| b3 | 5th | UPS Type | `1` = **standby/line-interactive**; `0` = online | `STANDBY` |
| b2 | 6th | Test in Progress | Battery test in progress | `TEST` |
| b1 | 7th | Shutdown Active | Shutdown active | `FSD` |
| b0 | 8th | Beeper On | Beeper on | `BEEP` |

### 4.4 Decoded example: `10001001`

```
frame   : (002.0 002.0 115.0 009 60.0 23.8 26.0 10001001
position:  b7 b6 b5 b4 b3 b2 b1 b0
value   :   1  0  0  0  1  0  0  1
```

| Bit | Value | Derived state |
|---|---|---|
| b7 | `1` | **Mains absent / on battery (`OB`)** |
| b6 | `0` | Battery not low |
| b5 | `0` | No boost/buck/bypass |
| b4 | `0` | No fault |
| b3 | `1` | **Standby / line-interactive** |
| b2 | `0` | No test in progress |
| b1 | `0` | No shutdown |
| b0 | `1` | **Beeper on** |

→ `ups.status` = **`OB` + `STANDBY` + `BEEP`** (consistent with input ≈ 2 V, i.e. no mains).

---

## 5. Identification frame — command `I`

**Fixed-width** format: `#` + **manufacturer (15)** + separator + **model (10)** + separator + **version**.

Two real units of the **same model** (the manufacturer field **varies** between units — use fixed positions):

```
#TS -222  091225 Senoid  32 V01020805A      (unit 1 — under load)
#TS SHARA        SENO3.2kVA 26.000.000      (unit 2 — no load)
```

| Slice | Unit 1 | Unit 2 | NUT variable |
|---|---|---|---|
| chars 1–15 | `TS -222  091225` | `TS SHARA` | `device.mfr` |
| chars 16–25 | `Senoid  32` | `SENO3.2kVA` | `device.model` |
| remainder (after the 2nd separator) | `V01020805A` | `26.000.000` | `ups.firmware` |

---

## 6. Ratings frame — command `F`

```
#115.0 100 24.00 60.0<CR>
```

| Field | Example | Unit | Description | NUT variable |
|---|---|---|---|---|
| nominal voltage | `115.0` | V | Nominal voltage (may come as `Univ.` on other units) | — |
| nominal current | `100` | A | Nominal input current | `input.current.nominal` |
| battery voltage | `24.00` | V | Nominal battery (2× 12 V in series) | `battery.voltage.nominal` |
| nominal frequency | `60.0` | Hz | Nominal frequency | `input.frequency.nominal` |

---

## 7. Full mapping → NUT → Zabbix

| Source (frame) | NUT variable | Zabbix metric (suggestion) | Type | Suggested trigger |
|---|---|---|---|---|
| `Q1` b7..b0 | `ups.status` | `ups.status` | text | contains `OB` → mains loss; contains `LB` → critical |
| `Q1` `MMM.M` | `input.voltage` | `input.voltage` | numeric | `< 100 V` for 30 s → mains absent |
| `Q1` `NNN.N` | `input.voltage.fault` | `input.voltage.fault` | numeric | glitch record |
| `Q1` `PPP.P` | `output.voltage` | `output.voltage` | numeric | outside ~110–115 V → warning |
| `Q1` `QQQ` | `ups.load` | `ups.load` | numeric | `> 90 %` for 5 min → overload |
| `Q1` `RR.R` | `input.frequency` | `input.frequency` | numeric | outside 57–63 Hz → warning |
| `Q1` `SS.S` | `battery.voltage` | `battery.voltage` | numeric | `< 21 V` → weak battery |
| `Q1` `TT.T` | `ups.temperature` | `ups.temperature` | numeric | `> 45 °C` → warning |
| (derived) | `battery.charge` | `battery.charge` | numeric | `< 30 %` → warning (**estimated** — see §7.3) |
| (derived) | `battery.runtime` | `battery.runtime` | numeric | requires `runtimecal` |
| `I` | `device.mfr`/`device.model`/`ups.firmware` | inventory | text | — |
| `F` | `*nominal` | ratings | numeric | reference |

### 7.1 Battery percentage is **estimated**

The protocol **does not transmit** the battery percentage. NUT **computes** `battery.charge` from the voltage,
using default limits (`battery.voltage.low = 20.80 V`, `battery.voltage.high = 26.00 V`) — "guesstimated"
values. Treat `battery.charge` as an **estimate** in Zabbix.
**§7.3** determines the limits **calibrated against the TS App** (`20.1 V` / `26.8 V`) and the collector already applies them.

### 7.2 Runtime (`battery.runtime`)

It is only calculated if `runtimecal` is provided in `ups.conf` (e.g. `runtimecal = 180,100,600,50`). Without it, the driver
logs: `Battery runtime will not be calculated (runtimecal not set)`.

### 7.3 Study — how to estimate the battery percentage

**Starting point:** the Megatec/Q1 protocol **does not transmit** the percentage. Every percentage displayed (NUT, TS App,
Zabbix) is **derived from the voltage** `battery.voltage`. Therefore, the "correct" value depends on the **voltage → % conversion
model**.

#### 7.3.1 Formula used by NUT (linear interpolation) — validated

```
battery.charge [%] = clamp( 100 × (V − Vlow) / (Vhigh − Vlow), 0, 100 )

Vlow  = battery.voltage.low  = 20.80 V   ("guesstimate" default)
Vhigh = battery.voltage.high = 26.00 V
```

Validation on a real `nutdrv_qx` dump (`battery.voltage = 22.0` → `battery.charge = 23`):

```
100 × (22.0 − 20.80) / (26.00 − 20.80) = 23.08 → 23 ✔
```

#### 7.3.2 Comparison with the TS App (two simultaneous readings — 2026-10-20)

| # | Time | `battery.voltage` (Ubuntu) | TS App % | NUT % (`[20.80; 26.00]`) | Δ (pp) |
|---|---|---|---|---|---|
| 1 | 15:52 | **23.8 V** | **55 %** | 58 % | +3 |
| 2 | 16:33 | **20.8 V** | **10 %** | **0 %** | −10 |

→ In the mid range the difference is small (~3 pp), but at the **lower extreme** NUT **goes to zero** while the TS App still
shows **10 %**. The TS App **does not use** the NUT limits: it uses its own calibration, with a **wider** useful range.

#### 7.3.3 Lead-acid hypothesis `[21.6; 25.6]` — refuted

With a **single point** (23.8 V ↔ 55 %), the simplest hypothesis was **linear interpolation with the usual lead-acid
limits (10.8 V and 12.8 V per 12 V battery)** → **21.6 V / 25.6 V** on the 24 V pack:

```
point 1:  100 × (23.8 − 21.6) / (25.6 − 21.6) = 55.0 %  ✔
point 2:  100 × (20.8 − 21.6) / (25.6 − 21.6) = −20 → 0 %  ✘  (TS App = 10 %)
```

The **second point refutes it**: in that range, the TS App should show **0 %** at 20.8 V, but shows **10 %**. So the TS App
limits are **wider** than `[21.6; 25.6]`.

#### 7.3.4 Adopted model — two-point linear fit

With **two simultaneous points** (`23.8 V ↔ 55 %` and `20.8 V ↔ 10 %`) the line becomes **determined**: two points, two
unknowns (`Vlow` and `Vhigh`).

```
slope = (55 − 10) / (23.8 − 20.8) = 45 / 3.0 = 15.0 %/V

Vlow  (0 %)   = 20.8 − 10 / 15.0 = 20.13 V
Vhigh (100 %) = 20.8 + 90 / 15.0 = 26.80 V

% = clamp( 100 × (V − 20.13) / (26.80 − 20.13), 0, 100 )
```

Check (by construction, reproduces the two TS App readings):

```
23.8 V → 100 × 3.67 / 6.67 = 55.0 %  ✔
20.8 V → 100 × 0.67 / 6.67 = 10.0 %  ✔
```

**Rounded values adopted:** **`Vlow = 20.1 V`** and **`Vhigh = 26.8 V`**.

Comparison of the three curves:

| `battery.voltage` | NUT `[20.8; 26.0]` | hypothesis `[21.6; 25.6]` | **adopted `[20.1; 26.8]`** |
|---|---|---|---|
| 20.8 V | 0 % | 0 % | **10 %** |
| 21.6 V | 15 % | 0 % | **22 %** |
| 23.2 V | 46 % | 40 % | **46 %** |
| 23.8 V | 58 % | 55 % | **55 %** |
| 24.4 V | 69 % | 70 % | **64 %** |
| 25.6 V | 92 % | 100 % | **82 %** |
| 26.8 V | 100 % | 100 % | **100 %** |

In the **operating range** (24–25 V) the three curves practically coincide; the divergence appears at the **extremes**,
precisely where the low-battery alert matters.

**Where it is implemented:** `scripts/ts_shara_collector.py` — field `battery_charge_percent` (text and JSON output),
with limits configurable via `--battery-low` / `--battery-high` (default `20.1` / `26.8`):

```bash
python3 scripts/ts_shara_collector.py --json
python3 scripts/ts_shara_collector.py --battery-low 20.4 --battery-high 26.5   # recalibrate without editing the code
```

> It is recommended to keep `battery.voltage` (raw) as the primary metric and derive the `%` via a calculated item — that way the
> calibration can evolve without changing the collection.

#### 7.3.5 Calibration procedure (recommended before "closing" the number)

1. UPS in **controlled discharge** (no mains, **no critical load** and **never** with `T`/`TL`).
2. Every ~2 min, record **simultaneously**: `battery.voltage` (Ubuntu) and % (TS App).
3. Adjust (a) the **linear limits** or (b) a **V→% lookup table** — the latter is more accurate, since the
   lead-acid curve **is not linear** (it is "flat" between ~30 % and ~80 %).
4. Repeat over **two sessions** to separate the effect of **load/temperature**.

Record of the calibration samples:

| Date/time | `battery.voltage` (Ubuntu) | TS App % | NUT % `[20.8;26.0]` | adopted % `[20.1;26.8]` | Δ vs TS App (pp) |
|---|---|---|---|---|---|
| 2026-10-20 15:52 | 23.8 V | 55 % | 58 % | 55 % | 0 |
| 2026-10-20 16:33 | 20.8 V | 10 % | 0 % | 10 % | 0 |
| _to fill_ | | | | | |

> The two rows above are the points that **determine** the model (§7.3.4); therefore Δ is zero **by construction**.
> What validates the model are **new** samples (the `_to fill_` row), which should fall near the line.

#### 7.3.6 Caveats

- The voltage **under load** is lower than at **rest** → the % measured "in use" is distorted according to the load.
- **Temperature** shifts the voltage (thermal compensation).
- In **float/charge**, the voltage rises to ~27 V → the % tends to 100 % even with a partial load.
- For critical decisions, combine the % with the `LB` bit (b6) and with `battery.runtime` (via `runtimecal`).
- The calibration was done **under discharge** (unit without mains, ~11 % load). The same model applied **in float**
  tends to **overestimate** the %, because the charge voltage is higher than the rest voltage.
- **Accuracy of point 2:** the TS App reading (10 %) and the collector reading (20.8 V) were not taken strictly at the same
  moment. The battery was dropping (~0.2 V every few minutes). If the TS App was read **a few minutes earlier**, the
  voltage at that moment was ~21.0–21.3 V and the limits would be ≈ `[20.4; 26.5]`. At ~24 V (typical range) the effect
  is only **~1–2 percentage points**; at the extremes it is larger.
- **Real curve:** two points only define a **line**. The lead-acid curve is **non-linear** ("flat" between ~30 % and
  ~80 %). With new samples, migrate to a **V→% table** (§7.3.5, step 3).

#### 7.3.7 Equivalent adjustment in NUT (optional)

For **`nutdrv_qx` itself** to report `battery.charge` close to the TS App, use in `ups.conf`:

```ini
default.battery.voltage.low  = 20.1
default.battery.voltage.high = 26.8
```

Recommended alternative: keep NUT at the default and compute the calibrated `%` **in the collector/Zabbix** (§7.3.4), since it
allows recalibrating **without** reconfiguring the driver.

---

## 8. Real samples (record)

| Date/time | Unit | `Q1` (raw frame) | State |
|---|---|---|---|
| 2026-10-20 12:20 | no. 1 (under load) | `(228.0 228.0 115.0 093 60.0 19.8 26.0 10001101` | `OB`+`STANDBY`+`TEST`+`BEEP` |
| 2026-10-20 15:52 | no. 2 (no load) | `(002.0 002.0 115.0 009 60.0 23.8 26.0 10001001` | `OB`+`STANDBY`+`BEEP` |
| 2026-10-20 16:33 | no. 2 (no load) | `(001.0 001.0 116.0 011 60.0 20.8 26.0 10001001` | `OB`+`STANDBY`+`BEEP` |

- **Unit 1:** the battery voltage dropped from ~22.6 V → 15.2 V because of a **battery test** triggered by mistake
  (`T`/`TL`) combined with the load.
- **Unit 2:** battery **stable** (~23.8–24.0 V); `input.voltage ≈ 1–2 V` indicates a **unit without mains** (which
  explains `OB`). See [decisions-and-open-items.md](docs/decisions-and-open-items.md) (P1/P2) and
  [tests-and-evidence.md](docs/tests-and-evidence.md) (T9).

### 8.1 Cross-check with the TS App (2026-10-20)

All quantities visible in the TS App were confirmed **equal** to those obtained over USB:

| Quantity | Ubuntu (USB) | TS App | Status |
|---|---|---|---|
| Input voltage | 1–2 V | 1–2 V | ✔ |
| Output voltage | 115 V | 115 V | ✔ |
| Frequency | 60 Hz | 60 Hz | ✔ |
| Temperature | 26 °C | 26 °C | ✔ |
| State (`OB`) | Mains absent / on battery | idem | ✔ |
| Manufacturer / model / version | TS SHARA / SENO3.2kVA / 26.000.000 | — | USB-only |
| Battery percentage | **55 %** (calibrated — §7.3.4) | **55 %** | ✔ (default NUT would give 58 %) |

Quantities available **only** via USB (they do not exist in the TS App): `input.voltage.fault`, `ups.load`,
`battery.voltage` (raw), identification (`device.mfr`/`device.model`/`ups.firmware`) and the ratings of the `F` command.

**Stage conclusion:** the collection tests are **correct**. The battery percentage was the only divergent
quantity; with the **two simultaneous readings** (23.8 V ↔ 55 % and 20.8 V ↔ 10 %) the deviation was resolved by the
**calibrated linear model** `[20.1; 26.8]` (§7.3.4), already **implemented in the collector**.

---

## 9. Conversion rules (summary for the collector/Zabbix)

1. Send `Q1\r`, `I\r`, `F\r` (read-only) and read up to `<CR>`. **Never** send `T`, `TL` or `S` (§3.1).
2. Derive the 8 status bits; convert to tags (`OB`, `LB`, `STANDBY`, …).
3. Publish numeric metrics in SI per §4.2 (V, %, Hz, °C).
4. Mark `battery.charge`/`battery.runtime` as **derived**; for the `%`, use the calibrated limits `[20.1; 26.8]`
   (§7.3.4).
5. Availability items: `nodata()` on the master item → **communication** failure (distinct from UPS failure).

---

## 10. Known limitations

| Limitation | Impact | Handling |
|---|---|---|
| No battery percentage in the protocol | `battery.charge` is estimated | label it as an estimate |
| No energy (kWh) | no accumulated consumption | out of scope |
| `output.voltage ≈ 115 V` in 220 V installations | may look like an error | documented by the manufacturer (measuring point) |
| Only 3 **read** commands (`Q1`, `I`, `F`) | few extra data | firmware limitation |
| `T`/`TL`/`S` test/shut down the battery **without** responding | risk of shutting down the load | **do not** use for reading — see §3.1 |
| `ModemManager` on the port | corrupts communication | udev rule `ID_MM_DEVICE_IGNORE` |
| Discharged battery → permanent `OB` | "false" alarm | confirm physical mains; see P1 |

---

## 11. References

- Megatec Protocol information (Kevin Chiou, v2.7, 1996) — specification of the `Q1` frame.
- NUT 2.8.1 — `nutdrv_qx` driver, "Megatec 0.07" protocol.
- NUT DDL — [Universal UPS Senoidal 3200VA](https://networkupstools.org/ddl/TS_Shara/Universal_UPS_Senoidal_3200VA.html).
