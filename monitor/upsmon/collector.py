"""Periodic collection loop and in-memory state (ONE collector per device).

Each collector is the only component that talks to the serial port of ITS OWN
device; the HTTP layer reads the state through snapshot(). No HTTP request
triggers a read, and the isolation between devices is total: a missing cable
does not affect the collection of the others.

Besides normal polling, the collector runs the BATTERY TEST, in two types:
`duration_10s` (fixed window, all protocols) and `discharge_20pct` (no window:
runs until the reported charge reaches 20 %, available only where the protocol
can abort the test). It is requested by the HTTP layer (`request_test`, which
only marks the intention) and run INSIDE the loop of this collector, on the same
thread that already owns the exclusive port: during the window the reading
becomes high frequency and the sampled series becomes a predictability report
(`BatteryTest`), with the timeline in `samples[]`. HTTP requests keep not touching
the serial port — they only read/enqueue the request under a lock.

There is no database: the last valid reading, the communication metadata and the
last battery tests are kept in memory.
"""
from __future__ import annotations

import dataclasses
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from .drivers import ProtocolError, create_driver
from .models import (
    FINISH_ABORTED,
    FINISH_BATTERY_LOW,
    FINISH_DURATION_ELAPSED,
    FINISH_SERIAL_ERROR,
    FINISH_STOPPING,
    FINISH_TARGET_REACHED,
    FINISH_TEST_FLAG_CLEARED,
    FINISH_WATCHDOG,
    TEST_ABORTED,
    TEST_COMPLETED,
    TEST_FAILED,
    TEST_RUNNING,
    BatteryTest,
    CollectionState,
    ErrorInfo,
    Identity,
    Snapshot,
    Telemetry,
    TestSample,
    iso_utc,
)
from .serial_link import LinkError

LOGGER = logging.getLogger("upsmon.collector")

# Minimum interval between two recordings of the SAME failure (avoids log spam).
FAILURE_LOG_INTERVAL_S = 300.0
# Every N valid collections an INFO summary is recorded (heartbeat).
HEARTBEAT_EVERY = 12

# Battery test: defaults and limits (all overridable per [device:*]).
TEST_TYPE_DURATION_10S = "duration_10s"
TEST_TYPE_DISCHARGE_20PCT = "discharge_20pct"
DEFAULT_TEST_TYPE = TEST_TYPE_DURATION_10S
SUPPORTED_TEST_TYPES = (TEST_TYPE_DURATION_10S, TEST_TYPE_DISCHARGE_20PCT)
DEFAULT_TEST_DURATION_S = 10.0
DEFAULT_TEST_SAMPLE_INTERVAL_S = 0.4
DEFAULT_TEST_COOLDOWN_S = 300.0
DEFAULT_TEST_MIN_BATTERY_PERCENT = 50.0
DEFAULT_TEST_HISTORY_SIZE = 20
# Tolerance above the requested window before ending by watchdog.
TEST_WATCHDOG_EXTRA_S = 2.0
# Controlled-discharge test (`discharge_20pct`): exists ONLY in protocols that
# can abort the test (today, the SMS). The target is fixed at 20 % of the charge;
# the safety ceiling (30 min) avoids an indefinite discharge if the reported
# percentage freezes, and the sampling interval is larger because the discharge
# is slow (smaller series).
DISCHARGE_TARGET_PERCENT = 20.0
DISCHARGE_WATCHDOG_S = 1800.0
DISCHARGE_SAMPLE_INTERVAL_S = 2.0
# Endings in which the UPS MAY still be testing: in those cases the driver's abort
# command is sent (best-effort), when the protocol has one. This was the cause of
# the 2026-10-22 incident (see SMS/.../docs/tests-and-evidence.md T10): the end of
# the window does NOT end the test on the device. `target_percent_reached` and
# `battery_low` also require the abort — without it a target test would keep
# discharging the battery.
FINISH_REASONS_NEEDING_ABORT = frozenset(
    {
        FINISH_ABORTED,
        FINISH_DURATION_ELAPSED,
        FINISH_TARGET_REACHED,
        FINISH_BATTERY_LOW,
        FINISH_WATCHDOG,
        FINISH_STOPPING,
    }
)
# Minimum percentage drop in the window to estimate runtime (avoids extrapolating noise).
MIN_MEANINGFUL_DROP_PP = 0.5
# Sanity ceiling of the estimated runtime (avoids absurd numbers with a ~0 drop).
MAX_ESTIMATED_RUNTIME_MIN = 600.0
# Trimming of the initial transient in the estimated runtime: the charge drops
# abruptly in the first instants of the test (ohmic/electrolyte drop) and that drop
# is NOT the real discharge rate — extrapolating it gave unreal runtimes of a few
# minutes. The initial stretch is discarded before the fit; see `_trim_transient`.

