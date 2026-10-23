"""Test support: controllable clock, fake serial link and object factories.

The SMS frames below are REAL responses captured from the SMS Power Sinus NG
uPS3200S (SMS Brazil 1Phase protocol); the Megatec/Q1 frames are those of the
TS Shara Universal UPS Senoidal 3200VA. See each model's docs.
"""
from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

from upsmon.collector import DEFAULT_TEST_TYPE
from upsmon.config import AppConfig, DeviceConfig
from upsmon.drivers.sms_1phase import RESPONSE_TERMINATOR
from upsmon.serial_link import LinkError

# ----------------------------- SMS frames (binary) -----------------------------
def _sms_frame(start: int, body: bytes) -> bytes:
    """Build an 18-byte frame with the SMS 1Phase protocol checksum."""
    payload = bytes([start]) + body
    assert len(payload) == 16, len(payload)
    checksum = (-sum(payload)) & 0xFF
    return payload + bytes([checksum, RESPONSE_TERMINATOR])


# body of the real Q frame: 217.7 V, load 20.0 %, freq 59.9 Hz, battery 100 %,
# 49.1 C, status 0x29 = 00101001 (BEEP + UPSOK + BYPASS).
_SMS_STATUS_BODY = bytes.fromhex("00 00 08 81 08 81 00 c8 02 57 03 e8 01 eb 29")
SMS_STATUS_OK = _sms_frame(0x3D, _SMS_STATUS_BODY)
SMS_STATUS_TEST = _sms_frame(0x3D, _SMS_STATUS_BODY[:14] + bytes([0x2D]))
SMS_STATUS_OUT_OF_RANGE = _sms_frame(
    0x3D, bytes.fromhex("00 00 08 81 08 81 ff ff 02 57 03 e8 01 eb 29")
)
SMS_STATUS_BAD_CHECKSUM = SMS_STATUS_OK[:16] + bytes([0x00, RESPONSE_TERMINATOR])
SMS_IDENT_FRAME = bytes.fromhex("3a 50 6f 77 65 72 20 53 69 6e 75 73 20 31 2e 32 d6 0d")
SMS_RATINGS_FRAME = bytes.fromhex("3b 32 32 30 20 20 20 20 30 30 30 20 32 34 36 30 35 0d")


def sms_status(
    charge_percent: float = 100.0,
    load_percent: float = 20.0,
    output_voltage_v: float = 217.7,
    frequency_hz: float = 59.9,
    temperature_c: float = 49.1,
    status_byte: int = 0x29,
) -> bytes:
    """Build an SMS Q frame with chosen values (to simulate the test)."""
    body = bytearray(_SMS_STATUS_BODY)

    def put(index: int, scaled: float) -> None:
        value = int(round(scaled))
        body[index] = (value >> 8) & 0xFF
        body[index + 1] = value & 0xFF

    put(4, output_voltage_v * 10)
    put(6, load_percent * 10)
    put(8, frequency_hz * 10)
    put(10, charge_percent * 10)
    put(12, temperature_c * 10)
    body[14] = status_byte
    return _sms_frame(0x3D, bytes(body))


# ----------------------------- Megatec frames (text) ---------------------------
MEGATEC_STATUS_OK = "(228.0 228.0 115.0 009 60.0 23.8 26.0 10001001"
MEGATEC_STATUS_TEST = "(228.0 228.0 115.0 093 60.0 19.8 26.0 10001101"
MEGATEC_IDENT_FRAME = "#TS SHARA        SENO3.2kVA 26.000.000"
MEGATEC_RATINGS_FRAME = "#115.0 100 24.00 60.0"


def megatec_status(
    input_voltage_v: float = 228.0,
    output_voltage_v: float = 115.0,
    load_percent: int = 9,
    input_frequency_hz: float = 60.0,
    battery_voltage_v: float = 23.8,
    temperature_c: float = 26.0,
    status_bits: str = "10001001",
) -> str:
    """Build a Q1 frame (Megatec) with chosen values (to simulate the test)."""
    return (
        f"({input_voltage_v:.1f} {input_voltage_v:.1f} {output_voltage_v:.1f} "
        f"{load_percent:03d} {input_frequency_hz:.1f} {battery_voltage_v:.1f} "
        f"{temperature_c:.1f} {status_bits}"
    )


class FakeClock:
    """Controllable clock to test age, staleness and deduplication."""

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


