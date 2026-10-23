"""Command-line entry point: starts the collectors and the unified REST API."""
from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import threading
from datetime import datetime, timezone

from . import CONTRACT_VERSION
from .collector import Collector
from .config import ConfigError, load_config
from .http_api import ENDPOINTS, AppContext, make_server, telemetry_payload
from .logging_setup import setup_logging

LOGGER = logging.getLogger("upsmon.cli")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m upsmon",
        description="Unified UPS collector and REST API (multi-device).",
    )
    parser.add_argument("--config", help="INI configuration file ([upsmon] section + [device:*] blocks)")
    parser.add_argument("--list", action="store_true", help="list the configured devices and exit")
    parser.add_argument(
        "--check",
        action="store_true",
        help="run one collection per device, print the contract JSON and exit",
    )
    parser.add_argument("--http-host", help="API listen interface (default: 127.0.0.1)")
    parser.add_argument("--http-port", type=int, help="API port (default: 8080)")
    parser.add_argument("--log-level", help="DEBUG, INFO, WARNING, ERROR (default: INFO)")
    parser.add_argument("--log-file", help="write logs to a file (default: stderr)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    overrides = {
        "http_host": args.http_host,
        "http_port": args.http_port,
        "log_level": args.log_level,
        "log_file": args.log_file,
    }
    try:
        config = load_config(args.config, overrides)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    setup_logging(config.log_level, config.log_file)

    if args.list:
        return _run_list(config)

    try:
        collectors = {device.device_id: Collector(device) for device in config.devices}
    except ValueError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if args.check:
        return _run_check(config, collectors)
    return _run_server(config, collectors)


def _run_list(config) -> int:
    print(f"HTTP API: http://{config.http_host}:{config.http_port}  (contract {CONTRACT_VERSION})")
    print(f"devices: {len(config.devices)}")
    for device in config.devices:
        vid_pid = f"{device.usb_vendor_id or '?'}:{device.usb_product_id or '?'}"
        print(
            f"  - {device.device_id}: protocol={device.protocol} transport={device.transport} "
            f"vid:pid={vid_pid} port={device.serial_port or '(auto-detect)'} "
            f"interval={device.poll_interval_s}s"
        )
    return 0


def _run_check(config, collectors: dict) -> int:
    """One collection per device; useful to validate the hardware without starting the API."""
    context = AppContext(config=config, collectors=collectors, started_at=datetime.now(timezone.utc))
    result = {}
    all_ok = True
    for device_id, collector in collectors.items():
        collector.collect_once()
        status, payload = telemetry_payload(context, device_id, datetime.now(timezone.utc))
        result[device_id] = payload
        all_ok = all_ok and status == 200
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if all_ok else 3


def _run_server(config, collectors: dict) -> int:
    context = AppContext(config=config, collectors=collectors, started_at=datetime.now(timezone.utc))
    try:
        server = make_server(context)
    except OSError as exc:
        LOGGER.error("could not listen on %s:%s: %s", config.http_host, config.http_port, exc)
        return 1

    stop_event = threading.Event()

    def handle_signal(signum, _frame):
        LOGGER.info("signal %s received; shutting down", signum)
        stop_event.set()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    for collector in collectors.values():
        collector.start()

    LOGGER.info(
        "Unified REST API active at http://%s:%d (api_version=v1, contract_version=%s, "
        "read-only telemetry + per-device battery test)",
        config.http_host,
        config.http_port,
        CONTRACT_VERSION,
    )
    LOGGER.info("devices served: %s", ", ".join(collectors) or "(none)")
    for endpoint in ENDPOINTS:
        LOGGER.info("endpoint %s %s", endpoint["method"], endpoint["path"])

    server_thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="upsmon-api", daemon=True
    )
    server_thread.start()

    try:
        while not stop_event.is_set():
            stop_event.wait(0.5)
    except KeyboardInterrupt:  # pragma: no cover - Ctrl+C without handler
        pass
    finally:
        server.shutdown()
        server.server_close()
        for collector in collectors.values():
            collector.stop()
        server_thread.join(timeout=5)
    LOGGER.info("application stopped")
    return 0
