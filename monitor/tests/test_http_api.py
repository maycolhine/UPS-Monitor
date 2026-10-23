"""Tests for the unified HTTP/REST layer: JSON contract, HTTP codes and read-only.

The API is served on 127.0.0.1 on an ephemeral port and queried over real HTTP
(urllib), without hardware: the snapshots come from collectors with fake serial
links (one TS Shara Megatec/Q1 and one SMS 1Phase on the SAME instance/port).
"""
from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone

from upsmon.collector import Collector
from upsmon.http_api import AppContext, make_server
from tests.support import (
    FakeClock,
    FakeSleeper,
    StubCollector,
    make_app_config,
    megatec_device,
    megatec_link,
    sms_device,
    sms_link,
    sms_status,
)

SMS_ID = "sms-ups3200s-01"
MEGATEC_ID = "tsshara-3200va-01"


class ApiHarness(unittest.TestCase):
    """Starts the API (two devices) on an ephemeral port and exposes helpers."""

    def setUp(self):
        # the handler computes the age with the real clock; the fake clock starts
        # "now" so that captured_at and now stay coherent.
        self.clock = FakeClock(start=datetime.now(timezone.utc))
        self.sleeper = FakeSleeper(self.clock)
        self.devices = self.build_devices()
        self.config = make_app_config(self.devices)
        links = {SMS_ID: sms_link(), MEGATEC_ID: megatec_link()}
        self.collectors = {
            device.device_id: Collector(
                device,
                link=links[device.device_id],
                now=self.clock.utcnow,
                monotonic=self.clock.monotonic,
                sleep=self.sleeper,
            )
            for device in self.devices
        }

    def build_devices(self) -> list:
        """Devices served by the API (overridden in the battery tests)."""
        return [sms_device(), megatec_device()]

    def collect(self, *device_ids) -> None:
        for device_id in device_ids or tuple(self.collectors):
            self.assertIsNotNone(self.collectors[device_id].collect_once(), device_id)

    def serve(self, alive: bool = True) -> None:
        """Freezes the current snapshots and starts the HTTP server."""
        stubs = {
            device_id: StubCollector(collector.snapshot(), alive=alive, collector=collector)
            for device_id, collector in self.collectors.items()
        }
        self.stubs = stubs
        context = AppContext(config=self.config, collectors=stubs, started_at=self.clock.utcnow())
        self.server = make_server(context)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True
        )
        self.thread.start()
        self.addCleanup(self._shutdown)

    def _shutdown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path: str, method: str = "GET", body: dict | None = None) -> tuple[int, dict]:
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))


class ContractIndexTest(ApiHarness):
    def test_index_documents_contract_and_devices(self):
        self.serve()
        status, payload = self.request("/api/v1")

        self.assertEqual(status, 200)
        self.assertEqual(payload["api_version"], "v1")
        self.assertEqual(payload["contract_version"], "3.0")
        self.assertFalse(payload["read_only"])
        self.assertEqual(payload["capabilities"], {"battery_test": True})
        self.assertEqual(sorted(payload["devices"]), sorted([MEGATEC_ID, SMS_ID]))
        self.assertEqual(payload["documentation"], "docs/unified-api.md")
        paths = {endpoint["path"] for endpoint in payload["endpoints"]}
        self.assertIn("/api/v1/ups", paths)
        self.assertIn("/api/v1/ups/{device_id}/telemetry", paths)
        self.assertIn("/api/v1/ups/{device_id}/tests", paths)
        self.assertIn("/api/v1/ups/{device_id}/tests/{test_id}", paths)
        self.assertIn("/api/v1/ups/{device_id}/tests/{test_id}/abort", paths)

    def test_unknown_resource_returns_404(self):
        self.serve()
        status, payload = self.request("/api/v1/unknown")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not_found")


class DevicesEndpointTest(ApiHarness):
    def test_lists_both_devices_with_protocol_and_endpoints(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups")

        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 2)
        by_id = {device["device_id"]: device for device in payload["devices"]}
        self.assertEqual(by_id[SMS_ID]["protocol"], "sms-1phase")
        self.assertEqual(by_id[SMS_ID]["brand"], "SMS")
        self.assertEqual(by_id[MEGATEC_ID]["protocol"], "megatec-q1")
        self.assertEqual(by_id[MEGATEC_ID]["brand"], "TS Shara")
        self.assertEqual(by_id[SMS_ID]["serial_port"], "/dev/fake0")
        self.assertEqual(by_id[SMS_ID]["communication_state"], "ok")
        self.assertEqual(by_id[MEGATEC_ID]["telemetry_endpoint"], f"/api/v1/ups/{MEGATEC_ID}/telemetry")


