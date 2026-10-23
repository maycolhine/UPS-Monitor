"""Protocol driver tests (pure modules, no I/O)."""
from __future__ import annotations

import unittest

from upsmon.drivers import ProtocolError, available_protocols, create_driver
from upsmon.drivers.megatec_q1 import MegatecQ1Driver, estimate_battery_charge
from upsmon.drivers.sms_1phase import Sms1PhaseDriver, battery_packs, battery_voltage
from tests.support import (
    MEGATEC_IDENT_FRAME,
    MEGATEC_RATINGS_FRAME,
    MEGATEC_STATUS_OK,
    MEGATEC_STATUS_TEST,
    SMS_IDENT_FRAME,
    SMS_RATINGS_FRAME,
    SMS_STATUS_BAD_CHECKSUM,
    SMS_STATUS_OK,
    SMS_STATUS_OUT_OF_RANGE,
    SMS_STATUS_TEST,
    megatec_device,
    sms_device,
)


class RegistryTest(unittest.TestCase):
    def test_available_protocols(self):
        self.assertEqual(set(available_protocols()), {"megatec-q1", "sms-1phase"})

    def test_driver_by_protocol(self):
        self.assertIsInstance(create_driver(sms_device()), Sms1PhaseDriver)
        self.assertIsInstance(create_driver(megatec_device()), MegatecQ1Driver)

    def test_unknown_protocol(self):
        with self.assertRaises(ValueError):
            create_driver(sms_device(protocol="unknown"))


class ActionCommandsTest(unittest.TestCase):
    """ACTION commands declared per protocol (battery test and abort)."""

    def test_sms_declares_test_and_abort(self):
        driver = Sms1PhaseDriver(sms_device())

        self.assertEqual(driver.CMD_TEST_10S, "T")
        self.assertEqual(driver.CMD_TEST_ABORT, "D")
        self.assertTrue(driver.supports_battery_test)
        self.assertTrue(driver.supports_test_abort)
        self.assertEqual(driver.command_bytes("T"), b"T\xff\xff\xff\xff\xb0\r")
        self.assertEqual(driver.command_bytes("D"), b"D\xff\xff\xff\xff\xc0\r")

    def test_sms_test_carries_the_duration_in_param1(self):
        """Without `Param1` the firmware runs the test until battery low (incident T10)."""
        driver = Sms1PhaseDriver(sms_device())

        self.assertEqual(driver.action_bytes("T", 10.0), b"T\x0a\xff\xff\xff\xa5\r")
        self.assertEqual(driver.action_bytes("D", None), b"D\xff\xff\xff\xff\xc0\r")

        # `0xFF` is never used as duration: the ceiling is `0xFE` and the checksum follows
        # the general formula (-sum(bytes[0..4])) & 0xFF valid for any Param1.
        payload = driver.action_bytes("T", 999.0)
        self.assertEqual(payload[1], 0xFE)
        self.assertEqual(payload[5], (-sum(payload[:5])) & 0xFF)

    def test_megatec_declares_test_without_abort(self):
        driver = MegatecQ1Driver(megatec_device())

        self.assertEqual(driver.CMD_TEST_10S, "T")
        self.assertIsNone(driver.CMD_TEST_ABORT)
        self.assertTrue(driver.supports_battery_test)
        self.assertFalse(driver.supports_test_abort)
        self.assertEqual(driver.command_bytes("T"), b"T\r")


class SmsCommandTest(unittest.TestCase):
    def test_command_has_seven_bytes_with_checksum(self):
        driver = Sms1PhaseDriver(sms_device())

        self.assertEqual(driver.command_bytes("Q"), b"Q\xff\xff\xff\xff\xb3\r")
        self.assertEqual(driver.read_size, 18)

    def test_command_requires_a_single_character(self):
        with self.assertRaises(ValueError):
            Sms1PhaseDriver(sms_device()).command_bytes("QQ")


