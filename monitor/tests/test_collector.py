"""Collector tests: common envelope, in-memory state and classified failures.

Includes the unified API USE case: two devices with different protocols
collected in isolation (the failure of one does not affect the other).
"""
from __future__ import annotations

import unittest

from upsmon.collector import (
    DEFAULT_TEST_TYPE,
    SUPPORTED_TEST_TYPES,
    BatteryTestError,
    Collector,
)
from upsmon.serial_link import (
    DisconnectedError,
    LinkError,
    PortUnavailableError,
    ResponseTimeoutError,
)
from tests.support import (
    SMS_IDENT_FRAME,
    SMS_RATINGS_FRAME,
    SMS_STATUS_BAD_CHECKSUM,
    SMS_STATUS_OK,
    FakeClock,
    FakeLink,
    FakeSleeper,
    megatec_device,
    megatec_link,
    megatec_status,
    sms_device,
    sms_link,
    sms_status,
)

TEST_OPTS = {"allow_battery_test": "true", "test_sample_interval_s": "0.5"}


def build(device, link, clock):
    return Collector(device, link=link, now=clock.utcnow, monotonic=clock.monotonic)


class SmsCollectorTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.link = sms_link()
        self.collector = build(sms_device(), self.link, self.clock)

    def test_valid_collection_builds_the_common_envelope(self):
        telemetry = self.collector.collect_once()

        self.assertIsNotNone(telemetry)
        self.assertEqual(telemetry.source, "sms-1phase")
        self.assertEqual(telemetry.measurements["input_voltage_v"], 217.7)
        self.assertEqual(telemetry.measurements["output_frequency_hz"], 59.9)
        self.assertEqual(telemetry.battery["charge_percent"], 100.0)
        self.assertIsNone(telemetry.battery_charge)
        self.assertEqual(telemetry.status["active"], ["BEEP", "UPSOK", "BYPASS"])
        self.assertEqual(self.link.commands, ["Q", "I", "F"])

    def test_state_after_success(self):
        self.collector.collect_once()
        snapshot = self.collector.snapshot()

        self.assertEqual(snapshot.state.state, "ok")
        self.assertTrue(snapshot.state.telemetry_valid)
        self.assertFalse(snapshot.state.stale)
        self.assertEqual(snapshot.state.total_successes, 1)
        self.assertIsNone(snapshot.state.last_error)
        self.assertTrue(snapshot.identity.available)
        self.assertEqual(snapshot.identity.device["model"], "Power Sinus")

    def test_identity_is_not_reread_every_cycle(self):
        self.collector.collect_once()
        self.clock.advance(5)
        self.collector.collect_once()

        self.assertEqual(self.link.commands, ["Q", "I", "F", "Q"])

    def test_snapshot_does_not_trigger_serial_read(self):
        self.collector.collect_once()
        commands = list(self.link.commands)
        for _ in range(3):
            self.collector.snapshot()
        self.assertEqual(self.link.commands, commands)


class MegatecCollectorTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.link = megatec_link()
        self.collector = build(megatec_device(), self.link, self.clock)

    def test_valid_collection_builds_the_common_envelope(self):
        telemetry = self.collector.collect_once()

        self.assertEqual(telemetry.source, "megatec-q1")
        self.assertEqual(telemetry.measurements["input_voltage_v"], 228.0)
        self.assertEqual(telemetry.measurements["input_frequency_hz"], 60.0)
        self.assertIsNone(telemetry.battery)
        self.assertAlmostEqual(telemetry.battery_charge["percent"], 55.2, delta=0.2)
        self.assertEqual(telemetry.status["active"], ["OB", "STANDBY", "BEEP"])
        self.assertEqual(self.link.commands, ["Q1", "I", "F"])

    def test_identity_available(self):
        self.collector.collect_once()
        identity = self.collector.snapshot().identity

        self.assertEqual(identity.device["manufacturer"], "TS SHARA")
        self.assertEqual(identity.device["model"], "SENO3.2kVA")
        self.assertEqual(identity.nominal["voltage_v"], 115.0)


class CollectorFailureTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()

    def _snapshot(self, device, link):
        collector = build(device, link, self.clock)
        collector.collect_once()
        return collector.snapshot()

    def test_timeout_produces_no_telemetry(self):
        snapshot = self._snapshot(sms_device(), FakeLink(default=ResponseTimeoutError("no response")))

        self.assertIsNone(snapshot.telemetry)
        self.assertEqual(snapshot.state.state, "timeout")
        self.assertEqual(snapshot.state.last_error.code, "timeout")
        self.assertEqual(snapshot.state.consecutive_failures, 1)
        self.assertFalse(snapshot.state.telemetry_valid)

    def test_invalid_checksum_is_classified(self):
        link = FakeLink(responses={"Q": SMS_STATUS_BAD_CHECKSUM, "I": None, "F": None})
        self.assertEqual(self._snapshot(sms_device(), link).state.state, "checksum_error")

    def test_port_failure_codes(self):
        for error in (
            PortUnavailableError("UPS serial port not found"),
            DisconnectedError("USB connection lost"),
            LinkError("serial_error", "I/O failure"),
        ):
            with self.subTest(code=error.code):
                snapshot = self._snapshot(sms_device(), FakeLink(default=error))
                self.assertEqual(snapshot.state.state, error.code)

    def test_last_valid_reading_is_preserved_and_becomes_stale(self):
        link = sms_link()
        collector = build(sms_device(), link, self.clock)
        self.assertIsNotNone(collector.collect_once())

        self.clock.advance(30)  # above stale_after_s = 20
        link.set_response("Q", ResponseTimeoutError("no response"))
        self.assertIsNone(collector.collect_once())

        snapshot = collector.snapshot()
        self.assertIsNotNone(snapshot.telemetry)
        self.assertEqual(snapshot.telemetry.measurements["input_voltage_v"], 217.7)
        self.assertTrue(snapshot.state.stale)
        self.assertFalse(snapshot.state.telemetry_valid)
        self.assertEqual(snapshot.state.state, "stale")
        self.assertGreater(snapshot.state.age_seconds, 20)

    def test_identity_failure_does_not_invalidate_telemetry(self):
        link = sms_link(I=LinkError("invalid_response", "no identification frame"))
        collector = build(sms_device(), link, self.clock)

        self.assertIsNotNone(collector.collect_once())
        snapshot = collector.snapshot()
        self.assertEqual(snapshot.state.state, "ok")
        self.assertIsNone(snapshot.identity)


class MultiDeviceIsolationTest(unittest.TestCase):
    """The unified API must not let one device affect the other."""

    def setUp(self):
        self.clock = FakeClock()
        self.sms = build(sms_device(), sms_link(), self.clock)
        # the TS Shara has the cable unplugged (port unavailable)
        self.megatec = build(
            megatec_device(),
            FakeLink(default=PortUnavailableError("serial port not found")),
            self.clock,
        )

    def test_one_failed_device_does_not_affect_the_other(self):
        self.assertIsNotNone(self.sms.collect_once())
        self.assertIsNone(self.megatec.collect_once())

        self.assertEqual(self.sms.snapshot().state.state, "ok")
        self.assertTrue(self.sms.snapshot().state.telemetry_valid)
        self.assertEqual(self.megatec.snapshot().state.state, "port_unavailable")
        self.assertFalse(self.megatec.snapshot().state.telemetry_valid)

    def test_recovery_of_the_failed_device(self):
        self.megatec.collect_once()  # failure
        self.megatec._link = megatec_link()  # cable reconnected
        self.assertIsNotNone(self.megatec.collect_once())

        snapshot = self.megatec.snapshot()
        self.assertEqual(snapshot.state.state, "ok")
        self.assertEqual(snapshot.state.consecutive_failures, 0)
        self.assertIsNone(snapshot.state.last_error)


def dynamic_sms(charge_step: float = 0.5, load_step: float = 0.5, test_flag_off_after=None):
    """SMS status that varies on every reading (simulates the battery test window).

    The charge drops `charge_step` pp and the load rises `load_step` pp per reading;
    the output voltage alternates +/-0.3 V. `test_flag_off_after=N` turns the TEST
    flag off from reading N onwards (to exercise ending by `test_flag_cleared`).
    """
    state = {"n": 0}

    def status(_command):
        index = state["n"]
        state["n"] += 1
        status_byte = 0x2D  # BEEP + TEST + UPSOK + BYPASS
        if test_flag_off_after is not None and index >= test_flag_off_after:
            status_byte = 0x29  # without TEST
        return sms_status(
            charge_percent=max(0.0, 100.0 - index * charge_step),
            load_percent=20.0 + index * load_step,
            output_voltage_v=217.7 + (0.3 if index % 2 else -0.3),
            status_byte=status_byte,
        )

    return status


