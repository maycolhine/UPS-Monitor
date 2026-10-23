"""SMS Brazil 1Phase protocol driver (binary) — used by the SMS Power Sinus NG.

Reference: SMS/Power_Sinus_NG_uPS3200S/docs/sms-1phase-protocol.md and Spec.md.

Each command has 7 bytes (`<cmd> 0xFF 0xFF 0xFF 0xFF <checksum> <CR>`) and each
response has 18 bytes terminated by `<CR>`. READ commands: Q (meters/status), I
(information) and F (ratings). As an ACTION, only the timed battery test is
declared (`T`, which receives the duration in `Param1` and runs without
responding) and its abort (`D`). The other action commands (M, L, S, R, C) are
NOT declared and, therefore, cannot be sent through the API.

Battery particularity (opposite to the Megatec): the percentage COMES from the
device and the VOLTAGE is DERIVED (`nominal * percentage / 100`), as in the NUT
driver `sms_ser`.
"""
from __future__ import annotations

from . import Driver, ProtocolError

# Size of a response frame and terminator.
RESULT_SIZE = 18
RESPONSE_TERMINATOR = 0x0D
# First byte accepted as the start of a response.
STATUS_START_CHARS = (0x3C, 0x3D, 0x3E)  # '<', '=', '>'
INFO_START_CHARS = (0x3A, 0x3B)          # ':', ';'

# Sanity limits accepted for each measurement.
LIMITS = {
    "input_voltage_v": (0.0, 500.0),
    "input_voltage_extended_v": (0.0, 500.0),
    "output_voltage_v": (0.0, 500.0),
    "load_percent": (0.0, 200.0),
    "output_frequency_hz": (0.0, 100.0),
    "battery_charge_percent": (0.0, 100.0),
    "temperature_c": (-40.0, 125.0),
}

# Meaning of the status bits of byte 15 of the Q frame (b0 .. b7).
STATUS_BITS = {
    0: ("BEEP", "Beeper on"),
    1: ("FSD", "Shutdown active"),
    2: ("TEST", "Battery test in progress"),
    3: ("UPSOK", "Inverter/mains OK (no fault)"),
    4: ("BOOST", "Boost/Buck active"),
    5: ("BYPASS", "Bypass active"),
    6: ("LB", "Battery low"),
    7: ("OB", "Mains absent / running on battery"),
}

DEFAULT_NOMINAL_BATTERY_V = 24


