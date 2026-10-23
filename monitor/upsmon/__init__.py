"""Unified UPS monitoring app (multi-device).

A single process, a single HTTP API, N devices. Each device has its own protocol
driver and its own isolated collector; the HTTP layer serves all of them through
the same port, addressed by `/api/v1/ups/{device_id}`.

Modules:
    config      - configuration (service + device list)
    models      - common envelope of the JSON contract
    serial_link - serial transport (port detection by VID:PID)
    drivers     - protocol drivers (megatec-q1, sms-1phase)
    collector   - one collector per device, with in-memory state
    http_api    - multi-device HTTP/REST layer (telemetry + battery test)
    cli         - command-line entry point

Usage:
    python3 -m upsmon                 # starts all collectors + the API
    python3 -m upsmon --check         # one collection per device, JSON
    python3 -m upsmon --list          # lists the configured devices
"""

API_VERSION = "v1"
CONTRACT_VERSION = "3.0"

__all__ = ["API_VERSION", "CONTRACT_VERSION"]
