#!/usr/bin/env python3
"""monitor_collector.py - one-shot reading of the UPSes monitored by the unified API.

Usage modes:
    python3 scripts/monitor_collector.py                           # all devices, text format
    python3 scripts/monitor_collector.py --device sms-ups3200s-01  # a single device
    python3 scripts/monitor_collector.py --json                    # JSON output (API contract)
    python3 scripts/monitor_collector.py --identify                # include identity (I/F commands)
    python3 scripts/monitor_collector.py --config /etc/upsmon/upsmon.conf

Reuses the `upsmon` package (the same source of truth as the REST API); it does not
open the port if another process is using it (exclusive lock).
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from upsmon.collector import Collector  # noqa: E402 - import after adjusting sys.path
from upsmon.config import ConfigError, load_config  # noqa: E402


def read(device, identify=False):
    """Runs one collection of the device and returns (snapshot, telemetry)."""
    collector = Collector(device)
    try:
        collector.collect_once()
        snapshot = collector.snapshot()
    finally:
        collector.stop()
    return snapshot


def format_text(device, snapshot) -> str:
    state = snapshot.state
    telemetry = snapshot.telemetry
    lines = [
        f"== {device.device_id} ({device.brand} {device.model}, protocol {device.protocol}) ==",
        f"  {'Port':<18}: {state.port or device.serial_port or '(auto-detected)'}",
        f"  {'State':<18}: {state.state}",
    ]
    if telemetry is None:
        error = state.last_error
        lines.append(f"  {'Last error':<18}: {error.code} - {error.message}" if error else "  No valid reading")
        return "\n".join(lines)

    measurements = telemetry.measurements
    frequency = measurements.get("output_frequency_hz", measurements.get("input_frequency_hz"))
    lines += [
        f"  {'Input voltage':<18}: {measurements.get('input_voltage_v')} V",
        f"  {'Output voltage':<18}: {measurements.get('output_voltage_v')} V",
        f"  {'Frequency':<18}: {frequency} Hz",
        f"  {'Load':<18}: {measurements.get('load_percent')} %",
    ]
    battery = telemetry.battery or telemetry.battery_charge
    if battery is not None:
        percent = battery.get("charge_percent", battery.get("percent"))
        lines.append(f"  {'Battery':<18}: {percent} % ({battery.get('voltage_v')} V)")
    lines += [
        f"  {'Temperature':<18}: {measurements.get('temperature_c')} C",
        f"  {'Status':<18}: {', '.join(telemetry.status.get('active', [])) or 'no flags'}",
    ]
    if snapshot.identity is not None:
        identity = snapshot.identity
        lines.append(f"  {'Model':<18}: {identity.device.get('model')} (FW {identity.device.get('firmware')})")
        lines.append(f"  {'Nominal':<18}: {identity.nominal.get('voltage_v')} V / {identity.nominal.get('frequency_hz')} Hz")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="One-shot reading of the monitored UPSes (upsmon)")
    parser.add_argument("--config", help="INI configuration file ([upsmon] section + [device:*] blocks)")
    parser.add_argument("--device", help="read only this device_id")
    parser.add_argument("--json", action="store_true", help="JSON output (API contract)")
    parser.add_argument(
        "--identify", action="store_true", help="also read identity (I) and ratings (F)"
    )
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
    except ConfigError as exc:
        sys.exit(f"configuration error: {exc}")

    devices = [item for item in config.devices if not args.device or item.device_id == args.device]
    if args.device and not devices:
        sys.exit(f"device not configured: {args.device}")

    results = {}
    for device in devices:
        snapshot = read(device, identify=args.identify)
        if args.json:
            results[device.device_id] = {
                "communication": snapshot.state.to_dict(),
                "data": snapshot.telemetry.to_dict() if snapshot.telemetry else None,
                "identity": snapshot.identity.to_dict() if snapshot.identity else None,
            }
        else:
            print(format_text(device, snapshot))
            print()
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
