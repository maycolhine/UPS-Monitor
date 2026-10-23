#!/usr/bin/env python3
"""sms_collector.py - single reading of the SMS Power Sinus NG uPS3200S UPS
(SMS Brazil 1Phase protocol over Prolific USB-Serial).

Usage modes:
    python3 scripts/sms_collector.py                    # one reading, text format
    python3 scripts/sms_collector.py --json             # one reading, JSON format
    python3 scripts/sms_collector.py --identify         # also reads I (identification) and F (ratings)
    python3 scripts/sms_collector.py --port /dev/ttyUSB0

This script reuses the official parser in api/protocol.py (same source of truth
as the REST API). The battery percentage COMES from the device (Q frame); the voltage
is DERIVED as nominal * percentage / 100 (rule of the NUT sms_ser driver).

Requirements: python3-serial (pyserial) and access to /dev/ttyUSB0 (dialout group).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api import protocol  # noqa: E402 - import after adjusting sys.path
from api.config import Config  # noqa: E402
from api.serial_link import LinkError, SerialLink  # noqa: E402


def read(link, config, identify=False):
    """Runs a reading (Q, and optionally I/F) and returns the processed fields."""
    parsed = dict(protocol.parse_status_frame(link.query(protocol.CMD_STATUS)))
    parsed.pop("raw_frame", None)

    nominal = config.battery_voltage_nominal_v
    data = dict(parsed)
    data["battery_voltage_v"] = protocol.battery_voltage(parsed["battery_charge_percent"], nominal)
    data["battery_voltage_nominal_v"] = nominal
    data["battery_packs"] = protocol.battery_packs(nominal)

    if identify:
        try:
            ident = protocol.parse_identity_frame(link.query(protocol.CMD_IDENTITY))
            data["model"] = ident["model"]
            data["firmware"] = ident["firmware"]
        except protocol.ProtocolError as exc:
            data["ident_error"] = exc.message
        try:
            ratings = protocol.parse_ratings_frame(link.query(protocol.CMD_RATINGS))
            data["nominal_voltage_v"] = ratings["nominal_voltage_v"]
            data["nominal_battery_voltage_v"] = ratings["nominal_battery_voltage_v"]
            data["nominal_frequency_hz"] = ratings["nominal_frequency_hz"]
        except protocol.ProtocolError as exc:
            data["ratings_error"] = exc.message
    return data


def format_text(data):
    lines = ["== SMS Power Sinus NG uPS3200S (SMS 1Phase protocol) =="]
    lines += [
        f"  Input voltage     : {data['input_voltage_v']:7.1f} V",
        f"  Output voltage    : {data['output_voltage_v']:7.1f} V",
        f"  Output frequency  : {data['output_frequency_hz']:7.1f} Hz",
        f"  Load              : {data['load_percent']:7.1f} %",
        f"  Battery           : {data['battery_charge_percent']:7.1f} %"
        f"  ({data['battery_voltage_v']} V derived from {data['battery_voltage_nominal_v']} V nominal)",
        f"  Temperature       : {data['temperature_c']:7.1f} C",
        f"  Status (raw)      : {data['status_raw']}"
        f"  ->  {', '.join(data['status_active']) or 'no flag'}",
    ]
    for key, label in (
        ("model", "Model"),
        ("firmware", "Firmware"),
        ("nominal_voltage_v", "Nominal voltage"),
        ("nominal_battery_voltage_v", "Nominal battery"),
        ("nominal_frequency_hz", "Nominal freq."),
    ):
        if data.get(key) is not None:
            lines.append(f"  {label:17}: {data[key]}")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Single reading of the SMS UPS (1Phase protocol)")
    parser.add_argument("--port", help="serial port (default: auto-detects by VID:PID 067b:23d3)")
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument(
        "--identify",
        action="store_true",
        help="also read I (identification) and F (nominal ratings)",
    )
    args = parser.parse_args(argv)

    overrides = {"serial_port": args.port} if args.port else {}
    config = Config(**overrides)
    link = SerialLink(config)
    try:
        data = read(link, config, identify=args.identify)
    except LinkError as exc:
        sys.exit(f"communication failure ({exc.code}): {exc.message}")
    except protocol.ProtocolError as exc:
        sys.exit(f"invalid frame ({exc.code}): {exc.message}")
    finally:
        link.close()

    print(json.dumps(data, ensure_ascii=False) if args.json else format_text(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