class BatteryTestFlowTest(unittest.TestCase):
    """~10 s battery test run inside the collector loop itself (no hardware)."""

    def setUp(self):
        self.clock = FakeClock()
        self.sleeper = FakeSleeper(self.clock)

    def _collector(self, device, link):
        return Collector(
            device,
            link=link,
            now=self.clock.utcnow,
            monotonic=self.clock.monotonic,
            sleep=self.sleeper,
        )

    def _run_test(self, charge_for_index):
        """Runs a window test whose battery charge follows the reading index."""
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()  # fresh telemetry before the window

        state = {"n": 0}

        def charge(_command):
            index = state["n"]
            state["n"] += 1
            return sms_status(charge_percent=charge_for_index(index), status_byte=0x2D)

        link.set_response("Q", charge)
        test_id = collector.request_test()["test_id"]
        collector.collect_once()
        return collector.test_report(test_id)

    def test_full_sms_flow_generates_the_predictability_report(self):
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()  # fresh telemetry (battery 100 %)

        link.set_response("Q", dynamic_sms())
        request = collector.request_test()

        self.assertEqual(request["type"], DEFAULT_TEST_TYPE)
        self.assertEqual(request["status"], "running")
        self.assertTrue(request["report_url"].endswith(request["test_id"]))
        # the request does NOT touch the serial: the action command is sent in the collector loop
        self.assertEqual(link.actions, [])

        self.assertIsNotNone(collector.collect_once())
        # the test carries the duration in the command (Param1) and the end of the
        # window sends the abort (D), otherwise the UPS would keep testing (incident T10)
        self.assertEqual(link.actions, ["T", "D"])
        self.assertEqual(link.action_durations, [10.0, None])

        report = collector.test_report(request["test_id"])
        self.assertEqual(report.status, "completed")
        self.assertEqual(report.finish_reason, "duration_elapsed")
        self.assertAlmostEqual(report.duration_s, 10.0, delta=0.6)
        self.assertGreaterEqual(len(report.samples), 15)
        self.assertTrue(report.test_flag_observed)
        self.assertIn("TEST", report.flags_seen)

        # baseline = reading before the test; final = last sample of the window
        self.assertEqual(report.baseline["battery_charge_percent"], 100.0)
        self.assertEqual(report.final["battery_charge_percent"], 90.0)

        metrics = report.deltas["metrics"]
        self.assertEqual(metrics["battery_charge_percent"]["delta"], -10.0)
        self.assertEqual(metrics["load_percent"]["delta"], 10.0)
        self.assertAlmostEqual(metrics["output_voltage_v"]["ripple"], 0.6, delta=0.05)
        self.assertAlmostEqual(metrics["output_voltage_v"]["max_abs_deviation"], 0.6, delta=0.05)

        estimate = report.estimate
        self.assertTrue(estimate["available"])
        self.assertEqual(estimate["confidence"], "low")
        self.assertEqual(estimate["method"], "linear_regression_trimmed")
        self.assertAlmostEqual(estimate["estimated_runtime_min"], 1.7, delta=0.3)

    def test_estimate_ignores_the_initial_abrupt_battery_drop(self):
        """The initial transient (abrupt drop) must not dictate the runtime.

        The series drops from 100 % to 70 % in ~1 s and then stays stable; before,
        the drop entered the rate and the runtime came out as a few minutes (33 s in
        this series). With the transient trimmed there is no measurable drop left and
        the API returns `available: false` instead of an alarming number.
        """
        report = self._run_test(lambda index: 100.0 - index * 15.0 if index <= 2 else 70.0)

        # the raw drop of the window is still reported in `deltas`...
        self.assertEqual(report.deltas["metrics"]["battery_charge_percent"]["delta"], -30.0)
        # ...but the runtime does not extrapolate the transient.
        self.assertFalse(report.estimate["available"])
        self.assertNotIn("estimated_runtime_min", report.estimate)

    def test_estimate_uses_the_discharge_after_the_transient(self):
        """Once the initial step is discarded, the rate reflects the real discharge of the window."""
        report = self._run_test(
            lambda index: 100.0 if index == 0 else (80.0 if index == 1 else 80.0 - 0.5 * (index - 2))
        )

        estimate = report.estimate
        self.assertTrue(estimate["available"])
        self.assertEqual(estimate["method"], "linear_regression_trimmed")
        self.assertEqual(estimate["transient_readings_dropped"], 1)
        # the 100 % -> 80 % step is ignored: what remains is the 0.5 pp / 0.5 s discharge
        self.assertAlmostEqual(estimate["discharge_rate_pp_per_min"], 60.0, delta=3.0)
        self.assertAlmostEqual(estimate["estimated_runtime_min"], 1.2, delta=0.3)

    def test_abort_interrupts_the_window_and_sends_the_abort(self):
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()
        link.set_response("Q", dynamic_sms())
        test_id = collector.request_test()["test_id"]

        holder = {"armed": True}

        def sleeper(seconds):
            self.clock.advance(seconds)
            if holder["armed"]:
                holder["armed"] = False
                collector.abort_test(test_id)

        collector._sleep = sleeper
        collector.collect_once()

        report = collector.test_report(test_id)
        self.assertEqual(report.status, "aborted")
        self.assertEqual(report.finish_reason, "aborted")
        self.assertLess(report.duration_s, 10.0)
        self.assertEqual(link.actions, ["T", "D"])  # the SMS knows how to abort (D)

    def test_megatec_has_no_abort_only_stops_sampling(self):
        link = megatec_link(Q1=megatec_status(status_bits="00001001"))
        collector = self._collector(megatec_device(**TEST_OPTS), link)
        collector.collect_once()
        test_id = collector.request_test()["test_id"]

        holder = {"armed": True}

        def sleeper(seconds):
            self.clock.advance(seconds)
            if holder["armed"]:
                holder["armed"] = False
                collector.abort_test(test_id)

        collector._sleep = sleeper
        collector.collect_once()

        report = collector.test_report(test_id)
        self.assertEqual(report.status, "aborted")
        self.assertEqual(link.actions, ["T"])  # there is no abort command

    def test_ends_when_the_test_flag_disappears(self):
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()
        link.set_response("Q", dynamic_sms(test_flag_off_after=4))

        test_id = collector.request_test()["test_id"]
        collector.collect_once()

        report = collector.test_report(test_id)
        self.assertEqual(report.status, "completed")
        self.assertEqual(report.finish_reason, "test_flag_cleared")
        self.assertLess(report.duration_s, 10.0)

    def test_target_test_ends_at_20pct_and_sends_the_abort(self):
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()  # fresh telemetry (battery 100 %)

        link.set_response("Q", dynamic_sms(charge_step=5.0))
        request = collector.request_test("discharge_20pct")

        self.assertEqual(request["type"], "discharge_20pct")
        self.assertIsNone(request["requested_duration_s"])  # no window: ends by the target
        self.assertEqual(request["target_percent"], 20.0)
        self.assertEqual(request["timeout_s"], 1800.0)
        self.assertEqual(link.actions, [])  # the request does not touch the serial

        self.assertIsNotNone(collector.collect_once())

        report = collector.test_report(request["test_id"])
        self.assertEqual(report.status, "completed")
        self.assertEqual(report.finish_reason, "target_percent_reached")
        self.assertEqual(report.final["battery_charge_percent"], 20.0)
        self.assertEqual(link.actions, ["T", "D"])  # without D the battery would keep dropping

        # the timeline carries the normalized columns of the variation charts
        first = report.samples[0].normalized
        last = report.samples[-1].normalized
        self.assertEqual(first["battery_charge_percent"], 100.0)
        self.assertEqual(last["battery_charge_percent"], 20.0)
        self.assertIn("output_voltage_v", first)
        self.assertIn("frequency_hz", first)
        self.assertIn("temperature_c", first)

    def test_target_test_respects_the_safety_ceiling(self):
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()

        # the reported charge does NOT drop: the safety ceiling ends the test and the
        # abort is sent (it does not wait for the battery to drop on its own).
        link.set_response("Q", dynamic_sms(charge_step=0.0, load_step=0.0))
        request = collector.request_test("discharge_20pct")
        self.assertIsNotNone(collector.collect_once())

        report = collector.test_report(request["test_id"])
        self.assertEqual(report.status, "completed")
        self.assertEqual(report.finish_reason, "watchdog")
        self.assertAlmostEqual(report.duration_s, 1800.0, delta=3.0)
        self.assertEqual(link.actions, ["T", "D"])

    def test_in_memory_history_lists_the_most_recent_test_first(self):
        link = sms_link()
        collector = self._collector(sms_device(**TEST_OPTS), link)
        collector.collect_once()
        link.set_response("Q", dynamic_sms())

        first = collector.request_test()["test_id"]
        collector.collect_once()
        self.clock.advance(600)  # passes the cooldown (the telemetry becomes stale)
        collector.collect_once()  # refreshes the telemetry before the 2nd request
        second = collector.request_test()["test_id"]
        collector.collect_once()

        listed = [report.test_id for report in collector.test_list()]
        self.assertEqual(listed, [second, first])


