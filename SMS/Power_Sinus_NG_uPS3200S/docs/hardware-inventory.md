# Hardware and system inventory (Stage 1)

All evidence was collected on **2026-10-22**, on the reference host, with the USB cable of the SMS UPS
connected directly to Ubuntu (no manufacturer app open).

## 1. Operating system

| Item | Value |
|---|---|
| Distribution | Ubuntu 24.04.5 LTS (Noble Numbat) |
| Kernel | `Linux <hostname> 7.0.0-38-generic #38~24.04.4-Ubuntu SMP PREEMPT_DYNAMIC ... x86_64` |
| Test date/time | `2026-10-22T10:33:35-03:00` |
| Python | 3.12.3 |
| `pyserial` | 3.5 (the only external dependency of the API) |

Evidence: `lsb_release -ds`, `uname -a`, `date --iso-8601=seconds`.

## 2. UPS USB device

Identified by `lsusb`, `lsusb -t` and the attributes in `/sys/bus/usb/devices/1-1/`.

| Field | Value |
|---|---|
| Bus/address | `Bus 001 Device 011` (changes after reconnection — do not use as an ID) |
| sysfs path | `/sys/bus/usb/devices/1-1` |
| **VID:PID** | **`067b:23d3`** |
| Manufacturer | `Prolific Technology Inc.` |
| Product | `USB-Serial Controller` |
| Chip serial string | `BHBLn10CD20` |
| `bDeviceClass` | `00` (defined on the interface, not on the device) |
| `bcdDevice` | `0405` |
| Interfaces | `bNumInterfaces = 1` |
| Power | `bMaxPower = 100mA` |
| Speed | `12 Mbps` (USB Full-Speed) |
| USB version | `2.00` |
| Kernel driver | `pl2303` (over `usbserial`) |
| Resulting Linux port | **`/dev/ttyUSB0`** (`crw-rw---- root:dialout`, major:minor `188:0`) |

### Interface descriptors

| Interface | Class | Subclass | Protocol | Endpoints | Driver |
|---|---|---|---|---|---|
| `1-1:1.0` | `ff` (Vendor Specific) | `00` | `00` | 3 (`ep_02`, `ep_81`, `ep_83`) | `pl2303` |

**Conclusion:** it is a **USB-Serial converter** (Prolific PL2303) — it is **not** HID and **not** CDC-ACM. The resulting
port is `/dev/ttyUSB0`. The `usbhid-ups` driver does **not** apply.

> **Difference from the TS Shara:** there the chip is an STM32 Virtual ComPort (`0483:5740`, CDC-ACM,
> `/dev/ttyACM0`). Here it is a `067b:23d3` (USB-Serial, `/dev/ttyUSB0`).

### Layout in sysfs (important for port auto-detection)

In CDC-ACM, the tty node sits **directly** on the interface:

```text
/sys/bus/usb/devices/<bus>-<port>/<bus>-<port>:1.0/tty/ttyACM0
```

In USB-Serial (the case of this equipment), there is **one intermediate level** (the `usbserial`
device directory):

```text
/sys/bus/usb/devices/1-1/1-1:1.0/ttyUSB0/tty/ttyUSB0
                                     ^^^^^^^^ usbserial device name
```

Only the interface (`1-1:1.0`) does **not** declare `idVendor`/`idProduct`; the one that declares them is the parent
device (`1-1`). That is why the API's port auto-detection **climbs the sysfs tree from
`/sys/class/tty/ttyUSB*`** up to finding the USB IDs — see [tests-and-evidence.md](tests-and-evidence.md) T8.

### Other USB devices

| Device | ID | Note |
|---|---|---|
| Webcam | `Sonix USB2.0 HD UVC WebCam` | built into the notebook |
| Bluetooth | `Intel Bluetooth` | built into the notebook |

Only the `067b:23d3` item is the UPS.

## 3. How to reproduce

```bash
lsb_release -ds; uname -a; date --iso-8601=seconds
lsusb
lsusb -t
for d in /sys/bus/usb/devices/*/; do
  [ "$(cat "$d/idVendor" 2>/dev/null)" = "067b" ] || continue
  for f in idVendor idProduct manufacturer product serial bDeviceClass speed bcdDevice; do
    echo "$f = $(cat "$d/$f" 2>/dev/null)"; done
done
ls -l /dev/ttyUSB*
readlink -f /sys/class/tty/ttyUSB0/device      # -> .../1-1/1-1:1.0/ttyUSB0
```
