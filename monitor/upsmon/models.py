"""Common envelope of the JSON contract (shared by all protocols).

The envelope (`measurements`, `status`, dates and communication state) is common;
the CONTENT of each block is defined by the protocol driver, preserving the field
names of each device. This way the monitoring items already in place do not break:

    TS Shara (Megatec/Q1)  -> measurements.input_frequency_hz / battery_charge
    SMS (1Phase)           -> measurements.output_frequency_hz / battery
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timezone

# Communication state (field `state`), in the collector's evaluation order.
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
STATE_PARSE_ERROR = "parse_error"
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
    STATE_PARSE_ERROR,
    STATE_OUT_OF_RANGE,
    STATE_SERIAL_ERROR,
)


def iso_utc(moment) -> str | None:
    """Formats a datetime as ISO 8601 UTC (e.g. 2026-10-22T12:00:00.123Z)."""
    if moment is None:
        return None
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Telemetry:
    """Last valid reading of a UPS (the content comes from the driver)."""

    captured_at: object      # datetime UTC
    source: str              # protocol identifier (e.g. "megatec-q1")
    measurements: dict       # measurements: common core + protocol extensions
    status: dict             # {raw_bits, active, flags} (+ raw_byte when present)
    raw_frame: str
    battery: dict | None = None          # SMS: percentage from the device + derived voltage
    battery_charge: dict | None = None   # TS Shara: percentage estimated from the voltage

    def to_dict(self, now=None) -> dict:
        data = {
            "captured_at_utc": iso_utc(self.captured_at),
            "source": self.source,
            "measurements": dict(self.measurements),
        }
        if self.battery is not None:
            data["battery"] = dict(self.battery)
        if self.battery_charge is not None:
            data["battery_charge"] = dict(self.battery_charge)
        data["status"] = dict(self.status)
        data["raw_frame"] = self.raw_frame
        if now is not None:
            data["age_seconds"] = round(max(0.0, (now - self.captured_at).total_seconds()), 3)
        return data


@dataclass(frozen=True)
class Identity:
    """Identification (command I) and nominal ratings (command F)."""

    captured_at: object  # datetime UTC
    device: dict         # {manufacturer?, model, firmware, raw_frame}
    nominal: dict        # nominal fields + raw_frame

    @property
    def available(self) -> bool:
        return any(self.device.get(key) for key in ("manufacturer", "model", "firmware"))

    def to_dict(self) -> dict:
        return {
            "captured_at_utc": iso_utc(self.captured_at),
            "device": dict(self.device),
            "nominal": dict(self.nominal),
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
    """Collection metadata of ONE device (kept in memory)."""

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
    """Consistent copy of the state of ONE device, delivered to the HTTP layer."""

    telemetry: Telemetry | None
    identity: Identity | None
    state: CollectionState
    collector_alive: bool


# --------------------------------------------------------------------------- #
# Battery test (~10 s action + predictability report)                          #
# --------------------------------------------------------------------------- #
TEST_RUNNING = "running"
TEST_COMPLETED = "completed"
TEST_ABORTED = "aborted"
TEST_FAILED = "failed"
TEST_STATUSES = (TEST_RUNNING, TEST_COMPLETED, TEST_ABORTED, TEST_FAILED)

# Reason why the sampling window ended (field `finish_reason`).
FINISH_DURATION_ELAPSED = "duration_elapsed"   # the requested window ended normally
FINISH_TEST_FLAG_CLEARED = "test_flag_cleared" # the UPS cleared the TEST flag before the end
FINISH_ABORTED = "aborted"                     # abort requested by the client
FINISH_TARGET_REACHED = "target_percent_reached"  # percentage target reached (discharge test)
FINISH_BATTERY_LOW = "battery_low"             # LB flag appeared (safety guard)
FINISH_WATCHDOG = "watchdog"                   # maximum time limit reached
FINISH_STOPPING = "stopping"                   # service shutting down
FINISH_SERIAL_ERROR = "serial_error"           # sending the test command failed


@dataclass(frozen=True)
class TestSample:
    """A high-frequency sample captured during the test window.

    It forms the point of the test TIMELINE: `offset_s` is the X axis and the
    columns of `normalized` are the Y axes of the variation charts (output
    voltage/frequency, temperature, battery charge) in the consumer service.
    """

    offset_s: float          # seconds since the start of the window
    measurements: dict
    status: dict
    battery: dict | None     # common summary {charge_percent, voltage_v} (may be absent)
    normalized: dict | None = None  # normalized metrics (protocol-independent)

    def to_dict(self) -> dict:
        data = {
            "offset_s": self.offset_s,
            "measurements": dict(self.measurements),
            "status": dict(self.status),
        }
        if self.battery is not None:
            data["battery"] = dict(self.battery)
        if self.normalized is not None:
            data["normalized"] = dict(self.normalized)
        return data


@dataclass
class BatteryTest:
    """A battery test (execution + predictability report).

    The object is mutable: it is created as `running` on the request and filled by
    the collector throughout the sampling window.
    """

    test_id: str
    device_id: str
    test_type: str
    status: str
    started_at: object          # datetime UTC (when the client requested it)
    expected_end_at: object     # datetime UTC
    requested_duration_s: float | None   # None in the test that ends by percentage target
    sample_interval_s: float
    target_percent: float | None = None  # charge target (discharge test); None = fixed window
    timeout_s: float | None = None       # safety ceiling of the window (watchdog)
    ended_at: object = None
    duration_s: float | None = None      # window actually sampled
    finish_reason: str | None = None
    baseline: dict | None = None         # last reading BEFORE the test
    final: dict | None = None            # last sample of the window
    deltas: dict | None = None           # per-metric statistics
    estimate: dict | None = None         # runtime predictability (1st order)
    flags_seen: list = field(default_factory=list)
    test_flag_observed: bool = False
    samples: list = field(default_factory=list)
    error: dict | None = None

    def summary_dict(self) -> dict:
        """Short view (for listings), without the sample series."""
        return {
            "test_id": self.test_id,
            "type": self.test_type,
            "status": self.status,
            "started_at_utc": iso_utc(self.started_at),
            "expected_end_at_utc": iso_utc(self.expected_end_at),
            "ended_at_utc": iso_utc(self.ended_at),
            "duration_s": self.duration_s,
            "target_percent": self.target_percent,
            "finish_reason": self.finish_reason,
            "samples_count": len(self.samples),
            "flags_seen": list(self.flags_seen),
            "estimate": self.estimate,
            "error": self.error,
        }

    def to_dict(self, include_samples: bool = True) -> dict:
        data = {
            "test_id": self.test_id,
            "device_id": self.device_id,
            "type": self.test_type,
            "status": self.status,
            "started_at_utc": iso_utc(self.started_at),
            "expected_end_at_utc": iso_utc(self.expected_end_at),
            "ended_at_utc": iso_utc(self.ended_at),
            "requested_duration_s": self.requested_duration_s,
            "duration_s": self.duration_s,
            "sample_interval_s": self.sample_interval_s,
            "target_percent": self.target_percent,
            "timeout_s": self.timeout_s,
            "finish_reason": self.finish_reason,
            "test_flag_observed": self.test_flag_observed,
            "flags_seen": list(self.flags_seen),
            "baseline": self.baseline,
            "final": self.final,
            "deltas": self.deltas,
            "estimate": self.estimate,
            "samples_count": len(self.samples),
            "error": self.error,
        }
        if include_samples:
            data["samples"] = [sample.to_dict() for sample in self.samples]
        return data
