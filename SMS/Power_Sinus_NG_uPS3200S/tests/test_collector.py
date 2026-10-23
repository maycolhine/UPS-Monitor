"""Collector tests: in-memory state, classified failures and log deduplication."""
from __future__ import annotations

import logging
import unittest

from api.collector import Collector
from api.serial_link import DisconnectedError, LinkError, PortUnavailableError, ResponseTimeoutError
from tests.support import (
    IDENT_FRAME,
    RATINGS_FRAME,
    STATUS_FRAME_OK,
    FakeClock,
    FakeLink,
    good_link,
    make_config,
)


class RecordingHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


def capture_logs(logger_name="sms.collector"):
    handler = RecordingHandler()
    logger = logging.getLogger(logger_name)
    level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    return handler, logger, level


def build_collector(link, clock=None, config=None):
    clock = clock or FakeClock()
    collector = Collector(
        config or make_config(), link=link, now=clock.utcnow, monotonic=clock.monotonic
    )
    return collector, clock


class CollectorSuccessTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.link = good_link()
        self.collector, self.clock = build_collector(self.link, self.clock)

    def test_valid_collection_builds_telemetry(self):
        telemetry = self.collector.collect_once()

        self.assertIsNotNone(telemetry)
        self.assertEqual(telemetry.input_voltage_v, 217.7)
        self.assertEqual(telemetry.output_voltage_v, 217.7)
        self.assertEqual(telemetry.load_percent, 20.0)
        self.assertEqual(telemetry.battery_charge_percent, 100.0)
        self.assertEqual(telemetry.battery_voltage_v, 24.0)
        self.assertEqual(telemetry.battery_packs, 2)
        self.assertEqual(telemetry.status_active, ["BEEP", "UPSOK", "BYPASS"])
        self.assertEqual(telemetry.source, "sms-1phase")
        self.assertEqual(self.link.commands, ["Q", "I", "F"])

    def test_in_memory_state_after_success(self):
        self.collector.collect_once()
        snapshot = self.collector.snapshot()

        self.assertEqual(snapshot.state.state, "ok")
        self.assertTrue(snapshot.state.telemetry_valid)
        self.assertFalse(snapshot.state.stale)
        self.assertEqual(snapshot.state.consecutive_failures, 0)
        self.assertEqual(snapshot.state.total_attempts, 1)
        self.assertEqual(snapshot.state.total_successes, 1)
        self.assertIsNone(snapshot.state.last_error)
        self.assertEqual(snapshot.state.age_seconds, 0.0)
        self.assertTrue(snapshot.identity.available)
        self.assertEqual(snapshot.identity.model, "Power Sinus")
        self.assertEqual(snapshot.identity.nominal_battery_voltage_v, 24)

    def test_identification_not_reread_each_cycle(self):
        self.collector.collect_once()
        self.clock.advance(5)
        self.collector.collect_once()

        self.assertEqual(self.link.commands, ["Q", "I", "F", "Q"])

    def test_snapshot_does_not_trigger_serial_collection(self):
        self.collector.collect_once()
        commands = list(self.link.commands)

        for _ in range(3):
            self.collector.snapshot()

        self.assertEqual(self.link.commands, commands)


class CollectorFailureTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()

    def test_timeout_does_not_produce_telemetry(self):
        collector, _ = build_collector(FakeLink(default=ResponseTimeoutError("no response")), self.clock)
        self.assertIsNone(collector.collect_once())

        snapshot = collector.snapshot()
        self.assertIsNone(snapshot.telemetry)
        self.assertEqual(snapshot.state.state, "timeout")
        self.assertEqual(snapshot.state.last_error.code, "timeout")
        self.assertEqual(snapshot.state.consecutive_failures, 1)
        self.assertFalse(snapshot.state.telemetry_valid)

    def test_invalid_response_is_classified(self):
        link = FakeLink(responses={"Q": b"STRANGE RESPONSE", "I": None, "F": None})
        collector, _ = build_collector(link, self.clock)
        collector.collect_once()

        snapshot = collector.snapshot()
        self.assertEqual(snapshot.state.state, "invalid_response")
        self.assertIn("does not start", snapshot.state.last_error.message)

    def test_invalid_checksum_is_classified(self):
        from tests.support import STATUS_FRAME_BAD_CHECKSUM

        link = FakeLink(responses={"Q": STATUS_FRAME_BAD_CHECKSUM, "I": None, "F": None})
        collector, _ = build_collector(link, self.clock)
        collector.collect_once()

        self.assertEqual(collector.snapshot().state.state, "checksum_error")

    def test_port_failure_codes(self):
        for error in (
            PortUnavailableError("UPS serial port not found"),
            DisconnectedError("USB connection lost"),
            LinkError("serial_error", "I/O failure"),
        ):
            collector, _ = build_collector(FakeLink(default=error), self.clock)
            collector.collect_once()
            self.assertEqual(collector.snapshot().state.state, error.code)

    def test_last_valid_reading_is_preserved_and_becomes_stale(self):
        link = good_link()
        collector, clock = build_collector(link, self.clock)
        self.assertIsNotNone(collector.collect_once())

        clock.advance(30)  # above stale_after_s = 20
        link.set_response("Q", ResponseTimeoutError("no response"))
        self.assertIsNone(collector.collect_once())

        snapshot = collector.snapshot()
        self.assertIsNotNone(snapshot.telemetry)  # last reading preserved
        self.assertEqual(snapshot.telemetry.input_voltage_v, 217.7)
        self.assertTrue(snapshot.state.stale)
        self.assertFalse(snapshot.state.telemetry_valid)
        self.assertEqual(snapshot.state.state, "stale")
        self.assertGreater(snapshot.state.age_seconds, 20)

    def test_identification_failure_does_not_invalidate_telemetry(self):
        link = good_link(I=LinkError("invalid_response", "no identification frame"))
        collector, _ = build_collector(link, self.clock)

        telemetry = collector.collect_once()
        snapshot = collector.snapshot()

        self.assertIsNotNone(telemetry)
        self.assertEqual(snapshot.state.state, "ok")
        self.assertIsNone(snapshot.identity)


class CollectorLoggingTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.handler, self.logger, self.level = capture_logs()

    def tearDown(self):
        self.logger.removeHandler(self.handler)
        self.logger.setLevel(self.level)

    def _records(self, level):
        return [record for record in self.handler.records if record.levelno == level]

    def test_same_failure_does_not_repeat_in_consecutive_cycles(self):
        collector, clock = build_collector(
            FakeLink(default=ResponseTimeoutError("no response")), self.clock
        )
        for _ in range(3):
            collector.collect_once()
            clock.advance(5)

        self.assertEqual(len(self._records(logging.WARNING)), 1)

        clock.advance(400)  # above the minimum interval of 300 s
        collector.collect_once()
        self.assertEqual(len(self._records(logging.WARNING)), 2)

    def test_recovery_is_logged(self):
        link = FakeLink(default=ResponseTimeoutError("no response"))
        collector, clock = build_collector(link, self.clock)
        collector.collect_once()

        link.set_response("Q", STATUS_FRAME_OK)
        link.set_response("I", IDENT_FRAME)
        link.set_response("F", RATINGS_FRAME)
        clock.advance(5)
        collector.collect_once()

        messages = [record.getMessage() for record in self._records(logging.INFO)]
        self.assertTrue(any("restored" in message for message in messages), messages)

    def test_first_reading_and_heartbeat_logged(self):
        collector, clock = build_collector(good_link(), self.clock)
        for _ in range(2):
            collector.collect_once()
            clock.advance(5)

        messages = [record.getMessage() for record in self._records(logging.INFO)]
        # the first cycle logs "first valid telemetry" and the initial identity;
        # the second cycle must generate neither a heartbeat nor a new first reading.
        self.assertEqual(sum("first valid telemetry" in message for message in messages), 1)
        self.assertFalse(any("collection active" in message for message in messages), messages)


if __name__ == "__main__":
    unittest.main()
