"""Test support: controlled clock, fake serial link and object factories."""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from api.config import Config
from api.serial_link import LinkError

# Real device frames (Spec.md section 8).
Q1_FRAME_OK = "(228.0 228.0 115.0 009 60.0 23.8 26.0 10001001"
Q1_FRAME_TEST = "(228.0 228.0 115.0 093 60.0 19.8 26.0 10001101"
IDENT_FRAME = "#TS SHARA        SENO3.2kVA 26.000.000"
RATINGS_FRAME = "#115.0 100 24.00 60.0"


class FakeClock:
    """Controllable clock for testing age, staleness and deduplication."""

    def __init__(self, start: datetime | None = None):
        self.current = start or datetime(2026, 10, 21, 12, 0, 0, tzinfo=timezone.utc)
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

    def query(self, command: str) -> str:
        self.commands.append(command)
        response = self._responses.get(command, self._default)
        if isinstance(response, Exception):
            raise response
        if response is None:
            raise LinkError("timeout", f"no response to command {command!r} (fake link)")
        return response


def good_link(**overrides) -> FakeLink:
    responses = {"Q1": Q1_FRAME_OK, "I": IDENT_FRAME, "F": RATINGS_FRAME}
    responses.update(overrides)
    return FakeLink(responses=responses)


def make_config(**overrides) -> Config:
    values = {"device_id": "tsshara-3200va-01", "poll_interval_s": 5.0, "stale_after_s": 20.0}
    values.update(overrides)
    return Config(**values)


class StubCollector:
    """Replaces the collector in the HTTP-layer tests (deterministic snapshot)."""

    def __init__(self, snapshot, alive: bool = True):
        self._snapshot = dataclasses.replace(snapshot, collector_alive=alive)
        self.calls = 0

    def snapshot(self):
        self.calls += 1
        return self._snapshot
