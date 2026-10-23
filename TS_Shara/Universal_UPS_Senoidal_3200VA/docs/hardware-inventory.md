# Hardware and system inventory (Stage 1)

All evidence was collected on **2026-10-20**, on the lab host, with the UPS USB cable connected
directly to Ubuntu (TS App closed).

## 1. Operating system

| Item | Value |
|---|---|
| Distribution | Ubuntu 24.04.5 LTS (Noble Numbat) |
| Kernel | `Linux <host> 6.8.0-45-generic #45~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC ... x86_64` |
| Test date/time | `2026-10-20T12:17:27-03:00` |

Evidence: `lsb_release -a`, `uname -a`, `date --iso-8601=seconds`.

## 2. UPS USB device

Identified by `lsusb`, `lsusb -t` and the attributes in `/sys/bus/usb/devices/1-1/`.

| Field | Value |
|---|---|
| Bus/address | `Bus 001 Device 002` (changes after reconnection — do not use as an ID) |
| sysfs path | `/sys/bus/usb/devices/1-1` |
| **VID:PID** | **`0483:5740`** |
| Manufacturer | `STMicroelectronics` |
| Product | `STM32 Virtual ComPort` |
| Chip serial string | `00000000001A` |
| `bDeviceClass` | `02` (Communications / CDC) |
| Interfaces | `bNumInterfaces = 2`, `bNumConfigurations = 1` |
| Power | `bMaxPower = 100mA` |
| Speed | `12 Mbps` (USB Full-Speed) |
| USB version | `2.00` |
| Resulting Linux port | **`/dev/ttyACM0`** (`crw-rw---- root:dialout`) |

### Interface descriptors

| Interface | Class | Subclass | Protocol | Endpoints | Driver |
|---|---|---|---|---|---|
| `1-1:1.0` | `02` (Communications) | `02` (Abstract Control Model) | `01` (AT / V.25ter) | 1 (control) | `cdc_acm` |
| `1-1:1.1` | `0a` (CDC Data) | `00` | `00` | 2 (bulk IN/OUT) | `cdc_acm` |

**Conclusion:** this is a standard **CDC-ACM Virtual COM Port**. There is no HID interface, so the
`usbhid-ups` driver does **not** apply. Communication is serial, carried over USB.

### Other USB devices

| Device | ID | Note |
|---|---|---|
| Webcam | `322e:2103 Sonix USB2.0 HD UVC WebCam` | internal to the notebook |
| Bluetooth | `8087:0aaa Intel Bluetooth 9460/9560` | internal to the notebook |

Only the `0483:5740` item is the UPS.

## 3. How to reproduce

```bash
lsb_release -a; uname -a; date --iso-8601=seconds
lsusb
lsusb -t
for d in /sys/bus/usb/devices/*/; do
  [ "$(cat "$d/idVendor" 2>/dev/null)" = "0483" ] || continue
  for f in idVendor idProduct manufacturer product serial bDeviceClass speed; do
    echo "$f = $(cat "$d/$f" 2>/dev/null)"; done
done
ls -l /dev/ttyACM*
```
