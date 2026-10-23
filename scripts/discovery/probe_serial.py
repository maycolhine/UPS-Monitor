#!/usr/bin/env python3
"""
probe_serial.py - DISCOVERY tool (read-only) for the TS Shara Senoidal 3200 UNIV
UPS (Megatec/Q1 protocol over USB CDC-ACM).

Goal: locate the correct serial port, confirm the baud rate and discover
which commands the firmware responds to -- without changing the device state
(no shutdown/test command is sent by default).

Usage:
    python3 probe_serial.py                     # detection + probing of the known commands
    python3 probe_serial.py --port /dev/ttyACM0 # force the port
    python3 probe_serial.py --fuzz              # sweep A-Z, a-z, 0-9
    python3 probe_serial.py --raw Q1            # send a raw command (without \\r)
    python3 probe_serial.py --baud 9600         # change the baud rate

Requirements: python3-serial (pyserial). Read/write permission on
/dev/ttyACM* (dialout group or chmod 666).
"""
import argparse
import glob
import os
import string
import sys
import time

try:
    import serial
except ImportError:  # pragma: no cover
    sys.exit("pyserial not installed. Install it with: sudo apt install python3-serial")

VENDOR_ID = "0483"    # STMicroelectronics
PRODUCT_ID = "5740"   # STM32 Virtual ComPort (CDC-ACM)
DEFAULT_BAUD = 2400   # Megatec nominal value; the CDC-ACM port tends to ignore it

# Candidate commands of the Megatec/Q1 family.
# CONFIRMED on the TS Shara 3200 UNIV: Q1, I, F  (the others return empty)
KNOWN_COMMANDS = [b"Q1\r", b"I\r", b"F\r", b"Q\r", b"T\r", b"TL\r",
                  b"S\r", b"D\r", b"M\r", b"V\r", b"N\r", b"C\r"]


def _read_sys(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def detect_port():
    """Locate the /dev/ttyACM* port associated with the TS Shara VID:PID."""
    for dev in sorted(glob.glob("/sys/bus/usb/devices/*")):
        if _read_sys(os.path.join(dev, "idVendor")) != VENDOR_ID:
            continue
        if _read_sys(os.path.join(dev, "idProduct")) != PRODUCT_ID:
            continue
        base = os.path.basename(dev)
        for tty in sorted(glob.glob(f"/sys/bus/usb/devices/{base}/{base}:*/tty/*")):
            node = f"/dev/{os.path.basename(tty)}"
            if os.path.exists(node):
                return node
    return None


def describe_device():
    """Return a dict with the USB metadata of the device (via sysfs)."""
    for dev in sorted(glob.glob("/sys/bus/usb/devices/*")):
        if _read_sys(os.path.join(dev, "idVendor")) != VENDOR_ID:
            continue
        if _read_sys(os.path.join(dev, "idProduct")) != PRODUCT_ID:
            continue
        return {
            "sysfs": dev,
            "idVendor": VENDOR_ID,
            "idProduct": PRODUCT_ID,
            "manufacturer": _read_sys(os.path.join(dev, "manufacturer")),
            "product": _read_sys(os.path.join(dev, "product")),
            "serial": _read_sys(os.path.join(dev, "serial")),
            "bDeviceClass": _read_sys(os.path.join(dev, "bDeviceClass")),
            "speed_mbps": _read_sys(os.path.join(dev, "speed")),
        }
    return {}


def hexdump(data: bytes) -> str:
    return " ".join(f"{b:02x}" for b in data)


def probe(port, baud, command, wait=0.4):
    with serial.Serial(port, baud, timeout=wait) as ser:
        ser.reset_input_buffer()
        ser.write(command)
        ser.flush()
        time.sleep(wait)
        return ser.read(512)


def passive_read(port, baud, seconds=1.0):
    with serial.Serial(port, baud, timeout=0.5) as ser:
        ser.reset_input_buffer()
        time.sleep(seconds)
        return ser.read(1024)


def main():
    ap = argparse.ArgumentParser(description="Discovery of the TS Shara UPS protocol")
    ap.add_argument("--port", help="serial port (default: autodetect via USB)")
    ap.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    ap.add_argument("--raw", help="sends a single raw command and shows the response")
    ap.add_argument("--fuzz", action="store_true", help="sweep A-Z, a-z, 0-9")
    ap.add_argument("--baud-sweep", action="store_true", help="tests passive reading at several baud rates")
    args = ap.parse_args()

    print("== USB metadata ==")
    for k, v in describe_device().items():
        print(f"  {k:14} = {v}")

    port = args.port or detect_port()
    if not port:
        sys.exit("Device 0483:5740 not found. Check the USB cable.")
    print(f"\n== Serial port ==\n  {port}  (baud {args.baud})")

    if not os.access(port, os.R_OK | os.W_OK):
        sys.exit(f"No permission on {port}. Use the dialout group or 'sudo chmod 666 {port}'.")

    if args.baud_sweep:
        print("\n== Passive reading per baud (expected: 0 bytes, the protocol is poll-based) ==")
        for b in (2400, 4800, 9600, 19200, 38400, 115200):
            data = passive_read(port, b, 1.0)
            print(f"  {b:6} -> {len(data)} bytes: {data!r}")

    if args.raw:
        cmd = args.raw.encode() + b"\r"
        resp = probe(port, args.baud, cmd)
        print(f"\n== Raw command ==\n  TX {cmd!r}\n  RX {resp!r}\n  HEX {hexdump(resp)}")
        return

    if args.fuzz:
        print("\n== Command sweep (A-Z, a-z, 0-9) ==")
        cmds = [c.encode() + b"\r" for c in string.ascii_uppercase]
        cmds += [c.encode() + b"\r" for c in string.ascii_lowercase]
        cmds += [c.encode() + b"\r" for c in string.digits]
        hits = 0
        for cmd in cmds:
            resp = probe(port, args.baud, cmd, wait=0.25)
            if resp:
                hits += 1
                print(f"  {cmd!r:8} -> {resp!r}")
        print(f"  Commands with a response: {hits}/{len(cmds)}")
        return

    print("\n== Probing of the known commands ==")
    for cmd in KNOWN_COMMANDS:
        resp = probe(port, args.baud, cmd)
        tag = "OK " if resp else "-- "
        print(f"  {tag}TX {cmd!r:8} -> RX({len(resp):3}) {resp!r}")


if __name__ == "__main__":
    main()