class SmsStatusParsingTest(unittest.TestCase):
    def setUp(self):
        self.driver = Sms1PhaseDriver(sms_device())

    def test_complete_valid_frame(self):
        parsed = self.driver.parse_status(SMS_STATUS_OK)

        measurements = parsed["measurements"]
        self.assertEqual(measurements["input_voltage_extended_v"], 0.0)
        self.assertEqual(measurements["input_voltage_v"], 217.7)
        self.assertEqual(measurements["output_voltage_v"], 217.7)
        self.assertEqual(measurements["load_percent"], 20.0)
        self.assertEqual(measurements["output_frequency_hz"], 59.9)
        self.assertEqual(measurements["temperature_c"], 49.1)
        self.assertEqual(parsed["status"]["raw_byte"], 0x29)
        self.assertEqual(parsed["status"]["raw_bits"], "00101001")

    def test_status_flags(self):
        parsed = self.driver.parse_status(SMS_STATUS_OK)

        flags = parsed["status"]["flags"]
        self.assertTrue(flags["BEEP"])
        self.assertTrue(flags["UPSOK"])
        self.assertTrue(flags["BYPASS"])
        self.assertFalse(flags["LB"])
        self.assertEqual(parsed["status"]["active"], ["BEEP", "UPSOK", "BYPASS"])

    def test_test_bit(self):
        parsed = self.driver.parse_status(SMS_STATUS_TEST)

        self.assertTrue(parsed["status"]["flags"]["TEST"])
        self.assertEqual(parsed["status"]["raw_bits"], "00101101")

    def test_percentage_comes_from_device_and_voltage_is_derived(self):
        battery = self.driver.parse_status(SMS_STATUS_OK)["battery"]

        self.assertEqual(battery["charge_percent"], 100.0)
        self.assertEqual(battery["charge_source"], "reported_by_device")
        self.assertTrue(battery["voltage_derived"])
        self.assertEqual(battery["voltage_nominal_v"], 24)
        self.assertEqual(battery["voltage_v"], 24.0)
        self.assertEqual(battery["packs"], 2)

    def test_invalid_response(self):
        for raw in (b"", b"   ", b"OK", b"STRANGE RESPONSE"):
            with self.subTest(raw=raw):
                with self.assertRaises(ProtocolError) as ctx:
                    self.driver.parse_status(raw)
                self.assertEqual(ctx.exception.code, "invalid_response")

    def test_incomplete_frame(self):
        with self.assertRaises(ProtocolError) as ctx:
            self.driver.parse_status(SMS_STATUS_OK[:17])
        self.assertEqual(ctx.exception.code, "incomplete_response")

    def test_invalid_checksum(self):
        with self.assertRaises(ProtocolError) as ctx:
            self.driver.parse_status(SMS_STATUS_BAD_CHECKSUM)
        self.assertEqual(ctx.exception.code, "checksum_error")

    def test_value_out_of_range(self):
        with self.assertRaises(ProtocolError) as ctx:
            self.driver.parse_status(SMS_STATUS_OUT_OF_RANGE)
        self.assertEqual(ctx.exception.code, "out_of_range")


class SmsIdentityParsingTest(unittest.TestCase):
    def test_identification(self):
        parsed = Sms1PhaseDriver(sms_device()).parse_identity(SMS_IDENT_FRAME)

        self.assertEqual(parsed["model"], "Power Sinus")
        self.assertEqual(parsed["firmware"], "1.2")

    def test_nominal_ratings(self):
        parsed = Sms1PhaseDriver(sms_device()).parse_ratings(SMS_RATINGS_FRAME)

        self.assertEqual(parsed["voltage_v"], 220)
        self.assertEqual(parsed["input_current_a"], 0)
        self.assertEqual(parsed["battery_voltage_v"], 24)
        self.assertEqual(parsed["frequency_hz"], 60)

    def test_frame_F_updates_the_nominal_voltage_used_in_frame_Q(self):
        driver = Sms1PhaseDriver(sms_device(battery_voltage_nominal_v=48))
        self.assertEqual(driver.parse_status(SMS_STATUS_OK)["battery"]["voltage_nominal_v"], 48)

        driver.parse_ratings(SMS_RATINGS_FRAME)  # confirms 24 V on the battery
        battery = driver.parse_status(SMS_STATUS_OK)["battery"]
        self.assertEqual(battery["voltage_nominal_v"], 24)
        self.assertEqual(battery["voltage_v"], 24.0)
        self.assertEqual(battery["packs"], 2)

    def test_invalid_identification(self):
        with self.assertRaises(ProtocolError) as ctx:
            Sms1PhaseDriver(sms_device()).parse_identity(b"NO RESPONSE")
        self.assertEqual(ctx.exception.code, "invalid_response")


