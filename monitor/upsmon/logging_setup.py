"""Log formatting for the application (console or file)."""
from __future__ import annotations

import logging
import sys

LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
DATE_FORMAT = "%Y-%m-%dT%H:%M:%S%z"


def setup_logging(level: str = "INFO", log_file: str = "") -> None:
    # logs go to stderr so as not to contaminate the JSON printed to stdout
    # by --check mode (the contract must be readable through pipes).
    handlers = [logging.FileHandler(log_file)] if log_file else [logging.StreamHandler(sys.stderr)]
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format=LOG_FORMAT,
        datefmt=DATE_FORMAT,
        handlers=handlers,
        force=True,
    )