class BatteryTestPreconditionsTest(unittest.TestCase):
    """Refusals are decided in memory, before any serial access."""

    def setUp(self):
        self.clock = FakeClock()
        self.sleeper = FakeSleeper(self.clock)

    def _collector(self, device, link):
        return Collector(
            device,
            link=link,
            now=self.clock.utcnow,
            monotonic=self.clock.monotonic,
            sleep=self.sleeper,
        )

    def _ready(self, device=None, link=None):
        link = link or sms_link()
        collector = self._collector(device or sms_device(**TEST_OPTS), link)
        collector.collect_once()
        return collector, link

    def test_device_capabilities(self):
        collector, _ = self._ready()
        capabilities = collector.test_capabilities()

        self.assertTrue(capabilities["supported"])
        self.assertTrue(capabilities["enabled"])
        self.assertEqual(capabilities["test_types"], list(SUPPORTED_TEST_TYPES))
        self.assertTrue(capabilities["abort_supported"])

    def test_refuses_unknown_test_type(self):
        collector, _ = self._ready()
        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test("duration_60s")

        self.assertEqual(ctx.exception.code, "unsupported_test_type")
        self.assertEqual(ctx.exception.http_status, 422)

    def test_target_discharge_does_not_exist_without_abort(self):
        # the TS Shara does not know how to abort the test: without it there is no target test
        link = megatec_link()
        collector, _ = self._ready(device=megatec_device(**TEST_OPTS), link=link)

        capabilities = collector.test_capabilities()
        self.assertEqual(capabilities["test_types"], ["duration_10s"])
        self.assertFalse(capabilities["abort_supported"])

        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test("discharge_20pct")

        self.assertEqual(ctx.exception.code, "unsupported_test_type")
        self.assertEqual(ctx.exception.http_status, 422)

    def test_refuses_discharge_when_charge_is_already_at_target(self):
        link = sms_link(Q=sms_status(charge_percent=18.0))
        collector, _ = self._ready(
            device=sms_device(**TEST_OPTS, test_min_battery_percent="10"), link=link
        )
        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test("discharge_20pct")

        self.assertEqual(ctx.exception.code, "battery_at_target")
        self.assertEqual(ctx.exception.http_status, 409)

    def test_refuses_when_test_is_disabled(self):
        collector, _ = self._ready(device=sms_device())  # without allow_battery_test
        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test()

        self.assertEqual(ctx.exception.code, "test_disabled")
        self.assertEqual(ctx.exception.http_status, 403)

    def test_refuses_without_valid_telemetry(self):
        collector = self._collector(sms_device(**TEST_OPTS), sms_link())
        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test()

        self.assertEqual(ctx.exception.code, "test_unavailable")
        self.assertEqual(ctx.exception.http_status, 409)

    def test_refuses_with_low_battery_charge(self):
        link = sms_link(Q=sms_status(charge_percent=40.0))
        collector, _ = self._ready(link=link)
        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test()

        self.assertEqual(ctx.exception.code, "battery_too_low")
        self.assertEqual(ctx.exception.http_status, 409)

    def test_refuses_when_a_test_is_already_in_progress(self):
        collector, _ = self._ready()
        collector.request_test()
        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test()

        self.assertEqual(ctx.exception.code, "test_in_progress")
        self.assertEqual(ctx.exception.http_status, 409)

    def test_cooldown_between_tests(self):
        link = sms_link()
        collector, _ = self._ready(link=link)
        link.set_response("Q", dynamic_sms())
        collector.request_test()
        collector.collect_once()

        with self.assertRaises(BatteryTestError) as ctx:
            collector.request_test()

        self.assertEqual(ctx.exception.code, "test_cooldown")
        self.assertEqual(ctx.exception.http_status, 409)

    def test_abort_of_unknown_test_returns_none(self):
        collector, _ = self._ready()
        self.assertIsNone(collector.abort_test("nonexistent"))
        self.assertIsNone(collector.test_report("nonexistent"))


if __name__ == "__main__":
    unittest.main()