class SmsHelpersTest(unittest.TestCase):
    def test_derived_voltage(self):
        self.assertEqual(battery_voltage(100.0, 24), 24.0)
        self.assertEqual(battery_voltage(50.0, 24), 12.0)
        self.assertIsNone(battery_voltage(None, 24))
        self.assertIsNone(battery_voltage(50.0, 0))

    def test_number_of_batteries(self):
        self.assertEqual(battery_packs(24), 2)
        self.assertEqual(battery_packs(48), 4)
        self.assertIsNone(battery_packs(0))


class MegatecCommandTest(unittest.TestCase):
    def test_ascii_command_with_cr(self):
        driver = MegatecQ1Driver(megatec_device())

        self.assertEqual(driver.command_bytes("Q1"), b"Q1\r")
        self.assertEqual((driver.CMD_STATUS, driver.CMD_IDENTITY, driver.CMD_RATINGS), ("Q1", "I", "F"))
        self.assertIsNone(driver.read_size)


class MegatecStatusParsingTest(unittest.TestCase):
    def setUp(self):
        self.driver = MegatecQ1Driver(megatec_device())

    def test_complete_valid_frame(self):
        parsed = self.driver.parse_status(MEGATEC_STATUS_OK)

        measurements = parsed["measurements"]
        self.assertEqual(measurements["input_voltage_v"], 228.0)
        self.assertEqual(measurements["input_voltage_fault_v"], 228.0)
        self.assertEqual(measurements["output_voltage_v"], 115.0)
        self.assertEqual(measurements["load_percent"], 9)
        self.assertEqual(measurements["input_frequency_hz"], 60.0)
        self.assertEqual(measurements["battery_voltage_v"], 23.8)
        self.assertEqual(measurements["temperature_c"], 26.0)
        self.assertEqual(parsed["status"]["raw_bits"], "10001001")
        # the Megatec protocol does not expose `output_frequency_hz` (only the input one)
        self.assertNotIn("output_frequency_hz", measurements)

    def test_status_flags(self):
        parsed = self.driver.parse_status(MEGATEC_STATUS_OK)

        flags = parsed["status"]["flags"]
        self.assertTrue(flags["OB"])
        self.assertTrue(flags["STANDBY"])
        self.assertTrue(flags["BEEP"])
        self.assertFalse(flags["LB"])
        self.assertEqual(parsed["status"]["active"], ["OB", "STANDBY", "BEEP"])

    def test_test_bit(self):
        parsed = self.driver.parse_status(MEGATEC_STATUS_TEST)
        self.assertTrue(parsed["status"]["flags"]["TEST"])
        self.assertEqual(parsed["status"]["raw_bits"], "10001101")

    def test_percentage_is_estimated_from_voltage(self):
        charge = self.driver.parse_status(MEGATEC_STATUS_OK)["battery_charge"]

        self.assertTrue(charge["estimated"])
        self.assertEqual(charge["method"], "linear_voltage_interpolation")
        self.assertAlmostEqual(charge["percent"], 55.2, delta=0.2)
        self.assertEqual(charge["calibration"], {"voltage_low_v": 20.1, "voltage_high_v": 26.8})
        self.assertNotIn("battery", self.driver.parse_status(MEGATEC_STATUS_OK))

    def test_noise_before_the_frame_is_tolerated(self):
        parsed = self.driver.parse_status("  1234567ABC " + MEGATEC_STATUS_OK + "\r")
        self.assertEqual(parsed["measurements"]["output_voltage_v"], 115.0)
        self.assertTrue(parsed["raw_frame"].startswith("("))

    def test_invalid_response(self):
        for raw in ("", "   ", "OK", "NO FRAME HERE 12345"):
            with self.subTest(raw=raw):
                with self.assertRaises(ProtocolError) as ctx:
                    self.driver.parse_status(raw)
                self.assertEqual(ctx.exception.code, "invalid_response")

    def test_incomplete_frame(self):
        with self.assertRaises(ProtocolError) as ctx:
            self.driver.parse_status("(002.0 002.0 115.0")
        self.assertEqual(ctx.exception.code, "incomplete_response")

    def test_non_numeric_field(self):
        with self.assertRaises(ProtocolError) as ctx:
            self.driver.parse_status("(1.2.3 002.0 115.0 009 60.0 23.8 26.0 10001001")
        self.assertEqual(ctx.exception.code, "parse_error")

    def test_value_out_of_range(self):
        with self.assertRaises(ProtocolError) as ctx:
            self.driver.parse_status("(999.0 002.0 115.0 009 60.0 23.8 26.0 10001001")
        self.assertEqual(ctx.exception.code, "out_of_range")


