#!/usr/bin/env python3
"""Shortcut to start the collectors + unified REST API (equivalent to `python3 -m upsmon`).

Usage:
    python3 scripts/run_api.py                          # starts the API (default: 127.0.0.1:8080)
    python3 scripts/run_api.py --config /etc/upsmon/upsmon.conf
    python3 scripts/run_api.py --list                   # lists the configured devices
    python3 scripts/run_api.py --check                  # one collection per device, prints the JSON
    python3 scripts/run_api.py --help                   # all options

The `upsmon/` package lives in the `monitor/` directory; this script only adjusts sys.path.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from upsmon.cli import main  # noqa: E402 - import after adjusting sys.path

if __name__ == "__main__":
    sys.exit(main())