class TelemetryEndpointTest(ApiHarness):
    def test_sms_publishes_1phase_protocol_envelope(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/telemetry")

        self.assertEqual(status, 200)
        self.assertTrue(payload["telemetry_valid"])
        self.assertEqual(payload["device_id"], SMS_ID)
        data = payload["data"]
        self.assertEqual(data["source"], "sms-1phase")
        self.assertEqual(data["measurements"]["input_voltage_v"], 217.7)
        self.assertEqual(data["measurements"]["output_frequency_hz"], 59.9)
        self.assertEqual(data["battery"]["charge_percent"], 100.0)
        self.assertNotIn("battery_charge", data)  # extension exclusive to Megatec
        self.assertEqual(data["status"]["active"], ["BEEP", "UPSOK", "BYPASS"])
        self.assertEqual(payload["communication"]["state"], "ok")

    def test_megatec_publishes_q1_protocol_envelope(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{MEGATEC_ID}/telemetry")

        self.assertEqual(status, 200)
        data = payload["data"]
        self.assertEqual(data["source"], "megatec-q1")
        self.assertEqual(data["measurements"]["input_voltage_v"], 228.0)
        self.assertEqual(data["measurements"]["input_frequency_hz"], 60.0)
        self.assertNotIn("output_frequency_hz", data["measurements"])
        self.assertAlmostEqual(data["battery_charge"]["percent"], 55.2, delta=0.2)
        self.assertTrue(data["battery_charge"]["estimated"])
        self.assertNotIn("battery", data)  # extension exclusive to SMS
        self.assertEqual(data["status"]["active"], ["OB", "STANDBY", "BEEP"])

    def test_no_reading_returns_503_without_fake_values(self):
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/telemetry")

        self.assertEqual(status, 503)
        self.assertFalse(payload["telemetry_valid"])
        self.assertFalse(payload["data_available"])
        self.assertIsNone(payload["data"])
        self.assertEqual(payload["communication"]["state"], "starting")

    def test_stale_reading_returns_503_but_preserves_last_data(self):
        self.collect(SMS_ID)
        self.clock.advance(30)  # above stale_after_s = 20
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/telemetry")

        self.assertEqual(status, 503)
        self.assertTrue(payload["stale"])
        self.assertFalse(payload["telemetry_valid"])
        self.assertTrue(payload["data_available"])
        self.assertEqual(payload["data"]["measurements"]["input_voltage_v"], 217.7)
        self.assertEqual(payload["communication"]["state"], "stale")

    def test_unknown_device_returns_404(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups/unknown-id/telemetry")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "device_not_found")


class IdentityEndpointTest(ApiHarness):
    def test_identity_of_each_protocol(self):
        self.collect()
        self.serve()

        status, sms = self.request(f"/api/v1/ups/{SMS_ID}/identity")
        self.assertEqual(status, 200)
        self.assertEqual(sms["data"]["device"]["model"], "Power Sinus")
        self.assertEqual(sms["data"]["device"]["firmware"], "1.2")
        self.assertEqual(sms["data"]["nominal"]["voltage_v"], 220)
        self.assertEqual(sms["data"]["nominal"]["battery_voltage_v"], 24)
        self.assertEqual(sms["configured"]["protocol"], "sms-1phase")

        status, megatec = self.request(f"/api/v1/ups/{MEGATEC_ID}/identity")
        self.assertEqual(status, 200)
        self.assertEqual(megatec["data"]["device"]["manufacturer"], "TS SHARA")
        self.assertEqual(megatec["data"]["device"]["model"], "SENO3.2kVA")
        self.assertEqual(megatec["data"]["nominal"]["frequency_hz"], 60.0)
        self.assertEqual(megatec["configured"]["protocol"], "megatec-q1")

    def test_identity_unavailable_returns_503(self):
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/identity")

        self.assertEqual(status, 503)
        self.assertFalse(payload["identity_available"])
        self.assertIsNone(payload["data"])

    def test_unknown_device_returns_404(self):
        self.serve()
        status, payload = self.request("/api/v1/ups/unknown-id/identity")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "device_not_found")


class HealthEndpointTest(ApiHarness):
    def test_health_ok_with_both_devices_fresh(self):
        self.collect()
        self.serve()
        status, payload = self.request("/health")

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["devices_total"], 2)
        self.assertEqual(payload["devices_ok"], 2)
        self.assertEqual(set(payload["devices"]), {SMS_ID, MEGATEC_ID})
        self.assertEqual(payload["devices"][SMS_ID]["telemetry_freshness"], "ok")
        self.assertEqual(payload["devices"][MEGATEC_ID]["communication"], "ok")

    def test_health_degraded_when_one_device_has_no_reading(self):
        self.collect(SMS_ID)
        self.serve()
        status, payload = self.request("/health")

        self.assertEqual(status, 503)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["devices_ok"], 1)
        self.assertEqual(payload["devices"][MEGATEC_ID]["telemetry_freshness"], "no_data")

    def test_health_down_when_one_collector_is_not_alive(self):
        self.collect()
        self.serve(alive=False)
        status, payload = self.request("/health")

        self.assertEqual(status, 503)
        self.assertEqual(payload["status"], "down")
        self.assertEqual(payload["devices"][SMS_ID]["collector_thread"], "failed")
        self.assertEqual(payload["devices"][SMS_ID]["communication"], "unknown")


