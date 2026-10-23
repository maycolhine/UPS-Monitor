"""Megatec/Q1 protocol driver (ASCII text) — used by the TS Shara.

Reference: TS_Shara/Universal_UPS_Senoidal_3200VA/docs/megatec-ts-shara-protocol.md.

READ commands: Q1, I and F. As an ACTION, the Megatec protocol offers the ~10 s
battery test (`T`): the UPS runs it and **does not respond** (fire-and-forget).
The test until battery low (`TL`) and shutdown (`S`) are NOT declared and,
therefore, cannot be sent through the API. There is no mapped abort command —
"aborting" only means stopping the sampling (the UPS completes the ~10 s
internally).

Battery particularity: the protocol does NOT transmit the percentage, only the
voltage. The percentage is ESTIMATED by linear interpolation (calibration per
device in `battery_voltage_low_v` / `battery_voltage_high_v`).
"""
from __future__ import annotations

import re

from . import Driver, ProtocolError

COMMAND_TERMINATOR = "\r"

# Sanity limits accepted for each measurement.
LIMITS = {
    "input_voltage_v": (0.0, 500.0),
    "input_voltage_fault_v": (0.0, 500.0),
    "output_voltage_v": (0.0, 500.0),
    "load_percent": (0.0, 200.0),
    "input_frequency_hz": (0.0, 100.0),
    "battery_voltage_v": (0.0, 100.0),
    "temperature_c": (-40.0, 125.0),
}

# Meaning of the status bits (b7 .. b0) according to the Megatec specification.
STATUS_BITS = {
    7: ("OB", "Mains absent / running on battery"),
    6: ("LB", "Battery low"),
    5: ("BOOST", "Boost/Buck/Bypass active"),
    4: ("FAULT", "UPS fault"),
    3: ("STANDBY", "Standby/line-interactive type (0 = online)"),
    2: ("TEST", "Battery test in progress"),
    1: ("FSD", "Shutdown active"),
    0: ("BEEP", "Beeper on"),
}

# (MMM.M NNN.N PPP.P QQQ RR.R SS.S TT.T b7b6b5b4b3b2b1b0
Q1_FRAME_RE = re.compile(
    r"^\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([01]{8})"
)

DEFAULT_VOLTAGE_LOW_V = 20.1
DEFAULT_VOLTAGE_HIGH_V = 26.8


class MegatecQ1Driver(Driver):
    name = "Megatec/Q1 (TS Shara)"
    protocol = "megatec-q1"
    transport = "usb-serial-cdc-acm"
    source = "megatec-q1"
    CMD_STATUS = "Q1"
    CMD_IDENTITY = "I"
    CMD_RATINGS = "F"
    # ~10 s battery test (`T\r`): runs without responding; no abort.
    CMD_TEST_10S = "T"
    CMD_TEST_ABORT = None
    read_size = None  # text protocol: reads until timeout

    def __init__(self, device):
        super().__init__(device)
        self._voltage_low_v = device.opt_float("battery_voltage_low_v", DEFAULT_VOLTAGE_LOW_V)
        self._voltage_high_v = device.opt_float("battery_voltage_high_v", DEFAULT_VOLTAGE_HIGH_V)

    def command_bytes(self, command: str) -> bytes:
        """Builds the command bytes (ASCII + <CR>)."""
        return (command + COMMAND_TERMINATOR).encode("ascii")

    def parse_status(self, raw) -> dict:
        """Interprets the `Q1` frame (status + measurements)."""
        text = _extract_frame(_decode(raw))
        if text is None:
            raise ProtocolError(
                "invalid_response",
                "response does not contain a Q1 frame (expected to start with '(')",
                raw,
            )

        match = Q1_FRAME_RE.match(text)
        if not match:
            raise ProtocolError("incomplete_response", "Q1 frame incomplete or malformed", text)

        bits = match.group(8)
        flags, active = decode_status(bits)
        battery_voltage_v = _number(match.group(6), "battery_voltage_v")
        return {
            "measurements": {
                "input_voltage_v": _number(match.group(1), "input_voltage_v"),
                "input_voltage_fault_v": _number(match.group(2), "input_voltage_fault_v"),
                "output_voltage_v": _number(match.group(3), "output_voltage_v"),
                "load_percent": _number(match.group(4), "load_percent", integer=True),
                "input_frequency_hz": _number(match.group(5), "input_frequency_hz"),
                "battery_voltage_v": battery_voltage_v,
                "temperature_c": _number(match.group(7), "temperature_c"),
            },
            "status": {"raw_bits": bits, "active": active, "flags": flags},
            "battery_charge": {
                "percent": estimate_battery_charge(
                    battery_voltage_v, self._voltage_low_v, self._voltage_high_v
                ),
                "estimated": True,
                "method": "linear_voltage_interpolation",
                "calibration": {
                    "voltage_low_v": self._voltage_low_v,
                    "voltage_high_v": self._voltage_high_v,
                },
            },
            "raw_frame": text,
        }

    def parse_identity(self, raw) -> dict:
        """Interprets the `I` frame (manufacturer/model/version, fixed widths)."""
        text = _decode(raw).strip()
        if not text.startswith("#"):
            raise ProtocolError(
                "invalid_response", "identification frame (I) does not start with '#'", raw
            )
        if len(text) < 16:
            raise ProtocolError("incomplete_response", "identification frame (I) too short", text)
        body = text[1:]
        return {
            "manufacturer": body[:15].strip() or None,
            "model": body[16:26].strip() or None,
            "firmware": body[27:].strip() or None,
            "raw_frame": text,
        }

    def parse_ratings(self, raw) -> dict:
        """Interprets the `F` frame (nominal ratings, separated by spaces)."""
        text = _decode(raw).strip()
        if not text.startswith("#"):
            raise ProtocolError(
                "invalid_response", "ratings frame (F) does not start with '#'", raw
            )
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
            "voltage_label": parts[0],
            "voltage_v": field(0),
            "input_current_a": field(1),
            "battery_voltage_v": field(2),
            "frequency_hz": field(3),
            "raw_frame": text,
        }


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


def estimate_battery_charge(voltage_v: float | None, voltage_low_v: float, voltage_high_v: float):
    """ESTIMATED battery percentage by linear interpolation of the voltage.

    The Megatec/Q1 protocol does not transmit the percentage: it is derived from
    the voltage. Returns None when it is not possible to estimate.
    """
    if voltage_v is None or voltage_high_v <= voltage_low_v:
        return None
    percent = 100.0 * (voltage_v - voltage_low_v) / (voltage_high_v - voltage_low_v)
    return round(min(100.0, max(0.0, percent)), 1)


def _decode(raw) -> str:
    if raw is None:
        return ""
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw).decode("ascii", "replace")
    return str(raw)


def _extract_frame(raw: str | None) -> str | None:
    """Cuts the frame starting from the first '(' (tolerates noise before the frame)."""
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
            f"field {field} outside the plausible range ({low}..{high}): {value}",
            text,
        )
    return value
