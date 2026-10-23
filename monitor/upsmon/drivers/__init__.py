"""Protocol driver registry and common interface.

Each driver translates the frames of ONE protocol into the common envelope of the
contract (`measurements`, `status`, `battery`/`battery_charge`) and builds the
bytes of the READ commands.

Besides reading, each driver explicitly declares which ACTION commands the
protocol accepts. At this stage there is **only** the ~10 s battery test
(`CMD_TEST_10S`) and, when the protocol offers it, its abort (`CMD_TEST_ABORT`).
The other action commands (test until battery low, shutdown, beep) are NOT
declared by any driver and, therefore, are unreachable through the API (see
docs/unified-api.md).
"""
from __future__ import annotations


class ProtocolError(Exception):
    """Received frame cannot be interpreted.

    Codes (API contract):
        invalid_response    - response does not contain a recognizable frame
        incomplete_response - recognizable but incomplete/malformed frame
        checksum_error      - frame checksum does not match
        parse_error         - field present but not numeric
        out_of_range        - numeric field outside the plausible range
    """

    def __init__(self, code: str, message: str, raw=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.raw = raw


class Driver:
    """Base interface of a protocol driver (no I/O)."""

    name = ""
    protocol = ""
    transport = "usb-serial"
    source = ""
    CMD_STATUS = ""
    CMD_IDENTITY = ""
    CMD_RATINGS = ""
    # ACTION commands declared per protocol (None = not supported).
    # `CMD_TEST_10S` = ~10 s battery test; `CMD_TEST_ABORT` = abort.
    CMD_TEST_10S: str | None = None
    CMD_TEST_ABORT: str | None = None
    read_size: int | None = None  # None = reads until timeout (text protocols)

    def __init__(self, device):
        self.device = device

    @property
    def supports_battery_test(self) -> bool:
        """Indicates whether the protocol offers the 10 s battery test."""
        return self.CMD_TEST_10S is not None

    @property
    def supports_test_abort(self) -> bool:
        """Indicates whether the protocol offers abort of the ongoing test."""
        return self.CMD_TEST_ABORT is not None

    def command_bytes(self, command: str) -> bytes:
        """Builds the bytes of the read command (includes the protocol terminator)."""
        raise NotImplementedError

    def action_bytes(self, command: str, duration_s: float | None = None) -> bytes:
        """Builds the bytes of an ACTION command.

        `duration_s` is the requested duration of the battery test, for protocols
        that receive it as a parameter — the SMS Brazil 1Phase uses `Param1` and,
        without that parameter, runs the test until the battery is discharged (see
        SMS/Power_Sinus_NG_uPS3200S/docs/sms-1phase-protocol.md §2.2). By default,
        the action command has the same bytes as a simple command.
        """
        return self.command_bytes(command)

    def parse_status(self, raw) -> dict:
        """Interprets the meters/status frame.

        Returns `{"measurements", "status", "raw_frame"}` and, depending on the
        protocol, also `"battery"` (SMS) or `"battery_charge"` (Megatec).
        """
        raise NotImplementedError

    def parse_identity(self, raw) -> dict:
        """Interprets the identification frame -> `device` block of the identity."""
        raise NotImplementedError

    def parse_ratings(self, raw) -> dict:
        """Interprets the nominal ratings frame -> `nominal` block."""
        raise NotImplementedError


def available_protocols() -> dict:
    return {cls.protocol: cls for cls in _registry().values()}


def create_driver(device):
    """Instantiates the driver corresponding to the device `protocol`."""
    registry = _registry()
    try:
        driver_class = registry[device.protocol]
    except KeyError:
        raise ValueError(
            f"unknown protocol for {device.device_id!r}: {device.protocol!r} "
            f"(available: {', '.join(sorted(registry))})"
        ) from None
    return driver_class(device)


def _registry() -> dict:
    # late import to avoid cycles and keep the drivers package isolated
    from .megatec_q1 import MegatecQ1Driver
    from .sms_1phase import Sms1PhaseDriver

    return {
        MegatecQ1Driver.protocol: MegatecQ1Driver,
        Sms1PhaseDriver.protocol: Sms1PhaseDriver,
    }
