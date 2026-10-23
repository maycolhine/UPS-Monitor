"""Commands and parsing of the SMS Brazil 1Phase protocol frames (pure module).

Reference: docs/sms-1phase-protocol.md and Spec.md (sections 3 to 7).

Unlike Megatec/Q1 (text), the SMS uses a BINARY protocol: each command has
7 bytes (letter + 4 parameters 0xFF + checksum + <CR>) and each response has
18 bytes (header + hexadecimal fields + checksum + <CR>).

Only READ commands are implemented: Q (measurements/status), I (information)
and F (ratings). The action commands L, T, M, S (battery test, beep and
shutdown) must NOT be used.
"""
from __future__ import annotations

CMD_STATUS = "Q"
CMD_IDENTITY = "I"
CMD_RATINGS = "F"

# Size of a response frame and terminator.
RESULT_SIZE = 18
RESPONSE_TERMINATOR = 0x0D
# First byte accepted as the start of a response.
STATUS_START_CHARS = (0x3C, 0x3D, 0x3E)  # '<', '=', '>'
INFO_START_CHARS = (0x3A, 0x3B)          # ':', ';'

# Sanity limits accepted for each measurement. Frames outside these limits are
# rejected (out_of_range) so that the API never publishes fictitious values.
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
    6: ("LB", "Low battery"),
    7: ("OB", "Mains absent / running on battery"),
}


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


def command_bytes(command: str) -> bytes:
    """Builds the 7 bytes of the command.

    Format: <cmd> 0xFF 0xFF 0xFF 0xFF <checksum> <CR>, with
    checksum = ((code) + 4 * (-1)) * -1  (modulo 256).
    """
    if len(command) != 1:
        raise ValueError(f"command must be a single character: {command!r}")
    code = ord(command)
    checksum = (4 - code) & 0xFF
    return bytes([code, 0xFF, 0xFF, 0xFF, 0xFF, checksum, RESPONSE_TERMINATOR])


def frame_checksum(payload: bytes) -> int:
    """Checksum of the response frames: (-sum(bytes 0..15)) & 0xFF."""
    return (-sum(payload)) & 0xFF


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


def parse_status_frame(frame) -> dict:
    """Interprets the `Q` frame (measurements + status).

    Returns the dictionary of model fields. Raises ProtocolError when the
    frame is invalid, incomplete, has a wrong checksum or a suspicious value.
    """
    raw = _to_bytes(frame)
    if raw is None or len(raw) < 16:
        raise ProtocolError(
            "invalid_response", "response to command Q missing or too short", frame
        )
    if raw[0] not in STATUS_START_CHARS:
        raise ProtocolError(
            "invalid_response",
            f"response to command Q does not start with '<', '=' or '>' (byte {raw[0]:#04x})",
            raw,
        )
    if len(raw) < RESULT_SIZE:
        raise ProtocolError(
            "incomplete_response", f"Q frame with {len(raw)} bytes (expected {RESULT_SIZE})", raw
        )
    _check_checksum(raw)

    status_byte = raw[15]
    flags, active, bits = decode_status(status_byte)
    return {
        "input_voltage_extended_v": _scaled(raw, 1, "input_voltage_extended_v"),
        "input_voltage_v": _scaled(raw, 3, "input_voltage_v"),
        "output_voltage_v": _scaled(raw, 5, "output_voltage_v"),
        "load_percent": _scaled(raw, 7, "load_percent"),
        "output_frequency_hz": _scaled(raw, 9, "output_frequency_hz"),
        "battery_charge_percent": _scaled(raw, 11, "battery_charge_percent"),
        "temperature_c": _scaled(raw, 13, "temperature_c"),
        "status_raw": bits,
        "status_byte": status_byte,
        "status_flags": flags,
        "status_active": active,
        "raw_frame": raw.hex(" "),
    }


def parse_identity_frame(frame) -> dict:
    """Interprets the `I` frame (model + firmware version, fixed widths).

    Format: ':' + model (chars 1..12) + version (chars 13..15) + CK + <CR>.
    """
    raw = _to_bytes(frame)
    if raw is None or len(raw) < 4 or raw[0] not in INFO_START_CHARS:
        raise ProtocolError(
            "invalid_response", "identification frame (I) does not start with ':' or ';'", frame
        )
    if len(raw) < RESULT_SIZE:
        raise ProtocolError(
            "incomplete_response", f"I frame with {len(raw)} bytes (expected {RESULT_SIZE})", raw
        )
    _check_checksum(raw)
    return {
        "model": raw[1:13].decode("ascii", "replace").strip() or None,
        "firmware": raw[13:16].decode("ascii", "replace").strip() or None,
        "raw_frame": raw.hex(" "),
    }


def parse_ratings_frame(frame) -> dict:
    """Interprets the `F` frame (nominal ratings).

    Format: ';' + voltage range (chars 1..7, 14) + current range
    (chars 8..10, 6) + battery voltage (chars 11..13, 6) + frequency
    (chars 14..15, 4) + CK + <CR>.
    """
    raw = _to_bytes(frame)
    if raw is None or len(raw) < 4 or raw[0] not in INFO_START_CHARS:
        raise ProtocolError(
            "invalid_response", "ratings frame (F) does not start with ':' or ';'", frame
        )
    if len(raw) < RESULT_SIZE:
        raise ProtocolError(
            "incomplete_response", f"F frame with {len(raw)} bytes (expected {RESULT_SIZE})", raw
        )
    _check_checksum(raw)

    voltage_label = _text(raw[1:8])
    current_label = _text(raw[8:11])
    battery_label = _text(raw[11:14])
    frequency_label = _text(raw[14:16])
    return {
        "nominal_voltage_label": voltage_label,
        "nominal_voltage_v": _label_number(voltage_label),
        "nominal_input_current_label": current_label,
        "nominal_input_current_a": _label_number(current_label),
        "nominal_battery_voltage_label": battery_label,
        "nominal_battery_voltage_v": _label_number(battery_label),
        "nominal_frequency_label": frequency_label,
        "nominal_frequency_hz": _label_number(frequency_label),
        "raw_frame": raw.hex(" "),
    }


def battery_voltage(battery_charge_percent: float | None, nominal_v: int | None):
    """Battery voltage DERIVED by the protocol itself.

    The `Q` frame transmits the charge PERCENTAGE, not the voltage. The voltage
    is computed as `nominal * percentage / 100` — the same rule used by the NUT
    `sms_ser` driver. Returns None when it cannot be computed.
    """
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


def _check_checksum(raw: bytes) -> None:
    expected = frame_checksum(raw[:16])
    if len(raw) > 16 and raw[16] != expected:
        raise ProtocolError(
            "checksum_error",
            f"frame checksum ({raw[16]:#04x}) differs from the computed one ({expected:#04x})",
            raw,
        )


def _field(raw: bytes, offset: int) -> int:
    return int.from_bytes(raw[offset:offset + 2], "big")


def _scaled(raw: bytes, offset: int, field: str) -> float:
    value = round(_field(raw, offset) / 10.0, 1)
    low, high = LIMITS[field]
    if not low <= value <= high:
        raise ProtocolError(
            "out_of_range",
            f"field {field} out of the plausible range ({low}..{high}): {value}",
            raw,
        )
    return value


def _text(raw: bytes) -> str:
    return raw.decode("ascii", "replace").strip()


def _label_number(label: str):
    """Converts a textual label (e.g.: '220', ' 24', '000') into a number."""
    digits = "".join(char for char in label if char.isdigit())
    if not digits:
        return None
    value = int(digits)
    return value
