"""Standardized data model exposed by the API (JSON contract v1).

Field names with explicit units (suffixes _v, _hz, _c, _a, _percent) and
dates in ISO 8601 UTC.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timezone

# Communication state (field `state`), in the evaluation order of the collector.
STATE_STARTING = "starting"
STATE_OK = "ok"
STATE_STALE = "stale"
STATE_PORT_UNAVAILABLE = "port_unavailable"
STATE_PERMISSION_DENIED = "permission_denied"
STATE_DISCONNECTED = "disconnected"
STATE_TIMEOUT = "timeout"
STATE_INVALID_RESPONSE = "invalid_response"
STATE_INCOMPLETE_RESPONSE = "incomplete_response"
STATE_CHECKSUM_ERROR = "checksum_error"
STATE_OUT_OF_RANGE = "out_of_range"
STATE_SERIAL_ERROR = "serial_error"

COMMUNICATION_STATES = (
    STATE_STARTING,
    STATE_OK,
    STATE_STALE,
    STATE_PORT_UNAVAILABLE,
    STATE_PERMISSION_DENIED,
    STATE_DISCONNECTED,
    STATE_TIMEOUT,
    STATE_INVALID_RESPONSE,
    STATE_INCOMPLETE_RESPONSE,
    STATE_CHECKSUM_ERROR,
    STATE_OUT_OF_RANGE,
    STATE_SERIAL_ERROR,
)


def iso_utc(moment) -> str | None:
    """Formats a datetime in ISO 8601 UTC (e.g.: 2026-10-22T12:00:00.123Z)."""
    if moment is None:
        return None
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Telemetry:
    """Last valid reading of the UPS (one sample of the Q frame)."""

    captured_at: object  # datetime UTC
    input_voltage_v: float
    input_voltage_extended_v: float
    output_voltage_v: float
    load_percent: float
    output_frequency_hz: float
    battery_charge_percent: float
    battery_voltage_v: float | None
    battery_voltage_nominal_v: int | None
    battery_packs: int | None
    temperature_c: float
    status_raw: str
    status_byte: int
    status_flags: dict
    status_active: list
    raw_frame: str
    source: str = "sms-1phase"

    def to_dict(self, now=None) -> dict:
        data = {
            "captured_at_utc": iso_utc(self.captured_at),
            "source": self.source,
            "measurements": {
                "input_voltage_v": self.input_voltage_v,
                "input_voltage_extended_v": self.input_voltage_extended_v,
                "output_voltage_v": self.output_voltage_v,
                "load_percent": self.load_percent,
                "output_frequency_hz": self.output_frequency_hz,
                "temperature_c": self.temperature_c,
            },
            "battery": {
                # the percentage COMES FROM the equipment (it is not estimated).
                "charge_percent": self.battery_charge_percent,
                "charge_source": "reported_by_device",
                # the voltage is NOT in the frame: it is derived from nominal x percentage
                # (same rule as the NUT sms_ser driver) — see Spec.md 7.3.
                "voltage_v": self.battery_voltage_v,
                "voltage_derived": True,
                "voltage_nominal_v": self.battery_voltage_nominal_v,
                "packs": self.battery_packs,
            },
            "status": {
                "raw_bits": self.status_raw,
                "raw_byte": self.status_byte,
                "active": list(self.status_active),
                "flags": dict(self.status_flags),
            },
            "raw_frame": self.raw_frame,
        }
        if now is not None:
            data["age_seconds"] = round(max(0.0, (now - self.captured_at).total_seconds()), 3)
        return data


@dataclass(frozen=True)
class Identity:
    """Identification of the equipment (command I) and ratings (command F)."""

    captured_at: object  # datetime UTC
    model: str | None
    firmware: str | None
    nominal_voltage_label: str | None
    nominal_voltage_v: int | None
    nominal_input_current_label: str | None
    nominal_input_current_a: int | None
    nominal_battery_voltage_label: str | None
    nominal_battery_voltage_v: int | None
    nominal_frequency_label: str | None
    nominal_frequency_hz: int | None
    ident_raw_frame: str | None
    ratings_raw_frame: str | None

    @property
    def available(self) -> bool:
        return any(value is not None for value in (self.model, self.firmware))

    def to_dict(self) -> dict:
        return {
            "captured_at_utc": iso_utc(self.captured_at),
            "device": {
                "model": self.model,
                "firmware": self.firmware,
                "raw_frame": self.ident_raw_frame,
            },
            "nominal": {
                "voltage_label": self.nominal_voltage_label,
                "voltage_v": self.nominal_voltage_v,
                "input_current_label": self.nominal_input_current_label,
                "input_current_a": self.nominal_input_current_a,
                "battery_voltage_label": self.nominal_battery_voltage_label,
                "battery_voltage_v": self.nominal_battery_voltage_v,
                "frequency_label": self.nominal_frequency_label,
                "frequency_hz": self.nominal_frequency_hz,
                "raw_frame": self.ratings_raw_frame,
            },
        }


@dataclass(frozen=True)
class ErrorInfo:
    """Last collection failure recorded."""

    code: str
    message: str
    at_utc: object  # datetime UTC

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "at_utc": iso_utc(self.at_utc)}


@dataclass
class CollectionState:
    """Collection metadata kept in memory (never persisted to a database)."""

    state: str = STATE_STARTING
    telemetry_valid: bool = False
    stale: bool = False
    last_attempt_utc: object = None
    last_success_utc: object = None
    age_seconds: float | None = None
    consecutive_failures: int = 0
    total_attempts: int = 0
    total_successes: int = 0
    last_error: ErrorInfo | None = None
    port: str | None = None
    poll_interval_s: float = 5.0
    stale_after_s: float = 20.0

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "telemetry_valid": self.telemetry_valid,
            "stale": self.stale,
            "last_attempt_utc": iso_utc(self.last_attempt_utc),
            "last_success_utc": iso_utc(self.last_success_utc),
            "age_seconds": self.age_seconds,
            "consecutive_failures": self.consecutive_failures,
            "total_attempts": self.total_attempts,
            "total_successes": self.total_successes,
            "last_error": self.last_error.to_dict() if self.last_error else None,
            "serial_port": self.port,
            "poll_interval_s": self.poll_interval_s,
            "stale_after_s": self.stale_after_s,
        }


@dataclass(frozen=True)
class Snapshot:
    """Consistent copy of the in-memory state, delivered to the HTTP layer."""

    telemetry: Telemetry | None
    identity: Identity | None
    state: CollectionState
    collector_alive: bool
