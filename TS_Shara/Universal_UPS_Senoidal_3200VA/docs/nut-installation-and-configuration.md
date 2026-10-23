# NUT installation and configuration (Stage 2)

## 1. Installation

```bash
sudo apt update
sudo apt install -y nut nut-client nut-server usbutils python3-serial
```

Installed and validated version: **Network UPS Tools 2.8.1**.

## 2. Port access permission

`/dev/ttyACM0` belongs to `root:dialout`. Two options:

```bash
# Option A (immediate, temporary until the cable is reconnected):
sudo chmod 666 /dev/ttyACM0

# Option B (permanent): add the user to the dialout group and log in again:
sudo usermod -aG dialout "$USER"
```

Recommended udev rule (persistent and without depending on the login group). The ready file is at
[`../config/examples/99-ts-shara-ups.rules`](../config/examples/99-ts-shara-ups.rules) — the same rule is
installed by `scripts/install_service.sh`:

```bash
sudo install -m 0644 ../config/examples/99-ts-shara-ups.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Content (it also restarts the `ts-shara-api` API when the cable is reconnected — see
[rest-api.md](rest-api.md) §3.4):

```udev
# 1) read/write permission for the dialout group
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", MODE="0660", GROUP="dialout"
# 2) prevent ModemManager from probing the port with AT commands
SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="5740", ENV{ID_MM_DEVICE_IGNORE}="1"
# 3) restart the API when the cable is reconnected
SUBSYSTEM=="tty", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", ACTION=="add", RUN+="/usr/bin/systemctl restart --no-block ts-shara-api.service"
```

## 3. ModemManager (important)

The `ModemManager` service sees the CDC-ACM port as a possible modem and tends to inject `AT` commands into
`/dev/ttyACM0`, which can **corrupt the communication**. The `ID_MM_DEVICE_IGNORE` rule above solves this
permanently. Quick alternative for testing:

```bash
sudo systemctl stop ModemManager
```

## 4. Configuration (`/etc/nut/ups.conf`)

Ready example at [`../config/examples/ups.conf`](../config/examples/ups.conf). Block to insert:

```ini
[ts_shara]
    driver = nutdrv_qx
    port = /dev/ttyACM0
    protocol = megatec
    desc = "TS Shara UPS Senoidal 3200 UNIV. 2BS USB"
```

> It was not necessary to specify `vendorid`/`productid`: since the transport is **serial** (CDC-ACM), the driver
> uses the port, not the USB-HID mode.

### Estimated runtime (optional)

The driver only computes `battery.runtime` if it receives `runtimecal`. Example (adjust to the device's real
values):

```ini
    runtimecal = 180,100,600,50
```

Without this parameter, the driver logs: `Battery runtime will not be calculated (runtimecal not set)`.

## 5. Service activation

```bash
# standalone/server mode in /etc/nut/nut.conf -> MODE=standalone (or netserver)
sudo systemctl restart nut-driver-enumerator.service
sudo systemctl enable --now nut-server nut-monitor
systemctl --type=service | grep -i nut
upsc ts_shara@localhost
```

## 6. Test without privileges (method used during discovery)

Since the analysis environment did not allow `sudo`, validation was done by running the driver directly,
pointing the configuration/state folders to writable locations:

```bash
CONF="$(pwd)/TS_Shara/Universal_UPS_Senoidal_3200VA/config/examples"
mkdir -p /tmp/nutstate
NUT_CONFPATH="$CONF" NUT_STATEPATH=/tmp/nutstate NUT_ALTPIDPATH=/tmp/nutstate \
  /lib/nut/nutdrv_qx -a ts_shara -u "$USER" -DDD
```

Result observed in the driver logs:

```
[D3] send: 'Q1'
[D3] read: '(228.0 228.0 115.0 088 60.0 22.0 26.0 10001101'
[D3] send: 'I'
[D3] read: '#TS -222  091225 Senoid  32 V01020805A'
Using protocol: Megatec 0.07
Autodetected 1 as number of battery packs [24/22.00]
Driver initialization completed, beginning regular infinite loop
```

This proves that **`nutdrv_qx` recognizes and operates the device**.

## 7. `nut-scanner`

`nut-scanner -U` (USB scan) is **not available** in this installation: the binary reports
`Cannot load USB library (libusb-1.0.so)`. Since the device is serial, this does **not prevent** collection — the
configuration is done by pointing to the port in `ups.conf`, as above.