# Normalized metrics (protocol-independent) used in the report.
_NORMALIZED_METRICS = ("input_voltage_v", "output_voltage_v", "load_percent", "temperature_c")


class BatteryTestError(Exception):
    """Test request refused before any serial access."""

    def __init__(self, code: str, message: str, http_status: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


class FailureLogger:
    """Records failures without repeating the same message in consecutive cycles."""

    def __init__(self, logger, label: str, interval_s: float = FAILURE_LOG_INTERVAL_S, clock=time.monotonic):
        self._logger = logger
        self._label = label
        self._interval_s = interval_s
        self._clock = clock
        self._key = None
        self._at = 0.0

    def report(self, context: str, code: str, message: str, failures: int = 0) -> None:
        key = (context, code, message)
        now = self._clock()
        if key == self._key and (now - self._at) < self._interval_s:
            self._logger.debug("[%s] persistent failure (%s): %s", self._label, code, message)
            return
        self._logger.warning(
            "[%s] collection failure (%s) after %d consecutive attempt(s): %s",
            self._label,
            code,
            failures,
            message,
        )
        self._key = key
        self._at = now

    def reset(self) -> None:
        self._key = None
        self._at = 0.0


class Collector:
    """Runs the driver's read queries and keeps the last valid reading."""

    def __init__(
        self,
        device,
        driver=None,
        link=None,
        link_factory=None,
        now=None,
        monotonic=None,
        sleep=None,
    ):
        self.device = device
        self._label = device.device_id
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._monotonic = monotonic or time.monotonic
        self._driver = driver or create_driver(device)

        if link is None:
            if link_factory is None:
                from .serial_link import SerialLink

                link_factory = SerialLink
            link = link_factory(device, self._driver)
        self._link = link

        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._telemetry: Telemetry | None = None
        self._identity: Identity | None = None
        self._valid_count = 0
        self._status_failures = FailureLogger(LOGGER, self._label, clock=self._monotonic)
        self._identity_failures = FailureLogger(LOGGER, self._label, clock=self._monotonic)
        self._state = CollectionState(
            poll_interval_s=device.poll_interval_s,
            stale_after_s=device.stale_after_s,
        )

        # -- battery test (per-device configuration) --------------------------
        self._test_enabled = device.opt_bool("allow_battery_test", False)
        self._test_duration_s = device.opt_float("test_duration_s", DEFAULT_TEST_DURATION_S)
        self._test_sample_interval_s = device.opt_float(
            "test_sample_interval_s", DEFAULT_TEST_SAMPLE_INTERVAL_S
        )
        self._test_cooldown_s = device.opt_float("test_cooldown_s", DEFAULT_TEST_COOLDOWN_S)
        self._test_min_battery_percent = device.opt_float(
            "test_min_battery_percent", DEFAULT_TEST_MIN_BATTERY_PERCENT
        )
        self._test_history_size = device.opt_int("test_history_size", DEFAULT_TEST_HISTORY_SIZE)
        self._sleep = sleep or self._stop_event.wait
        self._test_lock = threading.Lock()
        self._pending_test: BatteryTest | None = None
        self._test: BatteryTest | None = None
        self._test_history: list[BatteryTest] = []
        self._abort_event: threading.Event | None = None
        self._last_test_finished_utc = None

    # -- lifecycle -------------------------------------------------------
    def start(self) -> None:
        LOGGER.info(
            "[%s] starting collector: protocol=%s port=%s baud=%s interval=%.1fs stale_after=%.1fs",
            self._label,
            self._driver.protocol,
            self.device.serial_port or "(auto-detect)",
            self.device.serial_baud,
            self.device.poll_interval_s,
            self.device.stale_after_s,
        )
        self._thread = threading.Thread(
            target=self._run, name=f"upsmon-collector-{self._label}", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        try:
            self._link.close()
        except Exception:  # pragma: no cover - defensive shutdown
            LOGGER.debug("[%s] failed to close the serial port on shutdown", self._label, exc_info=True)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # -- in-memory state --------------------------------------------------
    def snapshot(self) -> Snapshot:
        """Copy of the current state for the HTTP layer (no serial I/O)."""
        with self._lock:
            self._refresh_state_locked(self._now())
            return Snapshot(
                telemetry=self._telemetry,
                identity=self._identity,
                state=dataclasses.replace(self._state),
                collector_alive=self.running,
            )

    def collect_once(self) -> Telemetry | None:
        """Runs one collection cycle (used by the loop and by the --check mode).

        If there is a battery test enqueued by the HTTP layer, it runs the test
        (high-frequency window) and keeps the normal telemetry fresh at the end
        of the cycle.
        """
        pending = self._take_pending_test()
        if pending is not None:
            self._run_battery_test(pending)
        return self._poll_once()

    def _poll_once(self) -> Telemetry | None:
        """One telemetry reading (status command) with failure classification."""
        attempt_at = self._now()
        with self._lock:
            self._state.last_attempt_utc = attempt_at
            self._state.total_attempts += 1

        try:
            frame = self._link.query(self._driver.CMD_STATUS)
        except LinkError as exc:
            self._register_failure(exc.code, exc.message, attempt_at)
            return None

        try:
            parsed = self._driver.parse_status(frame)
        except ProtocolError as exc:
            detail = f"{exc.message} (response: {_hex(exc.raw)})"
            self._register_failure(exc.code, detail, attempt_at)
            return None

        telemetry = Telemetry(
            captured_at=self._now(),
            source=self._driver.source,
            measurements=parsed["measurements"],
            status=parsed["status"],
            battery=parsed.get("battery"),
            battery_charge=parsed.get("battery_charge"),
            raw_frame=parsed["raw_frame"],
        )
        self._register_success(telemetry)
        self._refresh_identity(attempt_at)
        return telemetry

    # -- battery test (public API used by the HTTP layer) ------------------
    def supported_test_types(self) -> tuple[str, ...]:
        """Test types accepted by THIS device (depends on the protocol).

        `discharge_20pct` exists only where the protocol can ABORT the test: it
        runs without a fixed window and ends at the target (or at the safety
        ceiling), that is, the stop depends on the driver's abort command.
        """
        if not self._driver.supports_battery_test:
            return ()
        types = [TEST_TYPE_DURATION_10S]
        if self._driver.supports_test_abort:
            types.append(TEST_TYPE_DISCHARGE_20PCT)
        return tuple(types)

    def _test_type_details(self, test_type: str) -> dict:
        """Effective parameters of a test type (window, target, ceiling, interval)."""
        if test_type == TEST_TYPE_DISCHARGE_20PCT:
            return {
                "duration_s": None,
                "target_percent": DISCHARGE_TARGET_PERCENT,
                "timeout_s": DISCHARGE_WATCHDOG_S,
                "sample_interval_s": DISCHARGE_SAMPLE_INTERVAL_S,
            }
        return {
            "duration_s": self._test_duration_s,
            "target_percent": None,
            "timeout_s": self._test_duration_s + TEST_WATCHDOG_EXTRA_S,
            "sample_interval_s": self._test_sample_interval_s,
        }

    def test_capabilities(self) -> dict:
        """Test capabilities of this device (no I/O)."""
        types = self.supported_test_types()
        return {
            "supported": self._driver.supports_battery_test,
            "enabled": self._test_enabled,
            "test_types": list(types),
            "types": {name: self._test_type_details(name) for name in types},
            "duration_s": self._test_duration_s,
            "sample_interval_s": self._test_sample_interval_s,
            "cooldown_s": self._test_cooldown_s,
            "min_battery_percent": self._test_min_battery_percent,
            "abort_supported": self._driver.supports_test_abort,
        }

    def request_test(self, test_type: str = DEFAULT_TEST_TYPE) -> dict:
        """Validates the preconditions and ENQUEUES a battery test.

        Does not access the serial port: it only checks the in-memory state
        (snapshot) and marks the intention, which will be run by the collector
        loop. Raises `BatteryTestError` (with the suggested HTTP status) when it
        refuses.
        """
        available = self.supported_test_types()
        if test_type not in available:
            raise BatteryTestError(
                "unsupported_test_type",
                f"unsupported test type: {test_type!r} (available: "
                f"{', '.join(available) or 'none'})",
                422,
            )
        if not self._test_enabled:
            raise BatteryTestError(
                "test_disabled",
                "the battery test is not enabled for this device "
                "(set allow_battery_test = true in the [device:*] block)",
                403,
            )
        if not self._driver.supports_battery_test:
            raise BatteryTestError(
                "test_not_supported",
                f"the {self._driver.protocol} protocol does not offer a battery test",
                422,
            )

        snapshot = self.snapshot()
        # If the loop was started and already died, the enqueued request would
        # never leave the queue: refuse. With no loop started the collection is
        # driven manually (collect_once, as in --check mode), and the request is
        # valid.
        thread = self._thread
        if thread is not None and not thread.is_alive():
            raise BatteryTestError(
                "test_unavailable",
                "the collection loop of this device has ended; "
                "the battery test cannot be run",
                409,
            )
        if self._is_test_in_progress():
            raise BatteryTestError(
                "test_in_progress", "a battery test is already in progress", 409
            )
        state = snapshot.state
        if not state.telemetry_valid:
            raise BatteryTestError(
                "test_unavailable",
                f"no valid and fresh telemetry (state {state.state!r}); "
                "the test cannot be started",
                409,
            )

        flags = (snapshot.telemetry.status or {}).get("flags", {})
        if flags.get("OB"):
            raise BatteryTestError(
                "on_battery",
                "the UPS is already running on battery (OB flag); test refused",
                409,
            )
        if flags.get("LB"):
            raise BatteryTestError(
                "battery_low", "the battery is low (LB flag); test refused", 409
            )
        percent = _battery_percent(snapshot.telemetry)
        if percent is not None and percent < self._test_min_battery_percent:
            raise BatteryTestError(
                "battery_too_low",
                f"battery charge {percent} % below the minimum "
                f"{self._test_min_battery_percent} % for a safe test",
                409,
            )
        plan = self._test_type_details(test_type)
        target_percent = plan["target_percent"]
        if target_percent is not None:
            # the target test only ends when the REPORTED percentage drops to the
            # target: without that data there is no way to end it safely.
            if percent is None:
                raise BatteryTestError(
                    "test_requires_battery_percent",
                    f"the test {test_type!r} ends by the battery percentage reported "
                    "by the device, which is not available in this telemetry",
                    422,
                )
            if percent <= target_percent:
                raise BatteryTestError(
                    "battery_at_target",
                    f"battery charge {percent} % is already at the test target "
                    f"({target_percent} %); test refused",
                    409,
                )
        retry_after = self._cooldown_remaining_s()
        if retry_after > 0:
            raise BatteryTestError(
                "test_cooldown",
                f"wait {round(retry_after)} s before a new test "
                f"(cooldown of {round(self._test_cooldown_s)} s)",
                409,
            )

        timeout_s = plan["timeout_s"]
        started = self._now()
        report = BatteryTest(
            test_id=uuid.uuid4().hex[:16],
            device_id=self._label,
            test_type=test_type,
            status=TEST_RUNNING,
            started_at=started,
            expected_end_at=started + timedelta(seconds=timeout_s),
            requested_duration_s=plan["duration_s"],
            sample_interval_s=plan["sample_interval_s"],
            target_percent=target_percent,
            timeout_s=timeout_s,
        )
        with self._test_lock:
            self._test = report
            self._pending_test = report
        LOGGER.info(
            "[%s] battery test requested: id=%s type=%s window=%s s target=%s %% "
            "interval=%.2fs ceiling=%.0fs",
            self._label,
            report.test_id,
            test_type,
            report.requested_duration_s,
            report.target_percent,
            report.sample_interval_s,
            timeout_s,
        )
        return self.request_payload(report)

    def abort_test(self, test_id: str) -> dict | None:
        """Requests the abort of an ongoing test. Returns None if the id does not exist."""
        with self._test_lock:
            current = self._test
            abort_event = self._abort_event if current is not None and current.test_id == test_id else None
            running = (
                current is not None
                and current.test_id == test_id
                and current.status == TEST_RUNNING
            )
        if current is None or current.test_id != test_id:
            if self._find_test(test_id) is None:
                return None
            raise BatteryTestError(
                "test_not_running", f"the test {test_id!r} is not running", 409
            )
        if not running or abort_event is None:
            raise BatteryTestError(
                "test_not_running", f"the test {test_id!r} is not running", 409
            )
        abort_event.set()
        LOGGER.info("[%s] abort requested for battery test %s", self._label, test_id)
        return {"test_id": test_id, "status": "aborting"}

    def request_payload(self, report: BatteryTest) -> dict:
        """Immediate response to the test request (202 Accepted)."""
        return {
            "test_id": report.test_id,
            "device_id": report.device_id,
            "type": report.test_type,
            "status": report.status,
            "started_at_utc": iso_utc(report.started_at),
            "expected_end_at_utc": iso_utc(report.expected_end_at),
            "requested_duration_s": report.requested_duration_s,
            "target_percent": report.target_percent,
            "timeout_s": report.timeout_s,
            "sample_interval_s": report.sample_interval_s,
            "report_url": f"/api/v1/ups/{report.device_id}/tests/{report.test_id}",
        }

    def test_report(self, test_id: str) -> BatteryTest | None:
        """Report of a test (running or in the in-memory history)."""
        return self._find_test(test_id)

    def test_list(self, limit: int = DEFAULT_TEST_HISTORY_SIZE) -> list[BatteryTest]:
        """Latest tests, from the most recent to the oldest."""
        with self._test_lock:
            items = [self._test] if self._test is not None else []
            items.extend(self._test_history)
        unique: list[BatteryTest] = []
        seen: set[str] = set()
        for item in items:
            if item.test_id in seen:
                continue
            seen.add(item.test_id)
            unique.append(item)
        unique.sort(key=lambda report: report.started_at, reverse=True)
        return unique[: max(1, limit)]

    # -- battery test (execution in the collector loop) ---------------------
    def _take_pending_test(self) -> BatteryTest | None:
        with self._test_lock:
            pending = self._pending_test
            self._pending_test = None
        return pending

    def _is_test_in_progress(self) -> bool:
        with self._test_lock:
            current = self._test
            pending = self._pending_test
            abort_event = self._abort_event if current is not None else None
        if pending is not None:
            return True
        return current is not None and current.status == TEST_RUNNING and abort_event is not None

    def _find_test(self, test_id: str) -> BatteryTest | None:
        with self._test_lock:
            current = self._test
            history = list(self._test_history)
        if current is not None and current.test_id == test_id:
            return current
        for item in history:
            if item.test_id == test_id:
                return item
        return None

    def _cooldown_remaining_s(self) -> float:
        with self._test_lock:
            finished = self._last_test_finished_utc
        if finished is None or self._test_cooldown_s <= 0:
            return 0.0
        elapsed = (self._now() - finished).total_seconds()
        return max(0.0, self._test_cooldown_s - elapsed)

    def _run_battery_test(self, report: BatteryTest) -> None:
        """Runs the high-frequency window INSIDE the collector loop.

        Two modes: with a fixed WINDOW (`duration_10s`) or by percentage TARGET
        (`discharge_20pct`, no window — ends when the reported charge reaches the
        target, aborted by the client, by `LB` or by the safety ceiling).
        """
        driver = self._driver
        target_percent = report.target_percent
        window_s = report.requested_duration_s  # None in the target test
        watchdog_s = report.timeout_s if report.timeout_s else (
            (window_s or 0.0) + TEST_WATCHDOG_EXTRA_S
        )
        interval_s = max(0.01, report.sample_interval_s)
        abort_event = threading.Event()
        with self._test_lock:
            self._abort_event = abort_event

        # the valid reading from BEFORE the test is the reference ("baseline") of
        # the report: during the window self._telemetry becomes the last sample.
        report.baseline = _normalized_point(self._telemetry) if self._telemetry is not None else None
        samples: list[TestSample] = []
        points: list[dict] = []
        flags_seen: set[str] = set()
        test_flag_observed = False
        finish_reason = FINISH_DURATION_ELAPSED if window_s is not None else FINISH_WATCHDOG
        error: dict | None = None

        LOGGER.info(
            "[%s] battery test %s running (type=%s window=%s target=%s interval=%.2fs "
            "watchdog=%.1fs)",
            self._label,
            report.test_id,
            report.test_type,
            window_s,
            target_percent,
            interval_s,
            watchdog_s,
        )

        try:
            # the duration goes in the command itself (Param1) in protocols that require it
            self._link.send_action(driver.CMD_TEST_10S, duration_s=window_s)
        except LinkError as exc:
            error = {"code": exc.code, "message": exc.message}
            self._finalize_battery_test(
                report, samples, points, flags_seen, test_flag_observed, FINISH_SERIAL_ERROR, error, 0.0
            )
            return

        start_m = self._monotonic()
        elapsed = 0.0
        while True:
            telemetry = self._poll_once()
            if telemetry is not None:
                elapsed = max(0.0, self._monotonic() - start_m)
                point = _normalized_point(telemetry)
                samples.append(
                    TestSample(
                        offset_s=round(elapsed, 3),
                        measurements=dict(telemetry.measurements),
                        status=dict(telemetry.status),
                        battery=_battery_summary(telemetry),
                        normalized=point,
                    )
                )
                points.append(point)
                # the series is published on every sample: a report queried DURING
                # the test (which can last 30 min) already brings the partial
                # timeline for the consumer to draw the curve in real time.
                report.samples = samples
                flags = (telemetry.status or {}).get("flags", {})
                flags_seen.update(name for name, on in flags.items() if on)
                if flags.get("TEST"):
                    test_flag_observed = True
                if flags.get("LB"):
                    finish_reason = FINISH_BATTERY_LOW
                    break
                percent = _battery_percent(telemetry)
                if target_percent is not None and percent is not None and percent <= target_percent:
                    finish_reason = FINISH_TARGET_REACHED
                    break
                if test_flag_observed and not flags.get("TEST"):
                    finish_reason = FINISH_TEST_FLAG_CLEARED
                    break

            elapsed = max(0.0, self._monotonic() - start_m)
            if abort_event.is_set():
                finish_reason = FINISH_ABORTED
                break
            if self._stop_event.is_set():
                finish_reason = FINISH_STOPPING
                break
            if window_s is not None and elapsed >= window_s:
                finish_reason = FINISH_DURATION_ELAPSED
                break
            if elapsed >= watchdog_s:
                finish_reason = FINISH_WATCHDOG
                break
            self._sleep(min(interval_s, max(0.0, watchdog_s - elapsed)))

        if driver.supports_test_abort and finish_reason in FINISH_REASONS_NEEDING_ABORT:
            try:
                self._link.send_action(driver.CMD_TEST_ABORT)
            except LinkError as exc:  # the abort is best-effort
                LOGGER.warning(
                    "[%s] failed to abort battery test %s: %s",
                    self._label,
                    report.test_id,
                    exc.message,
                )

        self._finalize_battery_test(
            report, samples, points, flags_seen, test_flag_observed, finish_reason, error, elapsed
        )

    def _finalize_battery_test(
        self,
        report: BatteryTest,
        samples: list[TestSample],
        points: list[dict],
        flags_seen: set[str],
        test_flag_observed: bool,
        finish_reason: str,
        error: dict | None,
        elapsed: float,
    ) -> None:
        ended = self._now()
        window_s = round(elapsed, 3)
        report.ended_at = ended
        report.duration_s = window_s
        report.finish_reason = finish_reason
        report.flags_seen = sorted(flags_seen)
        report.test_flag_observed = test_flag_observed
        report.samples = samples
        report.final = points[-1] if points else None
        report.error = error

        if finish_reason == FINISH_ABORTED:
            report.status = TEST_ABORTED
        elif error is not None or finish_reason == FINISH_SERIAL_ERROR:
            report.status = TEST_FAILED
        elif not points:
            report.status = TEST_FAILED
            report.error = {
                "code": "no_samples",
                "message": "no valid sample was obtained during the test window",
            }
        else:
            report.status = TEST_COMPLETED

        report.deltas = _build_deltas(points, window_s) if points else None
        report.estimate = _estimate_runtime(samples, window_s)

        with self._test_lock:
            self._test = report
            self._test_history.insert(0, report)
            del self._test_history[self._test_history_size :]
            self._abort_event = None
            self._last_test_finished_utc = ended

        LOGGER.info(
            "[%s] battery test %s finished: type=%s status=%s reason=%s target=%s window=%.1fs "
            "samples=%d battery_drop=%s runtime=%s",
            self._label,
            report.test_id,
            report.test_type,
            report.status,
            finish_reason,
            report.target_percent,
            window_s,
            len(samples),
            _metric_delta(report.deltas, "battery_charge_percent"),
            (report.estimate or {}).get("estimated_runtime_min"),
        )

    # -- internals --------------------------------------------------------
    def _run(self) -> None:
        LOGGER.info("[%s] collection loop started", self._label)
        while not self._stop_event.is_set():
            started = self._monotonic()
            self.collect_once()
            elapsed = self._monotonic() - started
            self._stop_event.wait(max(0.0, self.device.poll_interval_s - elapsed))
        LOGGER.info("[%s] collection loop finished", self._label)

    def _register_failure(self, code: str, message: str, at) -> None:
        with self._lock:
            self._state.consecutive_failures += 1
            self._state.last_error = ErrorInfo(code=code, message=message, at_utc=at)
            self._state.port = getattr(self._link, "port", None) or self._state.port
            self._refresh_state_locked(at)
            failures = self._state.consecutive_failures
        self._status_failures.report("telemetry", code, message, failures)

    def _register_success(self, telemetry: Telemetry) -> None:
        with self._lock:
            previous_failures = self._state.consecutive_failures
            self._telemetry = telemetry
            self._state.last_success_utc = telemetry.captured_at
            self._state.consecutive_failures = 0
            self._state.last_error = None
            self._state.total_successes += 1
            self._state.port = getattr(self._link, "port", None) or self._state.port
            self._valid_count += 1
            count = self._valid_count
            self._refresh_state_locked(telemetry.captured_at)
        self._status_failures.reset()

        if previous_failures:
            LOGGER.info(
                "[%s] valid telemetry restored after %d consecutive failure(s)",
                self._label,
                previous_failures,
            )
        elif count == 1:
            LOGGER.info("[%s] first valid telemetry received on port %s", self._label, self._state.port)
        elif count % HEARTBEAT_EVERY == 0:
            LOGGER.info("[%s] active collection: %s", self._label, _summary(telemetry))

    def _refresh_identity(self, at) -> None:
        current = self._identity
        if current is not None:
            age = (at - current.captured_at).total_seconds()
            if age < self.device.identity_refresh_s:
                return

        try:
            device_data = self._driver.parse_identity(self._link.query(self._driver.CMD_IDENTITY))
        except (LinkError, ProtocolError) as exc:
            self._identity_failures.report("identity", getattr(exc, "code", "error"), str(exc))
            return

        nominal_data: dict = {}
        try:
            nominal_data = self._driver.parse_ratings(self._link.query(self._driver.CMD_RATINGS))
        except (LinkError, ProtocolError) as exc:
            self._identity_failures.report("ratings", getattr(exc, "code", "error"), str(exc))

        self._identity_failures.reset()
        with self._lock:
            self._identity = Identity(captured_at=at, device=device_data, nominal=nominal_data)
        LOGGER.info(
            "[%s] identity updated: model=%s firmware=%s nominal voltage=%s V nominal battery=%s V",
            self._label,
            device_data.get("model"),
            device_data.get("firmware"),
            nominal_data.get("voltage_v"),
            nominal_data.get("battery_voltage_v"),
        )

    def _refresh_state_locked(self, now) -> None:
        """Recomputes age, staleness, validity and communication state."""
        state = self._state
        telemetry = self._telemetry

        age = None
        if telemetry is not None:
            age = max(0.0, (now - telemetry.captured_at).total_seconds())
        state.age_seconds = round(age, 3) if age is not None else None
        state.stale = telemetry is not None and age is not None and age > self.device.stale_after_s

        if state.last_attempt_utc is None:
            state.state = "starting"
        elif state.stale:
            state.state = "stale"
        elif state.last_error is not None:
            state.state = state.last_error.code
        elif telemetry is not None:
            state.state = "ok"
        else:
            state.state = "starting"

        # `telemetry_valid` reflects only the freshness of the last valid reading;
        # communication failures appear in `state` and `last_error`.
        state.telemetry_valid = telemetry is not None and not state.stale


def _battery_percent(telemetry: Telemetry):
    if telemetry.battery is not None:
        return telemetry.battery.get("charge_percent")
    if telemetry.battery_charge is not None:
        return telemetry.battery_charge.get("percent")
    return None


def _battery_values(telemetry: Telemetry):
    """Battery percentage and voltage, independent of the protocol.

    SMS brings the percentage from the device (`battery.charge_percent`) and the
    derived voltage (`battery.voltage_v`); Megatec brings the estimated percentage
    (`battery_charge.percent`) and the measured voltage in `measurements.battery_voltage_v`.
    """
    if telemetry.battery is not None:
        return telemetry.battery.get("charge_percent"), telemetry.battery.get("voltage_v")
    if telemetry.battery_charge is not None:
        return telemetry.battery_charge.get("percent"), telemetry.measurements.get("battery_voltage_v")
    return None, None


def _battery_summary(telemetry: Telemetry) -> dict | None:
    """Common battery summary for a sample {charge_percent, voltage_v}."""
    percent, voltage = _battery_values(telemetry)
    summary: dict = {}
    if percent is not None:
        summary["charge_percent"] = percent
    if voltage is not None:
        summary["voltage_v"] = voltage
    return summary or None


def _normalized_point(telemetry: Telemetry) -> dict:
    """Extracts the common normalized metrics (ignores keys without a value)."""
    measurements = telemetry.measurements
    point: dict = {}
    for key in _NORMALIZED_METRICS:
        value = measurements.get(key)
        if value is not None:
            point[key] = value
    frequency = measurements.get("output_frequency_hz")
    if frequency is None:
        frequency = measurements.get("input_frequency_hz")
    if frequency is not None:
        point["frequency_hz"] = frequency
    percent, voltage = _battery_values(telemetry)
    if percent is not None:
        point["battery_charge_percent"] = percent
    if voltage is not None:
        point["battery_voltage_v"] = voltage
    return point


def _build_deltas(points: list[dict], window_s: float) -> dict:
    """Aggregates the sampled series into per-metric statistics (min/max/drop/ripple)."""
    metrics: dict = {}
    keys = sorted({key for point in points for key in point})
    for key in keys:
        values = [point[key] for point in points if point.get(key) is not None]
        if not values:
            continue
        start = points[0].get(key)
        end = points[-1].get(key)
        stats = {
            "start": start,
            "end": end,
            "min": min(values),
            "max": max(values),
            "ripple": round(max(values) - min(values), 3),
            "count": len(values),
        }
        if start is not None and end is not None:
            stats["delta"] = round(end - start, 3)
        if start is not None:
            stats["max_abs_deviation"] = round(
                max(abs(stats["max"] - start), abs(stats["min"] - start)), 3
            )
        metrics[key] = stats
    return {"window_s": round(window_s, 3), "sample_count": len(points), "metrics": metrics}


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _trim_transient(series: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Discards the initial readings of the abrupt battery drop transient.

    In the first instants of the test the charge drops much faster than in the
    rest of the window (ohmic/electrolyte drop); extrapolating that drop would
    give unreal runtimes. The end of the transient is found without a fixed
    threshold: it walks from the start while the drop between consecutive readings
    is GREATER than the typical drop of the window (the median of the drops). The
    trim adapts to the real size of the transient and cuts nothing in a uniform
    discharge. `series` comes ordered in time as a list of pairs (offset_s,
    charge_percent).
    """
    if len(series) < 3:
        return series
    drops = [abs(series[index][1] - series[index - 1][1]) for index in range(1, len(series))]
    typical_drop = _median(drops)
    cut = 0
    # stops at `len(drops) - 1` to never leave fewer than two readings in the stretch
    while cut < len(drops) - 1 and drops[cut] > typical_drop:
        cut += 1
    return series[cut:]


def _estimate_runtime(samples: list[TestSample], window_s: float) -> dict:
    """Runtime estimate by linear regression, ignoring the initial transient.

    The abrupt drop transient at the start of the test does not represent the real
    discharge rate: the readings of that stretch (`_trim_transient`) are discarded
    and the rate comes from the linear regression (least squares) of the rest,
    which is more robust to an out-of-line sample than the difference between the
    extremes.

    Deliberately conservative: it only estimates when there is a measurable drop in
    the stretch used and signals low confidence (10 s is a short window and the
    discharge is rarely linear). The final model/policy is up to the consumer (the
    web viewer service (`src/backend` + `src/frontend`) in this repository).
    """
    series = [
        (sample.offset_s, sample.normalized["battery_charge_percent"])
        for sample in samples
        if sample.normalized and sample.normalized.get("battery_charge_percent") is not None
    ]
    if not window_s or len(series) < 2:
        return {"available": False, "reason": "no battery charge data in the window"}

    used = _trim_transient(series)
    if len(used) < 2:
        return {
            "available": False,
            "reason": "insufficient samples after discarding the initial transient",
            "readings_total": len(series),
            "window_s": round(window_s, 3),
        }

    count = len(used)
    mean_t = sum(offset for offset, _ in used) / count
    mean_v = sum(value for _, value in used) / count
    variance_t = sum((offset - mean_t) ** 2 for offset, _ in used)
    if variance_t <= 0:
        return {
            "available": False,
            "reason": "samples of the useful stretch without time variation",
            "window_s": round(window_s, 3),
        }

    slope_pp_per_s = sum((offset - mean_t) * (value - mean_v) for offset, value in used) / variance_t
    drop_used = round(used[0][1] - used[-1][1], 3)
    if slope_pp_per_s >= 0 or drop_used <= 0:
        return {
            "available": False,
            "reason": "battery charge stable or recovering after the initial transient",
            "readings_total": len(series),
            "readings_used": count,
            "window_s": round(window_s, 3),
        }
    if drop_used < MIN_MEANINGFUL_DROP_PP:
        return {
            "available": False,
            "reason": "charge drop below the measurable resolution in the useful stretch",
            "drop_percent_used": drop_used,
            "readings_total": len(series),
            "readings_used": count,
            "window_s": round(window_s, 3),
        }

    rate_pp_per_s = -slope_pp_per_s
    # reference charge = value FITTED by the regression at the end of the window
    # (the smoothed current level, already free of the initial transient).
    reference = mean_v + slope_pp_per_s * (series[-1][0] - mean_t)
    runtime_min = (max(0.0, reference) / rate_pp_per_s) / 60.0
    return {
        "available": True,
        "method": "linear_regression_trimmed",
        "window_s": round(window_s, 3),
        "readings_total": len(series),
        "readings_used": count,
        "transient_readings_dropped": len(series) - count,
        "drop_percent_in_window": round(series[0][1] - series[-1][1], 3),
        "drop_percent_used": drop_used,
        "discharge_rate_pp_per_min": round(rate_pp_per_s * 60.0, 3),
        "reference_charge_percent": round(max(0.0, reference), 3),
        "estimated_runtime_min": round(min(runtime_min, MAX_ESTIMATED_RUNTIME_MIN), 1),
        "capped_at_min": MAX_ESTIMATED_RUNTIME_MIN,
        "confidence": "low",
    }


def _metric_delta(deltas: dict | None, key: str):
    if not deltas:
        return None
    return (deltas.get("metrics") or {}).get(key, {}).get("delta")


def _summary(telemetry: Telemetry) -> str:
    """Compact summary of the common values, for the heartbeat log."""
    measurements = telemetry.measurements
    parts = [
        f"input {measurements.get('input_voltage_v')} V",
        f"output {measurements.get('output_voltage_v')} V",
        f"load {measurements.get('load_percent')} %",
    ]
    battery = _battery_percent(telemetry)
    if battery is not None:
        parts.append(f"battery {battery} %")
    if measurements.get("temperature_c") is not None:
        parts.append(f"{measurements['temperature_c']} C")
    status = telemetry.status
    flags = ", ".join(status.get("active", [])) or "no flags"
    return f"{' | '.join(parts)} | {flags}"


def _hex(raw) -> str:
    """Formats bytes as readable hexadecimal (for the log/error)."""
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw).hex(" ")
    return repr(raw)
