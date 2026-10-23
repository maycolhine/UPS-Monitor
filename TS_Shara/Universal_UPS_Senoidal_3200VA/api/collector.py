"""Periodic collection loop and in-memory state (last valid telemetry).

The collector is the only component that talks to the serial port. The HTTP
layer reads the state via snapshot(); no HTTP request triggers a read.

There is no database: only the last valid reading and the communication
metadata are kept in memory.
"""
from __future__ import annotations

import dataclasses
import logging
import threading
import time
from datetime import datetime, timezone

from . import protocol
from .models import CollectionState, ErrorInfo, Identity, Snapshot, Telemetry
from .serial_link import LinkError

LOGGER = logging.getLogger("ts_shara.collector")

# Minimum interval between two records of the SAME failure (avoids log spam).
FAILURE_LOG_INTERVAL_S = 300.0
# Every N valid collections, log a summary at INFO level (heartbeat).
HEARTBEAT_EVERY = 12


class FailureLogger:
    """Records failures without repeating the same message on consecutive cycles."""

    def __init__(self, logger, interval_s: float = FAILURE_LOG_INTERVAL_S, clock=time.monotonic):
        self._logger = logger
        self._interval_s = interval_s
        self._clock = clock
        self._key = None
        self._at = 0.0

    def report(self, context: str, code: str, message: str, failures: int = 0) -> None:
        key = (context, code, message)
        now = self._clock()
        if key == self._key and (now - self._at) < self._interval_s:
            self._logger.debug("[%s] persistent failure (%s): %s", context, code, message)
            return
        self._logger.warning(
            "[%s] collection failure (%s) after %d consecutive attempt(s): %s",
            context,
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
    """Runs the Megatec/Q1 queries and keeps the last valid reading."""

    def __init__(self, config, link=None, link_factory=None, now=None, monotonic=None):
        self.config = config
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._monotonic = monotonic or time.monotonic

        if link is None:
            if link_factory is None:
                from .serial_link import SerialLink

                link_factory = SerialLink
            link = link_factory(config)
        self._link = link

        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._telemetry: Telemetry | None = None
        self._identity: Identity | None = None
        self._valid_count = 0
        self._q1_failures = FailureLogger(LOGGER, clock=self._monotonic)
        self._identity_failures = FailureLogger(LOGGER, clock=self._monotonic)
        self._state = CollectionState(
            poll_interval_s=config.poll_interval_s,
            stale_after_s=config.stale_after_s,
        )

    # -- lifecycle -------------------------------------------------------
    def start(self) -> None:
        LOGGER.info(
            "initializing collector: device_id=%s port=%s baud=%s interval=%.1fs stale_after=%.1fs",
            self.config.device_id,
            self.config.serial_port or "(autodetected)",
            self.config.serial_baud,
            self.config.poll_interval_s,
            self.config.stale_after_s,
        )
        self._thread = threading.Thread(target=self._run, name="ts-shara-collector", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        try:
            self._link.close()
        except Exception:  # pragma: no cover - defensive shutdown
            LOGGER.debug("failed to close the serial port on shutdown", exc_info=True)

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
        """Runs one collection cycle (used by the loop and by --check mode)."""
        attempt_at = self._now()
        with self._lock:
            self._state.last_attempt_utc = attempt_at
            self._state.total_attempts += 1

        try:
            frame = self._link.query(protocol.CMD_STATUS)
        except LinkError as exc:
            self._register_failure(exc.code, exc.message, attempt_at)
            return None

        try:
            parsed = protocol.parse_q1_frame(frame)
        except protocol.ProtocolError as exc:
            detail = f"{exc.message} (response: {exc.raw!r})"
            self._register_failure(exc.code, detail, attempt_at)
            return None

        parsed = dict(parsed)
        raw_frame = parsed.pop("raw_frame")
        telemetry = Telemetry(
            captured_at=self._now(),
            battery_charge_percent=protocol.estimate_battery_charge(
                parsed["battery_voltage_v"],
                self.config.battery_voltage_low_v,
                self.config.battery_voltage_high_v,
            ),
            battery_charge_low_v=self.config.battery_voltage_low_v,
            battery_charge_high_v=self.config.battery_voltage_high_v,
            raw_frame=raw_frame,
            **parsed,
        )
        self._register_success(telemetry)
        self._refresh_identity(attempt_at)
        return telemetry

    # -- internals --------------------------------------------------------
    def _run(self) -> None:
        LOGGER.info("collection loop started")
        while not self._stop_event.is_set():
            started = self._monotonic()
            self.collect_once()
            elapsed = self._monotonic() - started
            self._stop_event.wait(max(0.0, self.config.poll_interval_s - elapsed))
        LOGGER.info("collection loop stopped")

    def _register_failure(self, code: str, message: str, at) -> None:
        with self._lock:
            self._state.consecutive_failures += 1
            self._state.last_error = ErrorInfo(code=code, message=message, at_utc=at)
            self._state.port = getattr(self._link, "port", None) or self._state.port
            self._refresh_state_locked(at)
            failures = self._state.consecutive_failures
        self._q1_failures.report("telemetry", code, message, failures)

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
        self._q1_failures.reset()

        if previous_failures:
            LOGGER.info("valid telemetry re-established after %d consecutive failure(s)", previous_failures)
        elif count == 1:
            LOGGER.info("first valid telemetry received on port %s", self._state.port)
        elif count % HEARTBEAT_EVERY == 0:
            LOGGER.info(
                "collection active: input %.1f V | output %.1f V | load %d%% | battery %.1f V | %s",
                telemetry.input_voltage_v,
                telemetry.output_voltage_v,
                telemetry.load_percent,
                telemetry.battery_voltage_v,
                ", ".join(telemetry.status_active) or "no flags",
            )

    def _refresh_identity(self, at) -> None:
        current = self._identity
        if current is not None:
            age = (at - current.captured_at).total_seconds()
            if age < self.config.identity_refresh_s:
                return

        try:
            identity_data = protocol.parse_identity_frame(self._link.query(protocol.CMD_IDENTITY))
        except (LinkError, protocol.ProtocolError) as exc:
            self._identity_failures.report("identification", getattr(exc, "code", "error"), str(exc))
            return

        ratings_data = {}
        try:
            ratings_data = protocol.parse_ratings_frame(self._link.query(protocol.CMD_RATINGS))
        except (LinkError, protocol.ProtocolError) as exc:
            self._identity_failures.report("ratings", getattr(exc, "code", "error"), str(exc))

        self._identity_failures.reset()
        with self._lock:
            self._identity = Identity(
                captured_at=at,
                manufacturer=identity_data.get("manufacturer"),
                model=identity_data.get("model"),
                firmware=identity_data.get("firmware"),
                nominal_voltage_label=ratings_data.get("nominal_voltage_label"),
                nominal_voltage_v=ratings_data.get("nominal_voltage_v"),
                nominal_input_current_a=ratings_data.get("nominal_input_current_a"),
                nominal_battery_voltage_v=ratings_data.get("nominal_battery_voltage_v"),
                nominal_frequency_hz=ratings_data.get("nominal_frequency_hz"),
                ident_raw_frame=identity_data.get("raw_frame"),
                ratings_raw_frame=ratings_data.get("raw_frame"),
            )
        LOGGER.info(
            "identity updated: manufacturer=%s model=%s firmware=%s ratings=%s",
            identity_data.get("manufacturer"),
            identity_data.get("model"),
            identity_data.get("firmware"),
            ratings_data.get("raw_frame") or "unavailable",
        )

    def _refresh_state_locked(self, now) -> None:
        """Recomputes age, staleness, validity and communication state."""
        state = self._state
        telemetry = self._telemetry

        age = None
        if telemetry is not None:
            age = max(0.0, (now - telemetry.captured_at).total_seconds())
        state.age_seconds = round(age, 3) if age is not None else None
        state.stale = telemetry is not None and age is not None and age > self.config.stale_after_s

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
        # communication failures show up in `state` and `last_error`.
        state.telemetry_valid = telemetry is not None and not state.stale
