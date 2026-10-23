#!/usr/bin/env python3
"""
ts_shara_collector.py - Collector for the TS Shara Sinusoidal 3200 UNIV UPS
(Megatec/Q1 protocol over USB CDC-ACM).

Responsible for:
  - sending the commands Q1 (status/measurements), I (identification) and F (ratings);
  - parsing the fields per the Megatec specification;
  - printing the data as readable text or JSON (for Zabbix).

Usage modes:
    python3 ts_shara_collector.py                  # one reading, text format
    python3 ts_shara_collector.py --json           # one reading, JSON format
    python3 ts_shara_collector.py --interval 5     # continuous loop (5 s)
    python3 ts_shara_collector.py --identify       # also print I and F
    python3 ts_shara_collector.py --port /dev/ttyACM0 --baud 2400
    python3 ts_shara_collector.py --battery-low 20.1 --battery-high 26.8

The Megatec protocol does not transmit the battery percentage: it is DERIVED from
the battery voltage (field SS.S of the Q1 frame). This collector applies the
empirical calibration obtained by simultaneous comparison with the TS App (see
Spec.md section 7.3).

Requirements: python3-serial (pyserial) and access to /dev/ttyACM* (dialout group).
"""
import argparse
import glob
import json
import os
import re
import sys
import time

try:
    import serial
except ImportError:  # pragma: no cover
    sys.exit("pyserial not installed. Install with: sudo apt install python3-serial")

VENDOR_ID = "0483"
PRODUCT_ID = "5740"
DEFAULT_BAUD = 2400

# Battery percentage calibration (see Spec.md section 7.3).
# The percentage does NOT come from the protocol: it is derived from the battery
# voltage by linear interpolation between a lower limit (0 %) and an upper one (100 %).
# Limits adjusted from two simultaneous readings with the TS App:
#   23.8 V -> 55 %   and   20.8 V -> 10 %
BATTERY_VOLTAGE_LOW_DEFAULT = 20.1
BATTERY_VOLTAGE_HIGH_DEFAULT = 26.8

# (MMM.M NNN.N PPP.P QQQ RR.R S.SS TT.T b7b6b5b4b3b2b1b0
Q1_RE = re.compile(
    rb"^\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([01]{8})"
)

# Meaning of the status bits per the Megatec specification (b7..b0).
# WARNING: position 7 (OB) of the TS Shara 3200 UNIV did not behave as expected
# on the bench (see docs/decisions-and-open-items.md).
STATUS_BITS = {
    7: ("OB", "Utility Fail / running on battery"),
    6: ("LB", "Low battery"),
    5: ("BOOST", "Boost/Buck/Bypass active"),
    4: ("FAULT", "UPS failure"),
    3: ("STANDBY", "Type: standby (0 = online)"),
    2: ("TEST", "Test in progress"),
    1: ("FSD", "Shutdown active"),
    0: ("BEEP", "Beeper on"),
}


def detect_port():
    for dev in sorted(glob.glob("/sys/bus/usb/devices/*")):
        def rd(name):
            try:
                with open(os.path.join(dev, name)) as fh:
                    return fh.read().strip()
            except OSError:
                return None
        if rd("idVendor") != VENDOR_ID or rd("idProduct") != PRODUCT_ID:
            continue
        base = os.path.basename(dev)
        for tty in sorted(glob.glob(f"/sys/bus/usb/devices/{base}/{base}:*/tty/*")):
            node = f"/dev/{os.path.basename(tty)}"
            if os.path.exists(node):
                return node
    return None


def send(ser, command, wait=0.4):
    ser.reset_input_buffer()
    ser.write(command.encode() + b"\r")
    ser.flush()
    time.sleep(wait)
    return ser.read(512).decode("ascii", "replace").strip()


def decode_status(bits):
    """Takes '10001101' (b7..b0) and returns a dict {tag: bool} + list of active tags."""
    flags = {}
    active = []
    for pos, (tag, _desc) in STATUS_BITS.items():
        on = pos < len(bits) and bits[len(bits) - 1 - pos] == "1"
        flags[tag] = on
        if on:
            active.append(tag)
    return flags, active


def estimate_battery_charge(voltage, vlow, vhigh):
    """Estimated battery percentage from the voltage (linear interpolation).

    % = clamp( 100 * (V - vlow) / (vhigh - vlow), 0, 100 )
    """
    if voltage is None or vhigh <= vlow:
        return None
    percent = 100.0 * (voltage - vlow) / (vhigh - vlow)
    return round(min(100.0, max(0.0, percent)), 1)


