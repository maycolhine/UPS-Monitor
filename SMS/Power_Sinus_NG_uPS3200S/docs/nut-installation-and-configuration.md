# NUT installation and configuration (Stage 2)

> **The collection method used on this bench is the REST API** ([rest-api.md](rest-api.md)): it talks
> directly to `/dev/ttyUSB0`. NUT is the **supported alternative** — the `sms_ser` driver implements
> exactly the same protocol (SMS Brazil 1Phase) — and the configuration block below is ready in
> [`../config/examples/ups.conf`](../config/examples/ups.conf).
>
> **Status:** NUT was verified on this host for the **presence of the driver and the correct way to
> configure it**, but it was **not** validated end to end with the equipment (the live test
> `/lib/nut/sms_ser … -d 1` was not run). Treat this document as a **reference configuration**; the live
> validation recorded in [tests-and-evidence.md](tests-and-evidence.md) is the one for the REST API.

## 1. Installation

```bash
sudo apt update
sudo apt install -y nut nut-client nut-server usbutils python3-serial
```

Versions present on this host (`dpkg -l`):

| Package | Version |
|---|---|
| `nut` / `nut-client` / `nut-server` | `2.8.1-3.1ubuntu2` |
| `python3-serial` | `3.5-2` |
| `usbutils` | `1:017-3build1` |

The driver binary is at `/lib/nut/sms_ser` (there is also `/usr/lib/nut/sms_ser`):

```console
$ /lib/nut/sms_ser -V
Network UPS Tools - SMS Brazil UPS driver 1.00 (2.8.1)
```

## 2. `sms_ser` driver — characteristics

```console
$ /lib/nut/sms_ser -h
usage: sms_ser (-a <id>|-s <id>) [OPTIONS]
  -a <id>  - autoconfig using ups.conf section <id>
  -s <id>  - configure directly from cmd line arguments
  -d <n>   - dump data to stdout after 'n' updates loop and exit
```

| Item | Value |
|---|---|
| Name in `ups.conf` | `sms_ser` |
| Binary | `/lib/nut/sms_ser` |
| Description (`-V`) | `Network UPS Tools - SMS Brazil UPS driver 1.00 (2.8.1)` |
| Baud / format | **fixed at 2400 8N1** (set internally by the driver) |
| Configurable variables | only `rebootdelay` (output of `sms_ser -L`) |
| Commands used | `Q` (measurements/status), `I` (identification), `F` (ratings) |

### `baudrate` is **not** accepted

The driver **does not expose** the baud option — `sms_ser -L` lists **only** `rebootdelay`:

```console
$ /lib/nut/sms_ser -L
Network UPS Tools - SMS Brazil UPS driver 1.00 (2.8.1)
VALUE rebootdelay "Set reboot delay, in seconds (default=64)."
```

The speed `2400 8N1` is fixed internally. **Do not** include `baudrate` in the `ups.conf` block
(it would be an unknown option and would prevent the driver from starting).

## 3. Port access permission

The equipment is a Prolific **`067b:23d3`** USB-Serial converter (`pl2303` driver), which results in
`/dev/ttyUSB0` (`crw-rw---- root:dialout`). Two options:

```bash
# Option A (immediate, temporary until the cable is reconnected):
sudo chmod 666 /dev/ttyUSB0

# Option B (permanent): add the user to the dialout group and log in again:
sudo usermod -aG dialout "$USER"
```

Recommended udev rule (persistent, independent of the login group). The ready file is in
[`../config/examples/99-sms-ups.rules`](../config/examples/99-sms-ups.rules) — the same rule is
installed by `scripts/install_service.sh`:

