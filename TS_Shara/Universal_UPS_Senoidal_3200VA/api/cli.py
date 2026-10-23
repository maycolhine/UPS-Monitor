"""Command-line entry point: starts the serial collector and the REST API."""
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

LOGGER = logging.getLogger("ts_shara.cli")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m api",
        description="Collector and REST API for the TS Shara UPS (Megatec/Q1 over USB CDC-ACM).",
    )
    parser.add_argument("--config", help="INI configuration file ([ts_shara_api] section)")
    parser.add_argument("--port", help="serial port (default: autodetect by VID:PID)")
    parser.add_argument("--baud", type=int, help="baud rate (default: 2400)")
    parser.add_argument("--device-id", help="logical identifier for the device")
    parser.add_argument("--interval", type=float, help="collection interval in seconds (default: 5)")
    parser.add_argument("--stale-after", type=float, help="maximum age of telemetry in seconds")
    parser.add_argument("--http-host", help="API listen interface (default: 127.0.0.1)")
    parser.add_argument("--http-port", type=int, help="API port (default: 8081)")
    parser.add_argument("--log-level", help="DEBUG, INFO, WARNING, ERROR (default: INFO)")
    parser.add_argument("--log-file", help="write logs to a file (default: stdout)")
    parser.add_argument(
        "--check",
        action="store_true",
        help="run a single collection, print the contract JSON and exit (does not start the API)",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    overrides = {
        "serial_port": args.port,
        "serial_baud": args.baud,
        "device_id": args.device_id,
        "poll_interval_s": args.interval,
        "stale_after_s": args.stale_after,
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
    collector = Collector(config)

    if args.check:
        return _run_check(config, collector)
    return _run_server(config, collector)


def _run_check(config, collector: Collector) -> int:
    """A single collection; useful to validate the hardware and the contract without starting the API."""
    context = AppContext(config=config, collector=collector, started_at=datetime.now(timezone.utc))
    collector.collect_once()
    snapshot = collector.snapshot()
    status, payload = telemetry_payload(
        context, snapshot, config.device_id, datetime.now(timezone.utc)
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if status == 200 else 3


def _run_server(config, collector: Collector) -> int:
    context = AppContext(config=config, collector=collector, started_at=datetime.now(timezone.utc))
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

    collector.start()
    LOGGER.info(
        "REST API up at http://%s:%d (api_version=v1, contract_version=%s, read-only)",
        config.http_host,
        config.http_port,
        CONTRACT_VERSION,
    )
    for endpoint in ENDPOINTS:
        LOGGER.info("endpoint %s %s", endpoint["method"], endpoint["path"])

    server_thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.5}, name="ts-shara-api", daemon=True
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
        collector.stop()
        server_thread.join(timeout=5)
    LOGGER.info("application stopped")
    return 0
