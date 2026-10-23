"""Collector and REST API for the SMS UPS (SMS 1Phase protocol over USB-Serial).

Modules:
    config      - configuration (defaults, INI file, environment variables)
    protocol    - commands and pure parsing of the SMS Q/I/F frames (no I/O)
    models      - standardized data model (telemetry, identity, state)
    serial_link - serial transport (port detection, read/write)
    collector   - periodic collection loop + in-memory state
    http_api    - HTTP/REST layer (read-only)
    cli         - command-line entry point

Usage:
    python3 -m api                 # starts collector + REST API
    python3 -m api --check         # one collection, prints the contract JSON
"""

API_VERSION = "v1"
CONTRACT_VERSION = "1.0"

__all__ = ["API_VERSION", "CONTRACT_VERSION"]