def read_q1(ser):
    raw = send(ser, "Q1")
    m = Q1_RE.match(raw.encode("ascii", "replace"))
    if not m:
        return {"raw": raw, "parse_error": True}
    flags, active = decode_status(m.group(8).decode())
    return {
        "input_voltage": float(m.group(1)),
        "input_voltage_fault": float(m.group(2)),
        "output_voltage": float(m.group(3)),
        "load_percent": int(m.group(4)),
        "input_frequency": float(m.group(5)),
        "battery_voltage": float(m.group(6)),
        "temperature_c": float(m.group(7)),
        "status_raw": m.group(8).decode(),
        "status_active": active,
        "status_flags": flags,
        "raw": raw,
    }


def read_identify(ser):
    """Command I: manufacturer/model/firmware. Command F: nominal ratings.

    The `I` frame follows the Megatec format: '#' + manufacturer (15 chars) + ' ' +
    model (10 chars) + ' ' + version. Examples from two units of the same model:
      '#TS -222  091225 Senoid  32 V01020805A'
      '#TS SHARA        SENO3.2kVA 26.000.000'
    The manufacturer layout varies between units; use fixed positions (like NUT).
    """
    ident = {}
    i = send(ser, "I")
    if i.startswith("#"):
        body = i[1:]
        ident["ident_raw"] = i
        ident["manufacturer"] = body[:15].strip() or None
        ident["model"] = body[16:26].strip() or None
        ident["firmware"] = body[27:].strip() or None
    f = send(ser, "F")
    if f.startswith("#"):
        ident["ratings_raw"] = f
        nums = f[1:].split()
        if len(nums) >= 3:
            ident["nominal_voltage_label"] = nums[0]
            ident["nominal_input_current"] = _to_float(nums[1])
            ident["nominal_battery_voltage"] = _to_float(nums[2])
            ident["nominal_frequency"] = _to_float(nums[3]) if len(nums) > 3 else None
    return ident


def _to_float(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def format_text(data):
    lines = ["== TS Shara Sinusoidal 3200 UNIV (Megatec/Q1) =="]
    if data.get("parse_error"):
        lines.append(f"  [PARSER ERROR] raw response: {data.get('raw')!r}")
        return "\n".join(lines)
    lines += [
        f"  Input voltage     : {data['input_voltage']:7.1f} V   (fault: {data['input_voltage_fault']:.1f} V)",
        f"  Output voltage    : {data['output_voltage']:7.1f} V",
        f"  Frequency         : {data['input_frequency']:7.1f} Hz",
        f"  Load              : {data['load_percent']:7d} %",
        f"  Battery           : {data['battery_voltage']:7.1f} V",
        f"  Battery charge    : {data['battery_charge_percent']:7.1f} %   (estimated from voltage)",
        f"  Temperature       : {data['temperature_c']:7.1f} C",
        f"  Status (raw)      : {data['status_raw']}  ->  {', '.join(data['status_active']) or 'no flag'}",
    ]
    for key, label in (("manufacturer", "Manufacturer"), ("model", "Model"),
                       ("firmware", "Firmware"), ("nominal_battery_voltage", "Nominal battery"),
                       ("nominal_frequency", "Nominal freq.")):
        if data.get(key) is not None:
            lines.append(f"  {label:17}: {data[key]}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Collector for the TS Shara UPS (Megatec/Q1)")
    ap.add_argument("--port", help="serial port (default: autodetect)")
    ap.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    ap.add_argument("--json", action="store_true", help="JSON output")
    ap.add_argument("--identify", action="store_true", help="also read I and F")
    ap.add_argument("--interval", type=float, default=0, help="loop interval in seconds")
    ap.add_argument("--count", type=int, default=0, help="number of samples (0 = infinite)")
    ap.add_argument("--battery-low", type=float, default=BATTERY_VOLTAGE_LOW_DEFAULT,
                    help="battery voltage in V that corresponds to 0%% "
                         f"(default: {BATTERY_VOLTAGE_LOW_DEFAULT} V)")
    ap.add_argument("--battery-high", type=float, default=BATTERY_VOLTAGE_HIGH_DEFAULT,
                    help="battery voltage in V that corresponds to 100%% "
                         f"(default: {BATTERY_VOLTAGE_HIGH_DEFAULT} V)")
    args = ap.parse_args()

    port = args.port or detect_port()
    if not port:
        sys.exit("Device 0483:5740 not found.")
    if not os.access(port, os.R_OK | os.W_OK):
        sys.exit(f"No permission on {port}. Use the dialout group or chmod 666.")

    with serial.Serial(port, args.baud, timeout=1.0) as ser:
        first = True
        n = 0
        while True:
            data = read_q1(ser)
            if not data.get("parse_error"):
                data["battery_charge_percent"] = estimate_battery_charge(
                    data["battery_voltage"], args.battery_low, args.battery_high
                )
            if args.identify and first:
                data.update(read_identify(ser))
            if args.interval > 0:
                data["timestamp"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")

            if args.json:
                print(json.dumps(data, ensure_ascii=False))
            else:
                print(format_text(data))
                print()

            n += 1
            first = False
            if args.interval <= 0 or (args.count and n >= args.count):
                break
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