class FakeSleeper:
    """Simulated pause: advances the fake clock instead of really sleeping."""

    def __init__(self, clock: FakeClock):
        self.clock = clock
        self.total = 0.0
        self.calls = 0

    def __call__(self, seconds: float) -> None:
        self.calls += 1
        self.total += seconds
        self.clock.advance(seconds)


class FakeLink:
    """Fake serial link: returns ready-made responses and records the commands sent.

    A response may be bytes/str (frame), an exception (to simulate a failure) or
    a `f(command) -> frame` callable, useful to vary the measurements along a
    sequence of readings (e.g.: the charge drop during the battery test).
    """

    def __init__(self, responses: dict | None = None, default=None):
        self.port = "/dev/fake0"
        self.commands: list[str] = []
        self.actions: list[str] = []
        self.action_durations: list[float | None] = []
        self._responses = dict(responses or {})
        self._default = default

    def set_response(self, command: str, response) -> None:
        self._responses[command] = response

    def close(self) -> None:
        pass

    def query(self, command: str) -> bytes:
        self.commands.append(command)
        response = self._responses.get(command, self._default)
        if callable(response):
            response = response(command)
        if isinstance(response, Exception):
            raise response
        if response is None:
            raise LinkError("timeout", f"no response to command {command!r} (fake link)")
        return response

    def send_action(self, command: str, duration_s: float | None = None) -> None:
        """ACTION command (fire-and-forget): records and returns no response."""
        self.actions.append(command)
        self.action_durations.append(duration_s)
        self.commands.append(command)
        response = self._responses.get(command)
        if isinstance(response, Exception):
            raise response


def sms_link(**overrides) -> FakeLink:
    """Fake link of an SMS Power Sinus NG (commands Q/I/F)."""
    responses = {"Q": SMS_STATUS_OK, "I": SMS_IDENT_FRAME, "F": SMS_RATINGS_FRAME}
    responses.update(overrides)
    return FakeLink(responses=responses)


def megatec_link(**overrides) -> FakeLink:
    """Fake link of a TS Shara (commands Q1/I/F)."""
    responses = {"Q1": MEGATEC_STATUS_OK, "I": MEGATEC_IDENT_FRAME, "F": MEGATEC_RATINGS_FRAME}
    responses.update(overrides)
    return FakeLink(responses=responses)


def _device(base: dict, **overrides) -> DeviceConfig:
    """Build a DeviceConfig; unknown keys become `options` (as in the INI)."""
    options = dict(overrides.pop("options", {}))
    for key in list(overrides):
        if key not in DeviceConfig.__dataclass_fields__:
            options[key] = overrides.pop(key)
    fields = {"poll_interval_s": 5.0, "stale_after_s": 20.0, **base, **overrides}
    return DeviceConfig(options=options, **fields)


def sms_device(**overrides) -> DeviceConfig:
    base = {
        "device_id": "sms-ups3200s-01",
        "protocol": "sms-1phase",
        "brand": "SMS",
        "model": "Power Sinus NG uPS3200S",
    }
    return _device(base, **overrides)


def megatec_device(**overrides) -> DeviceConfig:
    base = {
        "device_id": "tsshara-3200va-01",
        "protocol": "megatec-q1",
        "brand": "TS Shara",
        "model": "Universal UPS Senoidal 3200VA",
    }
    return _device(base, **overrides)


def make_app_config(devices=None, **overrides) -> AppConfig:
    values = {"http_host": "127.0.0.1", "http_port": 0}
    values.update(overrides)
    return AppConfig(devices=list(devices if devices is not None else []), **values)


class StubCollector:
    """Replaces the collector in the HTTP layer tests (deterministic snapshot).

    Battery test queries are delegated to the real collector (`collector`),
    because they do not read the serial: they only validate preconditions and
    queue the request.
    """

    def __init__(self, snapshot, alive: bool = True, collector=None):
        self._snapshot = dataclasses.replace(snapshot, collector_alive=alive)
        self._collector = collector
        self.calls = 0

    def snapshot(self):
        self.calls += 1
        return self._snapshot

    def test_capabilities(self) -> dict:
        if self._collector is None:
            return {"supported": False, "enabled": False, "test_types": [], "abort_supported": False}
        return self._collector.test_capabilities()

    def request_test(self, test_type=DEFAULT_TEST_TYPE) -> dict:
        return self._collector.request_test(test_type)

    def abort_test(self, test_id: str):
        return self._collector.abort_test(test_id)

    def test_list(self, limit: int = 20):
        return self._collector.test_list(limit)

    def test_report(self, test_id: str):
        return self._collector.test_report(test_id)
