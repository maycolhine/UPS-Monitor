"""Collector and REST API for the TS Shara UPS (Megatec/Q1 protocol over USB CDC-ACM).

Modules:
    config      - configuration (defaults, INI file, environment variables)
    protocol    - Megatec/Q1 commands and pure frame parsing (no I/O)
    models      - standardized data model (telemetry, identity, state)
    serial_link - serial transport (port detection, read/write)
    collector   - periodic collection loop + in-memory state
    http_api    - HTTP/REST layer (read-only)
    cli         - command-line entry point

Usage:
    python3 -m api                 # start collector + REST API
    python3 -m api --check         # one collection, print the contract JSON
"""

API_VERSION = "v1"
CONTRACT_VERSION = "1.0"

__all__ = ["API_VERSION", "CONTRACT_VERSION"]
