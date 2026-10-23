"""Tests of the Megatec/Q1 parser (pure module)."""
from __future__ import annotations

import unittest

from api import protocol
from tests.support import IDENT_FRAME, Q1_FRAME_OK, Q1_FRAME_TEST, RATINGS_FRAME


class Q1ParsingTest(unittest.TestCase):
    def test_full_valid_frame(self):
        parsed = protocol.parse_q1_frame(Q1_FRAME_OK)

        self.assertEqual(parsed["input_voltage_v"], 228.0)
        self.assertEqual(parsed["input_voltage_fault_v"], 228.0)
        self.assertEqual(parsed["output_voltage_v"], 115.0)
        self.assertEqual(parsed["load_percent"], 9)
        self.assertEqual(parsed["input_frequency_hz"], 60.0)
        self.assertEqual(parsed["battery_voltage_v"], 23.8)
        self.assertEqual(parsed["temperature_c"], 26.0)
        self.assertEqual(parsed["status_raw"], "10001001")

    def test_status_flags(self):
        parsed = protocol.parse_q1_frame(Q1_FRAME_OK)

        self.assertTrue(parsed["status_flags"]["OB"])
        self.assertTrue(parsed["status_flags"]["STANDBY"])
        self.assertTrue(parsed["status_flags"]["BEEP"])
        self.assertFalse(parsed["status_flags"]["LB"])
        self.assertEqual(parsed["status_active"], ["OB", "STANDBY", "BEEP"])

    def test_test_bit_in_progress(self):
        parsed = protocol.parse_q1_frame(Q1_FRAME_TEST)

        self.assertTrue(parsed["status_flags"]["TEST"])
        self.assertEqual(parsed["status_raw"], "10001101")
        self.assertIn("TEST", parsed["status_active"])

    def test_terminator_and_noise_before_frame(self):
        parsed = protocol.parse_q1_frame("  1234567ABC " + Q1_FRAME_OK + "\r")

        self.assertEqual(parsed["output_voltage_v"], 115.0)
        self.assertTrue(parsed["raw_frame"].startswith("("))

    def test_invalid_response(self):
        for frame in ("", "   ", "OK", "NO FRAME HERE 12345"):
            with self.assertRaises(protocol.ProtocolError) as ctx:
                protocol.parse_q1_frame(frame)
            self.assertEqual(ctx.exception.code, "invalid_response")

    def test_incomplete_frame(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_q1_frame("(002.0 002.0 115.0")
        self.assertEqual(ctx.exception.code, "incomplete_response")

    def test_non_numeric_field(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_q1_frame("(1.2.3 002.0 115.0 009 60.0 23.8 26.0 10001001")
        self.assertEqual(ctx.exception.code, "parse_error")

    def test_value_out_of_plausible_range(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_q1_frame("(999.0 002.0 115.0 009 60.0 23.8 26.0 10001001")
        self.assertEqual(ctx.exception.code, "out_of_range")


class IdentityParsingTest(unittest.TestCase):
    def test_identification_frame(self):
        parsed = protocol.parse_identity_frame(IDENT_FRAME)

        self.assertEqual(parsed["manufacturer"], "TS SHARA")
        self.assertEqual(parsed["model"], "SENO3.2kVA")
        self.assertEqual(parsed["firmware"], "26.000.000")

    def test_fixed_widths_with_variable_manufacturer(self):
        parsed = protocol.parse_identity_frame("#TS -222  091225 Senoid  32 V01020805A")

        self.assertEqual(parsed["manufacturer"], "TS -222  091225")
        self.assertEqual(parsed["model"], "Senoid  32")
        self.assertEqual(parsed["firmware"], "V01020805A")

    def test_invalid_identification(self):
        with self.assertRaises(protocol.ProtocolError) as ctx:
            protocol.parse_identity_frame("NO RESPONSE")
        self.assertEqual(ctx.exception.code, "invalid_response")

    def test_ratings(self):
        parsed = protocol.parse_ratings_frame(RATINGS_FRAME)

        self.assertEqual(parsed["nominal_voltage_label"], "115.0")
        self.assertEqual(parsed["nominal_voltage_v"], 115.0)
        self.assertEqual(parsed["nominal_input_current_a"], 100.0)
        self.assertEqual(parsed["nominal_battery_voltage_v"], 24.0)
        self.assertEqual(parsed["nominal_frequency_hz"], 60.0)

    def test_ratings_without_numeric_value(self):
        parsed = protocol.parse_ratings_frame("#Univ. 100 24.00")

        self.assertEqual(parsed["nominal_voltage_label"], "Univ.")
        self.assertIsNone(parsed["nominal_voltage_v"])
        self.assertEqual(parsed["nominal_battery_voltage_v"], 24.0)
        self.assertIsNone(parsed["nominal_frequency_hz"])


class BatteryEstimateTest(unittest.TestCase):
    def test_adopted_calibration(self):
        # Limits calibrated against the TS App (Spec.md 7.3.4).
        self.assertAlmostEqual(protocol.estimate_battery_charge(23.8, 20.1, 26.8), 55.2, delta=0.2)
        self.assertAlmostEqual(protocol.estimate_battery_charge(20.8, 20.1, 26.8), 10.4, delta=0.5)

    def test_limits_saturate(self):
        self.assertEqual(protocol.estimate_battery_charge(30.0, 20.1, 26.8), 100.0)
        self.assertEqual(protocol.estimate_battery_charge(19.0, 20.1, 26.8), 0.0)

    def test_without_voltage_does_not_estimate(self):
        self.assertIsNone(protocol.estimate_battery_charge(None, 20.1, 26.8))
        self.assertIsNone(protocol.estimate_battery_charge(24.0, 26.8, 20.1))


class CommandTest(unittest.TestCase):
    def test_command_with_cr_terminator(self):
        self.assertEqual(protocol.command_bytes("Q1"), b"Q1\r")
        self.assertEqual(protocol.CMD_STATUS, "Q1")
        self.assertEqual(protocol.CMD_IDENTITY, "I")
        self.assertEqual(protocol.CMD_RATINGS, "F")


if __name__ == "__main__":
    unittest.main()
