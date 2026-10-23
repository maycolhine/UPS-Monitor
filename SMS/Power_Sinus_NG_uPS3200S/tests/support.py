"""Test support: controlled clock, fake serial link and object factories.

The frames below are REAL responses captured from the SMS Power Sinus NG uPS3200S
(SMS Brazil 1Phase protocol) — see docs/sms-1phase-protocol.md and Spec.md.
"""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from api import protocol
from api.config import Config
from api.serial_link import LinkError


def _frame(start: int, body: bytes) -> bytes:
    """Build an 18-byte frame with the protocol checksum."""
    payload = bytes([start]) + body
    assert len(payload) == 16, len(payload)
    return payload + bytes([protocol.frame_checksum(payload), protocol.RESPONSE_TERMINATOR])


# Body of the real Q frame captured from the device (15 bytes, indexes 1..15):
# voltages ~217.7 V, load 20.0 %, freq 59.9 Hz, battery 100 %, 49.1 C,
# status 0x29 = 00101001 (BEEP + UPSOK + BYPASS).
_STATUS_BODY = bytes.fromhex("00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29")
STATUS_FRAME_OK = _frame(0x3D, _STATUS_BODY)
# Same frame, with the TEST bit (b2) active -> status 0x2d = 00101101.
STATUS_FRAME_TEST = _frame(0x3D, _STATUS_BODY[:14] + bytes([0x2D]))
# Same frame, with the load (bytes 7..8) outside the plausible range (6553.5 %).
STATUS_FRAME_OUT_OF_RANGE = _frame(
    0x3D, bytes.fromhex("00 00 08 81 08 81 ff ff 02 57 03 e8 01 eb 29")
)
# Same valid frame, with the checksum byte corrupted.
STATUS_FRAME_BAD_CHECKSUM = STATUS_FRAME_OK[:16] + bytes([0x00, protocol.RESPONSE_TERMINATOR])

# Real responses to the I and F commands (18 bytes, terminated with CR).
IDENT_FRAME = bytes.fromhex("3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d")
RATINGS_FRAME = bytes.fromhex("3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d")


class FakeClock:
    """Controllable clock for testing age, staleness and log deduplication."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 10, 22, 12, 0, 0, tzinfo=timezone.utc)
        self.monotonic_value = 1000.0

    def utcnow(self) -> datetime:
        return self.current

    def monotonic(self) -> float:
        return self.monotonic_value

    def advance(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)
        self.monotonic_value += seconds


class FakeLink:
    """Fake serial link: returns ready-made responses and records the commands sent."""

    def __init__(self, responses: dict | None = None, default=None):
        self.port = "/dev/fake0"
        self.commands: list[str] = []
        self._responses = dict(responses or {})
        self._default = default

    def set_response(self, command: str, response) -> None:
        self._responses[command] = response

    def close(self) -> None:
        pass

    def query(self, command: str) -> bytes:
        self.commands.append(command)
        response = self._responses.get(command, self._default)
        if isinstance(response, Exception):
            raise response
        if response is None:
            raise LinkError("timeout", f"no response to command {command!r} (fake link)")
        return response


def good_link(**overrides) -> FakeLink:
    responses = {"Q": STATUS_FRAME_OK, "I": IDENT_FRAME, "F": RATINGS_FRAME}
    responses.update(overrides)
    return FakeLink(responses=responses)


def make_config(**overrides) -> Config:
    values = {"device_id": "sms-ups3200s-01", "poll_interval_s": 5.0, "stale_after_s": 20.0}
    values.update(overrides)
    return Config(**values)


class StubCollector:
    """Replaces the collector in the HTTP layer tests (deterministic snapshot)."""

    def __init__(self, snapshot, alive: bool = True):
        self._snapshot = dataclasses.replace(snapshot, collector_alive=alive)
        self.calls = 0

    def snapshot(self):
        self.calls += 1
        return self._snapshot
