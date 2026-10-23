# Tests and evidence

Chronological record of the experiments. Environment: Ubuntu 24.04.5 LTS (the reference host), SMS
**Power Sinus NG uPS3200S** UPS (3200 VA) via USB, cable connected only to Ubuntu, no manufacturer
app open (there is no app for this model on this bench).

> Difference from the TS Shara: there **is no** manufacturer application to compare against. The cross-validation
> was done against the **protocol specification** (`monofasico.xml`, which ships with SMS's PowerView) and
> against the **NUT `sms_ser` driver** — see [sms-1phase-protocol.md](sms-1phase-protocol.md) §10.

## T1 — System and USB inventory — 2026-10-22 10:33

- **Goal:** record the OS/kernel and identify the UPS in the USB tree.
- **Commands:** `lsb_release -ds`, `uname -a`, `date --iso-8601=seconds`, `lsusb`, `lsusb -t`, reading of
  `/sys/bus/usb/devices/1-1/*`.
- **Result:** UPS identified as **`067b:23d3 Prolific Technology USB-Serial Controller`**,
  kernel driver **`pl2303`**, port **`/dev/ttyUSB0`** (`root:dialout`, `188:0`). `bDeviceClass = 00`,
  one interface (`1-1:1.0`, class `ff` Vendor Specific, 3 endpoints). **It is not HID nor CDC-ACM.**
- **Conclusion:** `usbhid-ups` discarded; the transport is **serial** over a Prolific converter.
- **Full evidence:** [hardware-inventory.md](hardware-inventory.md).

## T2 — Probing the read commands (`Q`, `I`, `F`) — 2026-10-22 10:4x

- **Goal:** determine which commands the equipment recognizes and capture real responses.
- **Method:** send each command in the 7-byte protocol format
  (`<CMD> FF FF FF FF <checksum> 0D`) on the port `/dev/ttyUSB0` (2400 8N1) and read 18 bytes.
- **Result:** **three** commands responded, each with **18 bytes** terminated by `<CR>` (0x0D):

  | Key | Command sent (hex) | Real response captured |
  |---|---|---|
  | `Q` | `51 FF FF FF FF B3 0D` | `3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d` |
  | `I` | `49 FF FF FF FF BB 0D` | `3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d` |
  | `F` | `46 FF FF FF FF BE 0D` | `3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d` |

- **Command checksum** verified: `(4 − ord(CMD)) & 0xFF` → `Q`=0xB3, `I`=0xBB, `F`=0xBE.
- **Conclusion:** it is the **SMS Brazil 1Phase** protocol (binary), not Megatec/Q1 in text.

## T3 — Decoding of the `Q` frame and checksum validation — 2026-10-22 10:4x

- **Goal:** confirm the offsets, the scale and the response checksum.
- **Sample:** `3d 00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29 90 0d`.

  ```
  input (extended)    = 0x0000 / 10 =   0.0 V
  input               = 0x0881 / 10 = 217.7 V
  output              = 0x0881 / 10 = 217.7 V
  load                = 0x00c8 / 10 =  20.0 %
  output frequency    = 0x0257 / 10 =  59.9 Hz
  battery             = 0x03e8 / 10 = 100.0 %
  temperature         = 0x01eb / 10 =  49.1 C
  status              = 0x29 = 00101001 -> BEEP + UPSOK + BYPASS
  ```

- **Checksum:** sum of the first 16 bytes = `1136`; `(-1136) & 0xFF = 0x90` — **equal** to byte 16 ⇒
  intact frame.
- **Conclusion:** fields in **2 bytes, big-endian, in tenths**; checksum `(-sum(bytes[0..15])) & 0xFF`.

## T4 — Variability between samples (load and input) — 2026-10-22 10:4x

- **Goal:** confirm that the fields follow reality (they are not constants).
- **`Q` samples captured in sequence:**

  | Raw frame | Input | Output | Load | Freq | Battery | Temp |
  |---|---|---|---|---|---|---|
  | `…08 81 … 00 c8 02 57 …` | 217.7 V | 217.7 V | 20.0 % | 59.9 Hz | 100.0 % | 49.1 °C |
  | `…08 79 … 00 c8 02 58 …` | 216.9 V | 217.7 V | 20.0 % | 60.0 Hz | 100.0 % | 49.1 °C |
  | `…08 85 … 00 be 02 57 …` | 218.1 V | 217.7 V | 19.0 % | 59.9 Hz | 100.0 % | 49.1 °C |

- **Conclusion:** input and load vary according to the mains/consumption; output and temperature are stable on the
  bench. The live reading by the API (T6) showed input **218.1 V** and load **20.0 %**, consistent with the
  captures above.

## T5 — Reading by the repository collector — 2026-10-22

- **Goal:** validate `scripts/sms_collector.py` (the same parser used by the API).
- **Command:** `python3 scripts/sms_collector.py --identify`.
- **Result:** single reading OK — input **218.1 V**, output **217.7 V**, frequency **59.9 Hz**,
  load **20.0 %**, battery **100 % (24.0 V derived from 24 V nominal)**, temperature **49.1 °C**,
  status `BEEP + UPSOK + BYPASS`; identification `model = Power Sinus`, `firmware = 1.2`; ratings
  `220 V / 000 A / 24 V / 60 Hz`.
- **Conclusion:** the parser and the battery voltage derivation work with the real equipment.

## T6 — REST API against the real equipment — 2026-10-22 13:36

- **Goal:** validate the JSON contract end to end with the UPS connected and **publish the data**.
- **Commands:**
  - `python3 scripts/run_api.py --check` → valid telemetry (`exit 0`);
  - API on `127.0.0.1:8082` + `GET` on the five endpoints (via `curl`/`urllib`).
- **Results:**

  | Request | HTTP | Highlight |
  |---|---|---|
  | `GET /health` | **200** | `status=ok`, `serial_communication=ok`, `total_successes = total_attempts` (0 failures) |
  | `GET /api/v1` | **200** | index with the 5 endpoints, `read_only: true` |
  | `GET /api/v1/ups` | **200** | `device_id = sms-ups3200s-01`, `serial_port = /dev/ttyUSB0`, `communication_state = ok` |
  | `GET /api/v1/ups/sms-ups3200s-01/telemetry` | **200** | `telemetry_valid=true`, `data` filled in |
  | `GET /api/v1/ups/sms-ups3200s-01/identity` | **200** | `model = Power Sinus`, `firmware = 1.2`, ratings of the `F` command |
  | `GET /api/v1/ups/inexistente/telemetry` | **404** | `error.code = device_not_found` |
  | `POST /api/v1/ups` | **405** | `error.code = method_not_allowed` |

- **Published telemetry sample:** input **218.1 V**, output **217.7 V**, load **20.0 %**,
  frequency **59.9 Hz**, temperature **49.1 °C**, battery **100 %** (24.0 V derived, `packs = 2`),
  status `00101001` (`BEEP + UPSOK + BYPASS`), `raw_frame = 3d 00 00 08 81 … 29 90 0d`.
- **Conclusion:** contract, HTTP codes, collection every 5 s and **absence of fictitious values** validated on
  the bench. The data is published in the API as requested.

## T7 — Automated test suite — 2026-10-22

- **Goal:** validate the protocol, the collector and the HTTP layer **without hardware**, by dependency injection
  (fake serial link and controlled clock).
- **Command:** `python3 -m unittest discover -s tests -t . -v`.
- **Result:** **48 tests, all OK** (`test_protocol.py`, `test_collector.py`, `test_http_api.py`).
  The real frames from T2 are pinned in [`tests/support.py`](../tests/support.py). The HTTP layer is
  exercised with real requests on `127.0.0.1` (ephemeral port), covering `200/404/405/503`,
  `/health` `ok`/`degraded`/`down` and the requirement "an HTTP request does not trigger a serial reading".

## T8 — Port auto-detection by VID:PID (fix) — 2026-10-22

- **Symptom:** `python3 scripts/sms_collector.py --identify` returned
  `communication failure (port_unavailable): serial port of the UPS not found (VID:PID 067b:23d3)`,
  **despite** `/dev/ttyUSB0` existing.
- **Diagnosis:** the discovery routine did a glob in the **CDC-ACM** layout
  (`/sys/bus/usb/devices/<dev>/<dev>:*/tty/*`), but the **USB-Serial** layout has an intermediate level:
  `1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0`. Only the **parent device** (`1-1`) declares `idVendor`/`idProduct`
  (the interface does not).
- **Fix:** `detect_port` started iterating `/sys/class/tty/ttyUSB*` and `/sys/class/tty/ttyACM*` and
  **climbing the sysfs tree** up to finding `idVendor`/`idProduct` — it covers both layouts
  ([api/serial_link.py](../api/serial_link.py)).
- **Result after the fix:** `detect_port → /dev/ttyUSB0` and the reading started working (T5/T6).
- **Conclusion:** the discovery by VID:PID is portable to both transports; the old method only worked
  for CDC-ACM.

## T9 — Communication failures (without turning off the equipment) — 2026-10-22 13:36

- **Goal:** prove the failure handling **without generating fictitious values**.
- **"Port in use" scenario:** API up (exclusive lock) + `sms_collector.py`/`--check` in parallel →
  `state = port_unavailable`, message
  `Could not exclusively lock port /dev/ttyUSB0: [Errno 11] Resource temporarily unavailable`,
  `data = null`; the API **kept** publishing normally.
- **"Nonexistent port" scenario:** `--check --port /dev/ttyUSB9` → `state = port_unavailable`,
  `serial_port = /dev/ttyUSB9`, `data = null`.
- **"Invalid response" scenario:** frame that does not start with `<`/`=`/`>` →
  `state = invalid_response`, `consecutive_failures = 1`, `data = null` (the following cycles recover on their own).
- **Conclusion:** all failures are classified, recorded in `communication.last_error` and **do not**
  produce measurements. The last valid reading is preserved and becomes `stale` after `stale_after_s = 20 s`.

## T10 — Incident: battery test that did NOT stop (`T` without duration) — 2026-10-22 17:08 → 17:24 (-03:00)

- **Goal (original):** trigger, from the *frontend*/*unified API* (`upsmon`, `127.0.0.1:8080`), a
  **battery test of ~10 s** — the same behavior already obtained on the **TS Shara**.
- **Symptom:** the test **did not stop**. The equipment stayed indefinitely with the bits
  `TEST` + `OB` + `BOOST` + `BEEP` (+ `UPSOK`), running on battery, until it was cancelled manually.
- **Report that the API generated** (`GET /api/v1/ups/sms-ups3200s-01/tests`) — it looked **normal**:

  ```text
  test_id                 bbdb204d39c04d87
  type                     duration_10s
  status                   completed
  started_at_utc           2026-10-22T20:08:45.199Z
  ended_at_utc             2026-10-22T20:09:00.361Z
  duration_s               10.412
  finish_reason            duration_elapsed
  samples_count            12
  flags_seen               BEEP, BOOST, OB, TEST, UPSOK
  start_charge_percent     94.0
  drop_percent_in_window   15.0
  discharge_rate_pp/min    86.4
  estimated_runtime_min    1.1
  ```

  That is: the API **concluded the report** in ~10 s, but the **equipment kept testing** — the `D` cancel
  command was not sent at the end of the window.
- **Real frames captured (`Q` command):**

  | Moment | Raw frame | Byte 15 | Active bits | Battery |
  |---|---|---|---|---|
  | During the test (≈17:24) | `3d 00 00 08 b8 08 a3 00 c8 02 57 02 12 01 90 9d f5 0d` | `0x9d` | `BEEP TEST UPSOK BOOST OB` | `0x0212` = **53.0 %** |
  | Immediately after `D` | `3d 00 00 08 a3 08 a3 00 c8 02 57 00 b4 01 90 39 ce 0d` | `0x39` | `BEEP UPSOK BOOST BYPASS` | `0x00b4` = **18.0 %** |

  The first frame confirms the described state: `0x9d = 10011101` → `b0 BEEP`, `b2 TEST`, `b3 UPSOK`,
  `b4 BOOST`, `b7 OB`. The second shows `TEST` and `OB` **cleared** and the mains back (`BYPASS`/`BOOST` = charger
  operating). The battery went from **100 % → 94 % → 78 % → 70 % → 57 % → 53 %** during the incident and, right after the
  cancellation, the equipment reported **18 %**, rising to **20 %** — the percentage is derived from the voltage under
  load and only recovers with recharge time.
- **Diagnosis (confirmed by the NUT reference driver `sms_ser.c`):** in SMS Brazil 1Phase the `T` command
  is **parameterized** — `Param1` = **duration in seconds**. The command sent was `T` → `54 FF FF FF FF B0 0D`
  (parameters fixed at `0xFF`), and the firmware interprets `0xFF` as "**no duration defined**", running the
  test **until the battery drains** (equivalent to the `L` command). The **correct** command for 10 s would be
  `T` → `54 0A FF FF FF A5 0D`. Details in
  [sms-1phase-protocol.md](sms-1phase-protocol.md) §2.2.
- **Cancellation (executed at 17:24):** the `upsmon-api` service was stopped to release the port's exclusive lock
  and the script [`scripts/cancel_battery_test.py`](../scripts/cancel_battery_test.py) sent the command
  **`D`** (`44 FF FF FF FF C0 0D`), confirming the clearing of `TEST`/`OB`; the service was restarted right after.
- **Conclusion:** `T` **without** `Param1` **is not** a 10 s test. In addition, the collector needs to send `D`
  at the end of the window (and not only on the *abort* path). Fix recorded as **P9** in
  [decisions-and-open-items.md](decisions-and-open-items.md) — applied right after (see T11).

## T11 — 10 s test with the fix applied (P9) — 2026-10-22 17:31 (-03:00)

- **Goal:** validate the P9 fix live — the test must **stop on its own** in ~10 s.
- **Changes under test:**
  1. `drivers/sms_1phase.py`: `T` started carrying the duration in `Param1` (`54 0a ff ff ff a5 0d` for 10 s);
  2. `collector.py`: `D` started being sent on **every** closure in which the UPS may still be under
     test (`duration_elapsed`, `watchdog`, `aborted`, `stopping`).
- **Command:** `POST /api/v1/ups/sms-ups3200s-01/tests` with `{"type":"duration_10s"}` (`upsmon-api` service
  restarted to load the new code).
- **Result:**

  ```text
  POST -> running 5f9246295ee54766
  status: completed | finish_reason: duration_elapsed | duration: 10.409 s | samples: 12
  UPS status (right after):   BEEP UPSOK BOOST BYPASS      <- no TEST, no OB
  battery:  20.0 % -> 72.0 % -> 75.0 %   (recovering)
  ```

  Three consecutive readings after the window confirmed **`TEST` and `OB` absent** — the test **did not** come back.
- **Automated suite:** `python3 -m unittest discover -s tests -t .` → **90 tests OK** (includes the new
  `test_sms_teste_leva_a_duracao_em_param1` and the expectations of `["T", "D"]` at the window closure).
- **Conclusion:** the fix resolves incident T10 — the 10 s test **ends** and the UPS returns to the mains.
  The `D` at the end of the window still works as a **safety net**: even if the firmware does not honor
  `Param1`, the command does not stay active indefinitely.

## Evidence to archive

- Outputs of `lsusb`, `lsusb -t` and reading of `/sys/bus/usb/devices/1-1/*`.
- Binary frames captured from the `Q`, `I` and `F` commands (T2/T3/T4).
- JSON of the API contract (`/health`, `/api/v1/ups`, `/telemetry`, `/identity`).
- A log snippet of the service with the heartbeat and the failure deduplication.

> Sensitive data was omitted; the USB captures contain the converter's serial number (`BHBLn10CD20`) and
> must be reviewed before versioning.

## Traceability of the external evidence

| Statement | Where it is evidenced |
|---|---|
| Offset/scale of the `Q` frame fields | T3 + [sms-1phase-protocol.md](sms-1phase-protocol.md) §4 |
| Meaning of the status bits | [sms-1phase-protocol.md](sms-1phase-protocol.md) §4.3 (crossed with `sms_ser`) |
| Fixed widths of `I` and `F` | T2 + §5/§6 of the protocol document |
| Battery percentage comes from the equipment | T2/T3 (`battery = 100.0 %` in the `Q` frame) |
| Battery voltage derived | [sms-1phase-protocol.md](sms-1phase-protocol.md) §7 |
| `T` is parameterized (`Param1` = duration in seconds) | T10 + `sms_ser.c` + [sms-1phase-protocol.md](sms-1phase-protocol.md) §2.2 |
| `D` (cancel) clears `TEST`/`OB` on the real equipment | T10 (frames before/after) |
| NUT `sms_ser` exists and does not accept `baudrate` | [nut-installation-and-configuration.md](nut-installation-and-configuration.md) §2 |