class MegatecIdentityParsingTest(unittest.TestCase):
    def test_identification(self):
        parsed = MegatecQ1Driver(megatec_device()).parse_identity(MEGATEC_IDENT_FRAME)

        self.assertEqual(parsed["manufacturer"], "TS SHARA")
        self.assertEqual(parsed["model"], "SENO3.2kVA")
        self.assertEqual(parsed["firmware"], "26.000.000")

    def test_nominal_ratings(self):
        parsed = MegatecQ1Driver(megatec_device()).parse_ratings(MEGATEC_RATINGS_FRAME)

        self.assertEqual(parsed["voltage_v"], 115.0)
        self.assertEqual(parsed["input_current_a"], 100.0)
        self.assertEqual(parsed["battery_voltage_v"], 24.0)
        self.assertEqual(parsed["frequency_hz"], 60.0)

    def test_invalid_identification(self):
        with self.assertRaises(ProtocolError) as ctx:
            MegatecQ1Driver(megatec_device()).parse_identity("NO RESPONSE")
        self.assertEqual(ctx.exception.code, "invalid_response")


class MegatecBatteryEstimateTest(unittest.TestCase):
    def test_adopted_calibration(self):
        self.assertAlmostEqual(estimate_battery_charge(23.8, 20.1, 26.8), 55.2, delta=0.2)
        self.assertAlmostEqual(estimate_battery_charge(20.8, 20.1, 26.8), 10.4, delta=0.5)

    def test_limits_saturate(self):
        self.assertEqual(estimate_battery_charge(30.0, 20.1, 26.8), 100.0)
        self.assertEqual(estimate_battery_charge(19.0, 20.1, 26.8), 0.0)

    def test_without_voltage_does_not_estimate(self):
        self.assertIsNone(estimate_battery_charge(None, 20.1, 26.8))
        self.assertIsNone(estimate_battery_charge(24.0, 26.8, 20.1))

    def test_per_device_custom_calibration(self):
        driver = MegatecQ1Driver(
            megatec_device(options={"battery_voltage_low_v": "22.0", "battery_voltage_high_v": "27.0"})
        )
        charge = driver.parse_status(MEGATEC_STATUS_OK)["battery_charge"]

        self.assertEqual(charge["calibration"], {"voltage_low_v": 22.0, "voltage_high_v": 27.0})
        self.assertAlmostEqual(charge["percent"], 36.0, delta=0.2)


if __name__ == "__main__":
    unittest.main()
