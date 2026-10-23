#!/usr/bin/env python3
"""Emergency cancellation of the battery test of an SMS Brazil 1Phase UPS.

Context (incident of 2026-10-22): the test triggered by command `T` with the
duration parameter at 0xFF (255) does NOT stop by itself in ~10 s. The firmware treats
the value 0xFF as "no duration defined" and runs the test DISCHARGING the battery
down to the low level (same practical effect as command `L`). While the test runs,
the output stays connected to the inverter (TEST + OB + BOOST bits).

This script sends the CANCEL command (`D`) and confirms, by reading the `Q` frames,
that the TEST/OB bits were cleared and the mains resumed feeding the load.

The serial port has an EXCLUSIVE LOCK: the upsmon-api service does not release it while
it is running. Therefore the service must be STOPPED during the cancellation.
The simplest way is to run this script with sudo (it stops and restarts the service
automatically):

    sudo python3 scripts/cancel_battery_test.py

Options:
    --port /dev/ttyUSB0    UPS serial port (default)
    --service upsmon-api   systemd unit name (default: upsmon-api)
    --no-service           does NOT touch systemd (the port must already be free)
    --seconds 20           maximum observation time after the cancellation
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time

try:
    import serial
except ImportError:  # pragma: no cover
    sys.exit("pyserial not installed. Install it with: sudo apt install python3-serial")

ENDCHAR = 0x0D
RESULT_SIZE = 18
# Meaning of the status bits (byte 15 of the Q frame), b0..b7.
STATUS_BITS = {
    0: "BEEP", 1: "FSD", 2: "TEST", 3: "UPSOK",
    4: "BOOST", 5: "BYPASS", 6: "LB", 7: "OB",
}


def command(letter: str, p1: int = 0xFF, p2: int = 0xFF, p3: int = 0xFF, p4: int = 0xFF) -> bytes:
    """Builds the 7 bytes: <cmd> P1 P2 P3 P4 <checksum> <CR>.

    checksum = (-(sum of the first 6 bytes)) & 0xFF (same formula as the NUT sms_ser
    driver: `(b0+b1+b2+b3+b4+b5) * 255` truncated to 1 byte).
    """
    payload = bytes([ord(letter), p1, p2, p3, p4])
    checksum = (-sum(payload)) & 0xFF
    return payload + bytes([checksum, ENDCHAR])


def decode_status(byte: int) -> list[str]:
    return [tag for pos, tag in STATUS_BITS.items() if byte & (1 << pos)]


def read_status(ser) -> tuple[int | None, list[str], str]:
    """Sends `Q` and returns (status_byte, active_flags, frame_hex)."""
    ser.reset_input_buffer()
    ser.write(command("Q"))
    ser.flush()
    time.sleep(0.5)
    raw = ser.read(RESULT_SIZE)
    if len(raw) < RESULT_SIZE:
        return None, [], raw.hex(" ")
    return raw[15], decode_status(raw[15]), raw.hex(" ")


def systemctl(action: str, service: str) -> bool:
    result = subprocess.run(["systemctl", action, service], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  !! systemctl {action} {service} failed: {result.stderr.strip()}")
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Cancels the battery test of an SMS Brazil 1Phase UPS")
    ap.add_argument("--port", default="/dev/ttyUSB0")
    ap.add_argument("--service", default="upsmon-api")
    ap.add_argument("--no-service", action="store_true", help="does not touch systemd")
    ap.add_argument("--seconds", type=float, default=20.0)
    args = ap.parse_args()

    manage = not args.no_service
    if manage:
        print(f"== Stopping the service {args.service} to release the port ==")
        if not systemctl("stop", args.service):
            return 2
        time.sleep(1.5)  # waits for the process to close the serial port

    try:
        with serial.Serial(args.port, 2400, timeout=0.5, exclusive=True) as ser:
            byte, flags, frame = read_status(ser)
            print(f"== BEFORE == status={flags} (byte {byte})  frame={frame}")

            print("== Sending the CANCEL command (D) ==")
            ser.write(command("D"))
            ser.flush()

            deadline = time.monotonic() + args.seconds
            cancelled = False
            while time.monotonic() < deadline:
                time.sleep(1.0)
                byte, flags, frame = read_status(ser)
                print(f"   after D: status={flags} (byte {byte})  frame={frame}")
                if byte is not None and "TEST" not in flags and "OB" not in flags:
                    cancelled = True
                    break
                if byte is not None and "TEST" in flags and "OB" in flags:
                    ser.write(command("D"))  # resends the cancellation
                    ser.flush()

            print()
            if cancelled:
                print("RESULT: test CANCELLED. The mains resumed feeding the load "
                      "(TEST and OB cleared).")
                rc = 0
            else:
                print("RESULT: could NOT confirm the cancellation within the window.")
                print("        Check the state through the API and, if needed, repeat the procedure.")
                rc = 1
    except serial.SerialException as exc:
        print(f"error on the serial port {args.port}: {exc}")
        rc = 2
    finally:
        if manage:
            print(f"\n== Restarting the service {args.service} ==")
            systemctl("start", args.service)
    return rc


if __name__ == "__main__":
    sys.exit(main())