class Sms1PhaseDriver(Driver):
    name = "SMS Brazil 1Phase (SMS Power Sinus NG)"
    protocol = "sms-1phase"
    transport = "usb-serial"
    source = "sms-1phase"
    CMD_STATUS = "Q"
    CMD_IDENTITY = "I"
    CMD_RATINGS = "F"
    # timed battery test (`T`): the duration goes in `Param1`; `D` aborts.
    CMD_TEST_10S = "T"
    CMD_TEST_ABORT = "D"
    read_size = RESULT_SIZE

    def __init__(self, device):
        super().__init__(device)
        # initial value; the F command confirms the nominal battery voltage
        self._nominal_battery_v = device.opt_int(
            "battery_voltage_nominal_v", DEFAULT_NOMINAL_BATTERY_V
        )

    def command_bytes(self, command: str) -> bytes:
        """Builds the 7 bytes of the read command: cmd + 4x 0xFF + checksum + <CR>."""
        return self._frame(command, (0xFF, 0xFF, 0xFF, 0xFF))

    def action_bytes(self, command: str, duration_s: float | None = None) -> bytes:
        """ACTION command; the test (`T`) requires the duration in `Param1`.

        `Param1 = 0xFF` is read by the firmware as "no defined duration" and makes
        the test run UNTIL THE BATTERY IS DISCHARGED (equivalent to the `L`
        command) — this was the 2026-10-22 incident
        (SMS/.../docs/tests-and-evidence.md T10).
        """
        params = (0xFF, 0xFF, 0xFF, 0xFF)
        if command == self.CMD_TEST_10S and duration_s is not None:
            # `0xFF` is reserved: the firmware reads it as "no duration" and runs
            # the test until the battery is discharged, so the ceiling here is `0xFE`.
            seconds = max(1, min(0xFE, int(round(duration_s))))
            params = (seconds, 0xFF, 0xFF, 0xFF)
        return self._frame(command, params)

    @staticmethod
    def _frame(command: str, params: tuple[int, int, int, int]) -> bytes:
        """Builds the 7-byte frame with the general checksum formula."""
        if len(command) != 1:
            raise ValueError(f"command must be a single character: {command!r}")
        payload = bytes([ord(command), *params])
        checksum = (-sum(payload)) & 0xFF
        return payload + bytes([checksum, RESPONSE_TERMINATOR])

    def parse_status(self, raw) -> dict:
        """Interprets the `Q` frame (meters + status)."""
        data = _to_bytes(raw)
        if data is None or len(data) < 16:
            raise ProtocolError(
                "invalid_response", "response to the Q command absent or too short", raw
            )
        if data[0] not in STATUS_START_CHARS:
            raise ProtocolError(
                "invalid_response",
                f"response to the Q command does not start with '<', '=' or '>' (byte {data[0]:#04x})",
                data,
            )
        if len(data) < RESULT_SIZE:
            raise ProtocolError(
                "incomplete_response",
                f"Q frame with {len(data)} bytes (expected {RESULT_SIZE})",
                data,
            )
        _check_checksum(data)

        status_byte = data[15]
        flags, active, bits = decode_status(status_byte)
        nominal = self._nominal_battery_v
        battery_charge_percent = _scaled(data, 11, "battery_charge_percent")
        return {
            "measurements": {
                "input_voltage_extended_v": _scaled(data, 1, "input_voltage_extended_v"),
                "input_voltage_v": _scaled(data, 3, "input_voltage_v"),
                "output_voltage_v": _scaled(data, 5, "output_voltage_v"),
                "load_percent": _scaled(data, 7, "load_percent"),
                "output_frequency_hz": _scaled(data, 9, "output_frequency_hz"),
                "temperature_c": _scaled(data, 13, "temperature_c"),
            },
            "status": {
                "raw_bits": bits,
                "raw_byte": status_byte,
                "active": active,
                "flags": flags,
            },
            "battery": {
                # the percentage COMES from the device (it is not estimated).
                "charge_percent": battery_charge_percent,
                "charge_source": "reported_by_device",
                # the voltage does NOT come in the frame: it is derived from nominal x percentage
                # (same rule as the NUT sms_ser driver).
                "voltage_v": battery_voltage(battery_charge_percent, nominal),
                "voltage_derived": True,
                "voltage_nominal_v": nominal,
                "packs": battery_packs(nominal),
            },
            "raw_frame": data.hex(" "),
        }

    def parse_identity(self, raw) -> dict:
        """Interprets the `I` frame (model + firmware, fixed widths)."""
        data = _to_bytes(raw)
        if data is None or len(data) < 4 or data[0] not in INFO_START_CHARS:
            raise ProtocolError(
                "invalid_response", "identification frame (I) does not start with ':' or ';'", raw
            )
        if len(data) < RESULT_SIZE:
            raise ProtocolError(
                "incomplete_response", f"I frame with {len(data)} bytes (expected {RESULT_SIZE})", data
            )
        _check_checksum(data)
        return {
            "model": data[1:13].decode("ascii", "replace").strip() or None,
            "firmware": data[13:16].decode("ascii", "replace").strip() or None,
            "raw_frame": data.hex(" "),
        }

    def parse_ratings(self, raw) -> dict:
        """Interprets the `F` frame (nominal ratings).

        Updates the nominal battery voltage used to derive the voltage in the Q
        frame (equivalent to `_battery_nominal_v` of the original SMS collector).
        """
        data = _to_bytes(raw)
        if data is None or len(data) < 4 or data[0] not in INFO_START_CHARS:
            raise ProtocolError(
                "invalid_response", "ratings frame (F) does not start with ':' or ';'", raw
            )
        if len(data) < RESULT_SIZE:
            raise ProtocolError(
                "incomplete_response", f"F frame with {len(data)} bytes (expected {RESULT_SIZE})", data
            )
        _check_checksum(data)

        voltage_label = _text(data[1:8])
        current_label = _text(data[8:11])
        battery_label = _text(data[11:14])
        frequency_label = _text(data[14:16])
        nominal_battery_v = _label_number(battery_label)
        if nominal_battery_v:
            self._nominal_battery_v = nominal_battery_v
        return {
            "voltage_label": voltage_label,
            "voltage_v": _label_number(voltage_label),
            "input_current_label": current_label,
            "input_current_a": _label_number(current_label),
            "battery_voltage_label": battery_label,
            "battery_voltage_v": nominal_battery_v,
            "frequency_label": frequency_label,
            "frequency_hz": _label_number(frequency_label),
            "raw_frame": data.hex(" "),
        }

    @property
    def nominal_battery_v(self) -> int:
        return self._nominal_battery_v


def decode_status(byte: int) -> tuple[dict, list, str]:
    """Converts the status byte into ({tag: bool}, [active tags], 'b7..b0')."""
    bits = f"{byte:08b}"
    flags: dict[str, bool] = {}
    active: list[str] = []
    for position, (tag, _description) in STATUS_BITS.items():
        on = bool(byte & (1 << position))
        flags[tag] = on
        if on:
            active.append(tag)
    return flags, active, bits


def battery_voltage(battery_charge_percent: float | None, nominal_v: int | None):
    """DERIVED battery voltage: nominal * percentage / 100 (sms_ser rule)."""
    if battery_charge_percent is None or not nominal_v:
        return None
    return round((nominal_v * battery_charge_percent) / 100.0, 2)


def battery_packs(nominal_v: int | None) -> int | None:
    """Number of 12 V batteries in series (nominal / 12), as in NUT."""
    if not nominal_v:
        return None
    return int(nominal_v) // 12


def _to_bytes(frame) -> bytes | None:
    if frame is None:
        return None
    if isinstance(frame, bytes):
        return frame
    if isinstance(frame, bytearray):
        return bytes(frame)
    # tolerates text responses (e.g. tests) by converting each character
    return str(frame).encode("latin-1", "replace")


def _check_checksum(data: bytes) -> None:
    expected = (-sum(data[:16])) & 0xFF
    if len(data) > 16 and data[16] != expected:
        raise ProtocolError(
            "checksum_error",
            f"frame checksum ({data[16]:#04x}) differs from the calculated one ({expected:#04x})",
            data,
        )


def _field(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 2], "big")


def _scaled(data: bytes, offset: int, field: str) -> float:
    value = round(_field(data, offset) / 10.0, 1)
    low, high = LIMITS[field]
    if not low <= value <= high:
        raise ProtocolError(
            "out_of_range",
            f"field {field} outside the plausible range ({low}..{high}): {value}",
            data,
        )
    return value


def _text(data: bytes) -> str:
    return data.decode("ascii", "replace").strip()


def _label_number(label: str):
    """Converts a textual label (e.g. '220', ' 24', '000') into a number."""
    digits = "".join(char for char in label if char.isdigit())
    if not digits:
        return None
    return int(digits)