class BatteryTestEndpointTest(ApiHarness):
    """Write endpoints (contract 3.0): request, tracking and cancel."""

    def build_devices(self) -> list:
        # SMS with the test enabled; TS Shara stays disabled (403).
        return [
            sms_device(allow_battery_test="true", test_sample_interval_s="0.5"),
            megatec_device(),
        ]

    def _varying_sms_status(self):
        state = {"n": 0}

        def status(_command):
            index = state["n"]
            state["n"] += 1
            return sms_status(
                charge_percent=max(0.0, 100.0 - index * 1.0),
                load_percent=20.0 + index,
                status_byte=0x2D,  # BEEP + TEST + UPSOK + BYPASS
            )

        return status

    def _fast_discharge_sms_status(self):
        state = {"n": 0}

        def status(_command):
            index = state["n"]
            state["n"] += 1
            return sms_status(
                charge_percent=max(0.0, 100.0 - index * 5.0),
                load_percent=20.0 + index,
                status_byte=0x2D,  # BEEP + TEST + UPSOK + BYPASS
            )

        return status

    def test_capabilities_appear_in_api_v1_ups(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups")

        self.assertEqual(status, 200)
        by_id = {device["device_id"]: device for device in payload["devices"]}
        self.assertTrue(by_id[SMS_ID]["capabilities"]["battery_test"]["enabled"])
        self.assertFalse(by_id[MEGATEC_ID]["capabilities"]["battery_test"]["enabled"])
        # the target test only exists where the protocol knows how to cancel (SMS)
        self.assertEqual(
            by_id[SMS_ID]["capabilities"]["battery_test"]["test_types"],
            ["duration_10s", "discharge_20pct"],
        )
        self.assertEqual(
            by_id[MEGATEC_ID]["capabilities"]["battery_test"]["test_types"], ["duration_10s"]
        )
        self.assertEqual(
            by_id[SMS_ID]["capabilities"]["battery_test"]["types"]["discharge_20pct"],
            {
                "duration_s": None,
                "target_percent": 20.0,
                "timeout_s": 1800.0,
                "sample_interval_s": 2.0,
            },
        )

    def test_target_20pct_test_delivers_timeline(self):
        self.collect()
        self.serve()

        status, accepted = self.request(
            f"/api/v1/ups/{SMS_ID}/tests", "POST", {"type": "discharge_20pct"}
        )

        self.assertEqual(status, 202)
        self.assertEqual(accepted["type"], "discharge_20pct")
        self.assertIsNone(accepted["requested_duration_s"])  # no fixed window
        self.assertEqual(accepted["target_percent"], 20.0)
        self.assertEqual(accepted["timeout_s"], 1800.0)

        link = self.collectors[SMS_ID]._link
        link.set_response("Q", self._fast_discharge_sms_status())
        self.collectors[SMS_ID].collect_once()
        # T with no duration (the firmware runs until the target) + D when 20 % is reached
        self.assertEqual(link.actions, ["T", "D"])

        status, done = self.request(f"/api/v1/ups/{SMS_ID}/tests/{accepted['test_id']}")

        self.assertEqual(status, 200)
        report = done["test"]
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["finish_reason"], "target_percent_reached")
        self.assertEqual(report["target_percent"], 20.0)
        self.assertEqual(report["final"]["battery_charge_percent"], 20.0)
        # each sample carries the normalized columns used in the charts
        sample = report["samples"][0]
        self.assertEqual(sample["normalized"]["battery_charge_percent"], 100.0)
        self.assertEqual(sample["normalized"]["frequency_hz"], 59.9)
        self.assertEqual(sample["normalized"]["temperature_c"], 49.1)
        self.assertIn("offset_s", sample)

    def test_asynchronous_request_and_full_report(self):
        self.collect()
        self.serve()
        link = self.collectors[SMS_ID]._link
        commands_before, actions_before = list(link.commands), list(link.actions)

        status, accepted = self.request(f"/api/v1/ups/{SMS_ID}/tests", "POST", {"type": "duration_10s"})

        self.assertEqual(status, 202)
        self.assertEqual(accepted["status"], "running")
        self.assertEqual(accepted["type"], "duration_10s")
        self.assertEqual(accepted["poll_interval_s"], 0.5)
        test_id = accepted["test_id"]
        self.assertEqual(accepted["report_url"], f"/api/v1/ups/{SMS_ID}/tests/{test_id}")
        # the HTTP request does not touch the serial (neither reading nor action command)
        self.assertEqual(link.commands, commands_before)
        self.assertEqual(link.actions, actions_before)

        # partial report while "running" (not yet executed by the collector)
        status, partial = self.request(f"/api/v1/ups/{SMS_ID}/tests/{test_id}")
        self.assertEqual(status, 200)
        self.assertEqual(partial["test"]["status"], "running")
        self.assertEqual(partial["test"]["samples_count"], 0)

        # the collector loop runs the window
        link.set_response("Q", self._varying_sms_status())
        self.collectors[SMS_ID].collect_once()
        self.assertEqual(link.actions, ["T", "D"])  # T with duration + D on finish

        status, done = self.request(f"/api/v1/ups/{SMS_ID}/tests/{test_id}")
        self.assertEqual(status, 200)
        report = done["test"]
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["finish_reason"], "duration_elapsed")
        self.assertTrue(report["test_flag_observed"])
        self.assertGreater(len(report["samples"]), 10)
        self.assertEqual(report["baseline"]["battery_charge_percent"], 100.0)
        self.assertEqual(report["deltas"]["metrics"]["battery_charge_percent"]["delta"], -20.0)
        self.assertTrue(report["estimate"]["available"])
        self.assertEqual(report["estimate"]["confidence"], "low")

    def test_device_test_list(self):
        self.collect()
        self.serve()
        self.request(f"/api/v1/ups/{SMS_ID}/tests", "POST", {})

        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/tests?limit=5")

        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["tests"][0]["type"], "duration_10s")

    def test_unknown_test_type_returns_422(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/tests", "POST", {"type": "duration_60s"})

        self.assertEqual(status, 422)
        self.assertEqual(payload["error"]["code"], "unsupported_test_type")

    def test_device_with_test_disabled_returns_403(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{MEGATEC_ID}/tests", "POST", {})

        self.assertEqual(status, 403)
        self.assertEqual(payload["error"]["code"], "test_disabled")

    def test_nonexistent_device_returns_404(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups/unknown-id/tests", "POST", {})

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "device_not_found")

    def test_invalid_json_body_returns_400(self):
        self.collect()
        self.serve()
        request = urllib.request.Request(
            self.base_url + f"/api/v1/ups/{SMS_ID}/tests",
            data=b"{not-json}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status, payload = response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            status, payload = exc.code, json.loads(exc.read())

        self.assertEqual(status, 400)
        self.assertEqual(payload["error"]["code"], "invalid_request")

    def test_nonexistent_test_report_returns_404(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/tests/nonexistent")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "test_not_found")

    def test_abort_already_completed_test_returns_409(self):
        self.collect()
        self.serve()
        _, accepted = self.request(f"/api/v1/ups/{SMS_ID}/tests", "POST", {})
        test_id = accepted["test_id"]
        self.collectors[SMS_ID].collect_once()

        status, payload = self.request(f"/api/v1/ups/{SMS_ID}/tests/{test_id}/abort", "POST", {})

        self.assertEqual(status, 409)
        self.assertEqual(payload["error"]["code"], "test_not_running")


class ReadOnlyApiTest(ApiHarness):
    def test_write_methods_return_405(self):
        self.serve()
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                status, payload = self.request("/api/v1/ups", method=method)
                self.assertEqual(status, 405)
                self.assertEqual(payload["error"]["code"], "method_not_allowed")

    def test_http_request_does_not_trigger_serial_read(self):
        self.collect()
        self.serve()

        for device_id in (SMS_ID, MEGATEC_ID):
            for path in (
                "/health",
                "/api/v1",
                "/api/v1/ups",
                f"/api/v1/ups/{device_id}/telemetry",
                f"/api/v1/ups/{device_id}/identity",
            ):
                self.request(path)

        for device_id, stub in self.stubs.items():
            self.assertGreaterEqual(stub.calls, 4, device_id)  # response came from in-memory state


if __name__ == "__main__":
    unittest.main()
