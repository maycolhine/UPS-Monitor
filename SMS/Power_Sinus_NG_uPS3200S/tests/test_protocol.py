"""Tests for the parser of the SMS Brazil 1Phase protocol (pure module)."""
from __future__ import annotations

import unittest

from api import protocol
from tests.support import (
    IDENT_FRAME,
    RATINGS_FRAME,
    STATUS_FRAME_BAD_CHECKSUM,
    STATUS_FRAME_OK,
    STATUS_FRAME_OUT_OF_RANGE,
    STATUS_FRAME_TEST,
)


def frame(start: int, body: bytes) -> bytes:
    """Build an 18-byte frame while validating the protocol checksum."""
    payload = bytes([start]) + body
    assert len(payload) == 16, len(payload)
    return payload + bytes([protocol.frame_checksum(payload), protocol.RESPONSE_TERMINATOR])


class StatusParsingTest(unittest.TestCase):
    def test_complete_valid_frame(self):
        parsed = protocol.parse_status_frame(STATUS_FRAME_OK)

        self.assertEqual(parsed["input_voltage_extended_v"], 0.0)
        self.assertEqual(parsed["input_voltage_v"], 217.7)
        self.assertEqual(parsed["output_voltage_v"], 217.7)
        self.assertEqual(parsed["load_percent"], 20.0)
        self.assertEqual(parsed["output_frequency_hz"], 59.9)
        self.assertEqual(parsed["battery_charge_percent"], 100.0)
        self.assertEqual(parsed["temperature_c"], 49.1)
        self.assertEqual(parsed["status_raw"], "00101001")
        self.assertEqual(parsed["status_byte"], 0x29)

    def test_status_flags(self):
        parsed = protocol.parse_status_frame(STATUS_FRAME_OK)

        self.assertTrue(parsed["status_flags"]["BEEP"])
        self.assertTrue(parsed["status_flags"]["UPSOK"])
        self.assertTrue(parsed["status_flags"]["BYPASS"])
        self.assertFalse(parsed["status_flags"]["LB"])
        self.assertFalse(parsed["status_flags"]["OB"])
        self.assertEqual(parsed["status_active"], ["BEEP", "UPSOK", "BYPASS"])

    def test_test_bit_in_progress(self):
        parsed = protocol.parse_status_frame(STATUS_FRAME_TEST)

        self.assertTrue(parsed["status_flags"]["TEST"])
        self.assertEqual(parsed["status_raw"], "00101101")
        self.assertIn("TEST", parsed["status_active"])

    def test_accepted_frame_starts(self):
        # '<' (0x3c) is also a valid start besides the captured '=' (0x3d).
        variant = frame(0x3C, STATUS_FRAME_OK[1:16])
        parsed = protocol.parse_status_frame(variant)

        self.assertEqual(parsed["output_voltage_v"], 217.7)

    def test_invalid_response(self):
        for raw in (b"", b"   ", b"OK", b"STRANGE RESPONSE"):
            with self.subTest(raw=raw):
                with self.assertRaises(protocol.ProtocolError) as ctx:
                    protocol.parse_status_frame(raw)
                self.assertEqual(ctx.exception.code, "invalid_response")

    def test_incomplete_frame(self):
        # partial read: starts with a valid start but is missing bytes/terminator.
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_status_frame(STATUS_FRAME_OK[:17])
        self.assertEqual(ctx.exception.code, "incomplete_response")

    def test_invalid_checksum(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_status_frame(STATUS_FRAME_BAD_CHECKSUM)
        self.assertEqual(ctx.exception.code, "checksum_error")

    def test_value_out_of_plausible_range(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_status_frame(STATUS_FRAME_OUT_OF_RANGE)
        self.assertEqual(ctx.exception.code, "out_of_range")


class IdentityParsingTest(unittest.TestCase):
    def test_identification_frame(self):
        parsed = protocol.parse_identity_frame(IDENT_FRAME)

        self.assertEqual(parsed["model"], "Power Sinus")
        self.assertEqual(parsed["firmware"], "1.2")

    def test_invalid_identification(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_identity_frame(b"NO RESPONSE")
        self.assertEqual(ctx.exception.code, "invalid_response")

    def test_ratings(self):
        parsed = protocol.parse_ratings_frame(RATINGS_FRAME)

        self.assertEqual(parsed["nominal_voltage_label"], "220")
        self.assertEqual(parsed["nominal_voltage_v"], 220)
        self.assertEqual(parsed["nominal_input_current_label"], "000")
        self.assertEqual(parsed["nominal_input_current_a"], 0)
        self.assertEqual(parsed["nominal_battery_voltage_v"], 24)
        self.assertEqual(parsed["nominal_frequency_hz"], 60)

    def test_ratings_without_numeric_value(self):
        parsed = protocol.parse_ratings_frame(frame(0x3B, b"Univ.  000 2460"))

        self.assertEqual(parsed["nominal_voltage_label"], "Univ.")
        self.assertIsNone(parsed["nominal_voltage_v"])
        self.assertEqual(parsed["nominal_battery_voltage_v"], 24)
        self.assertEqual(parsed["nominal_frequency_hz"], 60)


class BatteryDerivationTest(unittest.TestCase):
    def test_voltage_derived_from_percentage(self):
        # Rule of the NUT sms_ser driver: nominal * percentage / 100.
        self.assertEqual(protocol.battery_voltage(100.0, 24), 24.0)
        self.assertEqual(protocol.battery_voltage(50.0, 24), 12.0)
        self.assertEqual(protocol.battery_voltage(20.0, 24), 4.8)

    def test_number_of_batteries_in_series(self):
        self.assertEqual(protocol.battery_packs(24), 2)
        self.assertEqual(protocol.battery_packs(48), 4)
        self.assertIsNone(protocol.battery_packs(None))

    def test_no_data_does_not_derive(self):
        self.assertIsNone(protocol.battery_voltage(None, 24))
        self.assertIsNone(protocol.battery_voltage(100.0, None))


class CommandTest(unittest.TestCase):
    def test_7_byte_commands(self):
        self.assertEqual(protocol.CMD_STATUS, "Q")
        self.assertEqual(
            protocol.command_bytes("Q"),
            bytes([0x51, 0xFF, 0xFF, 0xFF, 0xFF, 0xB3, 0x0D]),
        )
        self.assertEqual(len(protocol.command_bytes("Q")), 7)

    def test_read_command_checksums(self):
        self.assertEqual(protocol.command_bytes("Q")[5], 0xB3)
        self.assertEqual(protocol.command_bytes("I")[5], 0xBB)
        self.assertEqual(protocol.command_bytes("F")[5], 0xBE)

    def test_invalid_command(self):
        with self.assertRaises(ValueError):
            protocol.command_bytes("Q1")


if __name__ == "__main__":
    unittest.main()
