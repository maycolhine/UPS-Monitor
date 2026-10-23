"""Megatec/Q1 command and frame parsing (pure module, no I/O).

Reference: docs/megatec-ts-shara-protocol.md and Spec.md (sections 4 to 7).

Only READ commands are implemented: Q1, I and F.
The commands T, TL and S (battery test / shutdown) MUST NOT be used.
"""
from __future__ import annotations

import re

CMD_STATUS = "Q1"
CMD_IDENTITY = "I"
CMD_RATINGS = "F"

COMMAND_TERMINATOR = "\r"

# Sanity limits accepted for each measurement. Frames outside these limits are
# rejected (out_of_range) so that the API never publishes fictitious values.
LIMITS = {
    "input_voltage_v": (0.0, 500.0),
    "input_voltage_fault_v": (0.0, 500.0),
    "output_voltage_v": (0.0, 500.0),
    "load_percent": (0.0, 200.0),
    "input_frequency_hz": (0.0, 100.0),
    "battery_voltage_v": (0.0, 100.0),
    "temperature_c": (-40.0, 125.0),
}

# Meaning of the status bits (b7 .. b0) per the Megatec specification.
STATUS_BITS = {
    7: ("OB", "Utility fail / running on battery"),
    6: ("LB", "Low battery"),
    5: ("BOOST", "Boost/Buck/Bypass active"),
    4: ("FAULT", "UPS failure"),
    3: ("STANDBY", "Standby/line-interactive type (0 = online)"),
    2: ("TEST", "Battery test in progress"),
    1: ("FSD", "Shutdown active"),
    0: ("BEEP", "Beeper on"),
}

# (MMM.M NNN.N PPP.P QQQ RR.R SS.S TT.T b7b6b5b4b3b2b1b0
Q1_FRAME_RE = re.compile(
    r"^\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([01]{8})"
)


class ProtocolError(Exception):
    """Received frame cannot be interpreted.

    Codes (API contract):
        invalid_response    - response does not contain a recognizable frame
        incomplete_response - recognizable but incomplete/malformed frame
        parse_error         - field present but not numeric
        out_of_range        - numeric field out of the plausible range
    """

    def __init__(self, code: str, message: str, raw: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.raw = raw


def command_bytes(command: str) -> bytes:
    """Builds the command bytes (ASCII + <CR>)."""
    return (command + COMMAND_TERMINATOR).encode("ascii")


def decode_status(bits: str) -> tuple[dict, list]:
    """Converts '10001001' (b7..b0) into ({tag: bool}, [active tags])."""
    flags: dict[str, bool] = {}
    active: list[str] = []
    for position, (tag, _description) in STATUS_BITS.items():
        on = position < len(bits) and bits[len(bits) - 1 - position] == "1"
        flags[tag] = on
        if on:
            active.append(tag)
    return flags, active


def parse_q1_frame(frame: str) -> dict:
    """Interprets the `Q1` frame (status + measurements).

    Returns the model field dictionary (without derived estimates).
    Raises ProtocolError when the frame is invalid, incomplete or suspicious.
    """
    text = _extract_frame(frame)
    if text is None:
        raise ProtocolError(
            "invalid_response",
            "response does not contain a Q1 frame (expected to start with '(')",
            frame,
        )

    match = Q1_FRAME_RE.match(text)
    if not match:
        raise ProtocolError("incomplete_response", "incomplete or malformed Q1 frame", text)

    bits = match.group(8)
    flags, active = decode_status(bits)
    return {
        "input_voltage_v": _number(match.group(1), "input_voltage_v"),
        "input_voltage_fault_v": _number(match.group(2), "input_voltage_fault_v"),
        "output_voltage_v": _number(match.group(3), "output_voltage_v"),
        "load_percent": _number(match.group(4), "load_percent", integer=True),
        "input_frequency_hz": _number(match.group(5), "input_frequency_hz"),
        "battery_voltage_v": _number(match.group(6), "battery_voltage_v"),
        "temperature_c": _number(match.group(7), "temperature_c"),
        "status_raw": bits,
        "status_flags": flags,
        "status_active": active,
        "raw_frame": text,
    }


def parse_identity_frame(frame: str) -> dict:
    """Interprets the `I` frame (manufacturer/model/version, fixed widths)."""
    text = (frame or "").strip()
    if not text.startswith("#"):
        raise ProtocolError("invalid_response", "identification frame (I) does not start with '#'", frame)
    if len(text) < 16:
        raise ProtocolError("incomplete_response", "identification frame (I) too short", text)
    body = text[1:]
    return {
        "manufacturer": body[:15].strip() or None,
        "model": body[16:26].strip() or None,
        "firmware": body[27:].strip() or None,
        "raw_frame": text,
    }


def parse_ratings_frame(frame: str) -> dict:
    """Interprets the `F` frame (nominal ratings, space-separated)."""
    text = (frame or "").strip()
    if not text.startswith("#"):
        raise ProtocolError("invalid_response", "ratings frame (F) does not start with '#'", frame)
    parts = text[1:].split()
    if not parts:
        raise ProtocolError("incomplete_response", "empty ratings frame (F)", text)

    def field(index: int):
        if len(parts) <= index:
            return None
        try:
            return float(parts[index])
        except ValueError:
            return None

    return {
        "nominal_voltage_label": parts[0],
        "nominal_voltage_v": field(0),
        "nominal_input_current_a": field(1),
        "nominal_battery_voltage_v": field(2),
        "nominal_frequency_hz": field(3),
        "raw_frame": text,
    }


def estimate_battery_charge(voltage_v: float | None, voltage_low_v: float, voltage_high_v: float):
    """ESTIMATED battery percentage by linear interpolation of the voltage.

    The Megatec/Q1 protocol does not transmit the percentage: it is derived from
    the voltage (Spec.md 7.3). Returns None when it cannot be estimated.
    """
    if voltage_v is None or voltage_high_v <= voltage_low_v:
        return None
    percent = 100.0 * (voltage_v - voltage_low_v) / (voltage_high_v - voltage_low_v)
    return round(min(100.0, max(0.0, percent)), 1)


def _extract_frame(raw: str | None) -> str | None:
    """Trims the frame from the first '(' (tolerates noise before the frame)."""
    if not raw:
        return None
    text = raw.strip()
    index = text.find("(")
    if index < 0:
        return None
    return text[index:].strip() or None


def _number(text: str, field: str, integer: bool = False):
    try:
        value = int(text) if integer else float(text)
    except (TypeError, ValueError):
        raise ProtocolError("parse_error", f"field {field} not numeric: {text!r}", text) from None
    low, high = LIMITS[field]
    if not low <= value <= high:
        raise ProtocolError(
            "out_of_range",
            f"field {field} out of the plausible range ({low}..{high}): {value}",
            text,
        )
    return value