```bash
sudo install -m 0644 ../config/examples/99-sms-ups.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Content (the third rule restarts the `sms-api` API when the cable is reconnected — see
[rest-api.md](rest-api.md) §3.3):

```udev
# 1) read/write permission for the dialout group
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="23d3", MODE="0660", GROUP="dialout"
# 2) prevent ModemManager from probing the port with AT commands
SUBSYSTEM=="usb", ATTR{idVendor}=="067b", ATTR{idProduct}=="23d3", ENV{ID_MM_DEVICE_IGNORE}="1"
# 3) restart the API when the cable is reconnected
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", ATTRS{idProduct}=="23d3", ACTION=="add", RUN+="/usr/bin/systemctl restart --no-block sms-api.service"
```

> The API's port auto-detection uses the same `067b:23d3` pair; the udev rule is what guarantees a
> **stable name** (`/dev/ttyUSB0`) and permission without depending on the logged-in user's group.

## 4. ModemManager (important)

`ModemManager` sees the serial port as a possible modem and tends to inject `AT` commands into
`/dev/ttyUSB0`, which **corrupts the communication** (the collector starts receiving bytes that are not a
protocol frame). The `ID_MM_DEVICE_IGNORE` rule above solves this permanently. Quick alternative
for tests:

```bash
sudo systemctl stop ModemManager
```

With the API's exclusive lock (`serial_exclusive = true`), a concurrent process on the port produces
`port_unavailable` instead of a corrupted reading.

## 5. Configuration (`/etc/nut/ups.conf`)

Ready example in [`../config/examples/ups.conf`](../config/examples/ups.conf). Block to insert:

```ini
[sms_ups3200s]
    driver = sms_ser
    port = /dev/ttyUSB0
    desc = "SMS Power Sinus NG uPS3200S - 3200VA"
```

> There is no need to provide `vendorid`/`productid`: since the transport is **serial** (USB-Serial), the
> driver uses the **port**, not the USB-HID mode.
>
> Note that there is **no** `protocol` nor `baudrate`: `sms_ser` implements a single protocol (SMS
> Brazil 1Phase) and already uses 2400 8N1 internally.

## 6. Manual test without privileges

The driver can be run directly, with the state folders in a writable location and the parameters
passed on the command line (`-s` = "configure directly from cmd line arguments"; `-d 1` runs one
cycle and exits). `NUT_STATEPATH=/tmp` avoids writing to `/var/run`:

```bash
export NUT_STATEPATH=/tmp
/lib/nut/sms_ser -s sms01 -x port=/dev/ttyUSB0 -d 1
```

Expected output: the header `Network UPS Tools - SMS Brazil UPS driver 1.00 (2.8.1)` and, after the
first cycle, the dump of the variables (see summary in
[variables-and-mapping.md](variables-and-mapping.md)).

> **Port conflict:** if the **REST API is up**, the port will have an exclusive lock and this
> test will fail with `Unable to open ...`. Stop the API first (`systemctl stop sms-api`) **or** use the
> API itself — both solutions read the same protocol.

## 7. Service activation

```bash
# /etc/nut/nut.conf -> MODE=standalone (or netserver)
sudo systemctl restart nut-driver-enumerator.service
sudo systemctl enable --now nut-server nut-monitor
systemctl --type=service | grep -i nut
upsc sms_ups3200s@localhost
```

## 8. `nut-scanner`

`nut-scanner -U` (USB scan) is **not available** in this installation (missing `libusb-1.0.so`).
Since the equipment is **serial**, this **does not prevent** the collection — just point the port in `ups.conf`,
as above.

## 9. Relationship with the REST API

NUT and the REST API read **the same protocol** on **the same port** and **must not** run at the same time:

| | NUT (`sms_ser`) | REST API (used in production) |
|---|---|---|
| Port | `/dev/ttyUSB0` | `/dev/ttyUSB0` |
| Commands | `Q`/`I`/`F` (via driver) | `Q`/`I`/`F` (own implementation) |
| Battery fields | equipment percentage; derived voltage | same (see [sms-1phase-protocol.md](sms-1phase-protocol.md) §7) |
| Exposure | NUT protocol (TCP 3493) | HTTP/JSON (`/api/v1`) |

The API is the recommended path here because the JSON contract already comes out in a consumable format
([zabbix-integration.md](zabbix-integration.md)) and because it **does not stop** when the cable is removed.
