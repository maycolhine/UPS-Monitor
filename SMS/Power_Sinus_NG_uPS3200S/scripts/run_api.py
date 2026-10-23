#!/usr/bin/env python3
"""Shortcut to start the SMS collector + REST API (equivalent to `python3 -m api`).

Usage:
    python3 scripts/run_api.py                 # starts the API (default: 127.0.0.1:8082)
    python3 scripts/run_api.py --check         # one collection, prints the contract JSON
    python3 scripts/run_api.py --help          # all options

The `api/` package lives in the model directory; this script only adjusts sys.path.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.cli import main  # noqa: E402 - import after adjusting sys.path

if __name__ == "__main__":
    sys.exit(main())
