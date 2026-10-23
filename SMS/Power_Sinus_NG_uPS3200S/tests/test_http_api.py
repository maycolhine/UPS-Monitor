"""HTTP/REST layer tests: JSON contract, HTTP codes and read-only behavior.

The API is served on 127.0.0.1 on an ephemeral port and queried over real HTTP
(urllib), with no hardware: the snapshot comes from the collector with a fake serial link.
"""
from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone

from api.collector import Collector
from api.http_api import AppContext, make_server
from api.serial_link import ResponseTimeoutError
from tests.support import FakeClock, good_link, make_config, StubCollector

DEVICE_ID = "sms-ups3200s-01"


class ApiHarness(unittest.TestCase):
    """Starts the API on an ephemeral port and exposes request helpers."""

    def setUp(self):
        # the handler computes the age with the real clock; the fake clock starts
        # "now" so that captured_at and now stay consistent.
        self.clock = FakeClock(start=datetime.now(timezone.utc))
        self.config = make_config(http_host="127.0.0.1", http_port=0)
        self.link = good_link()
        self.collector = Collector(
            self.config, link=self.link, now=self.clock.utcnow, monotonic=self.clock.monotonic
        )

    def serve(self, alive: bool = True) -> None:
        """Freezes the collector's current snapshot and starts the HTTP server."""
        self.stub = StubCollector(self.collector.snapshot(), alive=alive)
        context = AppContext(config=self.config, collector=self.stub, started_at=self.clock.utcnow())
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

    def request(self, path: str, method: str = "GET") -> tuple[int, dict]:
        request = urllib.request.Request(self.base_url + path, method=method)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read().decode("utf-8"))

    def collect(self) -> None:
        self.assertIsNotNone(self.collector.collect_once())


class ContractIndexTest(ApiHarness):
    def test_index_documents_the_contract(self):
        self.serve()
        status, payload = self.request("/api/v1")

        self.assertEqual(status, 200)
        self.assertEqual(payload["api_version"], "v1")
        self.assertEqual(payload["contract_version"], "1.0")
        self.assertTrue(payload["read_only"])
        paths = {endpoint["path"] for endpoint in payload["endpoints"]}
        self.assertIn("/health", paths)
        self.assertIn("/api/v1/ups/{device_id}/telemetry", paths)

    def test_missing_resource_returns_404(self):
        self.serve()
        status, payload = self.request("/api/v1/inexistente")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "not_found")


class TelemetryEndpointTest(ApiHarness):
    def test_valid_telemetry_returns_200_with_units(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/telemetry")

        self.assertEqual(status, 200)
        self.assertTrue(payload["telemetry_valid"])
        self.assertFalse(payload["stale"])
        measurements = payload["data"]["measurements"]
        self.assertEqual(measurements["input_voltage_v"], 217.7)
        self.assertEqual(measurements["input_voltage_extended_v"], 0.0)
        self.assertEqual(measurements["output_voltage_v"], 217.7)
        self.assertEqual(measurements["load_percent"], 20.0)
        self.assertEqual(measurements["output_frequency_hz"], 59.9)
        self.assertEqual(measurements["temperature_c"], 49.1)
        self.assertEqual(payload["data"]["status"]["active"], ["BEEP", "UPSOK", "BYPASS"])
        self.assertEqual(payload["data"]["source"], "sms-1phase")
        self.assertLess(payload["data"]["age_seconds"], 5.0)  # fresh reading
        self.assertEqual(payload["communication"]["state"], "ok")

    def test_battery_percentage_comes_from_the_device(self):
        self.collect()
        self.serve()
        _, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/telemetry")

        battery = payload["data"]["battery"]
        self.assertEqual(battery["charge_percent"], 100.0)
        self.assertEqual(battery["charge_source"], "reported_by_device")
        # the voltage is not in the frame: it is derived from nominal x percentage.
        self.assertTrue(battery["voltage_derived"])
        self.assertEqual(battery["voltage_nominal_v"], 24)
        self.assertEqual(battery["voltage_v"], 24.0)
        self.assertEqual(battery["packs"], 2)

    def test_no_reading_returns_503_without_fake_values(self):
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/telemetry")

        self.assertEqual(status, 503)
        self.assertFalse(payload["telemetry_valid"])
        self.assertFalse(payload["data_available"])
        self.assertIsNone(payload["data"])
        self.assertEqual(payload["communication"]["state"], "starting")

    def test_stale_reading_returns_503_but_preserves_last_data(self):
        self.collect()
        self.clock.advance(30)  # above stale_after_s = 20
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/telemetry")

        self.assertEqual(status, 503)
        self.assertTrue(payload["stale"])
        self.assertFalse(payload["telemetry_valid"])
        self.assertTrue(payload["data_available"])
        self.assertEqual(payload["data"]["measurements"]["input_voltage_v"], 217.7)
        # the age is computed by the collector (single source); `data.age_seconds` comes
        # from the handler clock, so the comparison uses the `communication` block.
        self.assertGreaterEqual(payload["communication"]["age_seconds"], 30.0)
        self.assertIn("age_seconds", payload["data"])
        self.assertEqual(payload["communication"]["state"], "stale")

    def test_communication_failure_is_reported(self):
        self.collect()
        self.link.set_response("Q", ResponseTimeoutError("no response"))
        self.clock.advance(5)
        self.collector.collect_once()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/telemetry")

        self.assertEqual(status, 200)  # the last reading is still fresh
        self.assertEqual(payload["communication"]["state"], "timeout")
        self.assertEqual(payload["communication"]["last_error"]["code"], "timeout")
        self.assertEqual(payload["communication"]["consecutive_failures"], 1)
        self.assertEqual(payload["data"]["measurements"]["input_voltage_v"], 217.7)

    def test_unknown_device_returns_404(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups/other-id/telemetry")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "device_not_found")


class IdentityEndpointTest(ApiHarness):
    def test_identity_available(self):
        self.collect()
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/identity")

        self.assertEqual(status, 200)
        self.assertTrue(payload["identity_available"])
        self.assertEqual(payload["data"]["device"]["model"], "Power Sinus")
        self.assertEqual(payload["data"]["device"]["firmware"], "1.2")
        self.assertEqual(payload["data"]["nominal"]["voltage_v"], 220)
        self.assertEqual(payload["data"]["nominal"]["battery_voltage_v"], 24)
        self.assertEqual(payload["data"]["nominal"]["frequency_hz"], 60)
        self.assertEqual(payload["configured"]["protocol"], "sms-1phase")

    def test_identity_unavailable_returns_503(self):
        self.serve()
        status, payload = self.request(f"/api/v1/ups/{DEVICE_ID}/identity")

        self.assertEqual(status, 503)
        self.assertFalse(payload["identity_available"])
        self.assertIsNone(payload["data"])

    def test_unknown_device_returns_404(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups/other-id/identity")

        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "device_not_found")


class DevicesEndpointTest(ApiHarness):
    def test_list_configured_devices(self):
        self.collect()
        self.serve()
        status, payload = self.request("/api/v1/ups")

        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 1)
        device = payload["devices"][0]
        self.assertEqual(device["device_id"], DEVICE_ID)
        self.assertEqual(device["brand"], "SMS")
        self.assertEqual(device["protocol"], "sms-1phase")
        self.assertEqual(device["serial_port"], "/dev/fake0")
        self.assertEqual(device["communication_state"], "ok")
        self.assertEqual(device["telemetry_endpoint"], f"/api/v1/ups/{DEVICE_ID}/telemetry")


class HealthEndpointTest(ApiHarness):
    def test_health_ok_with_fresh_telemetry(self):
        self.collect()
        self.serve()
        status, payload = self.request("/health")

        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["device_id"], DEVICE_ID)
        self.assertEqual(payload["checks"]["collector_thread"], "ok")
        self.assertEqual(payload["checks"]["serial_communication"], "ok")
        self.assertEqual(payload["checks"]["telemetry_freshness"], "ok")
        self.assertEqual(payload["checks"]["identity"], "ok")

    def test_health_degraded_without_reading(self):
        self.serve()
        status, payload = self.request("/health")

        self.assertEqual(status, 503)
        self.assertEqual(payload["status"], "degraded")
        self.assertEqual(payload["checks"]["telemetry_freshness"], "no_data")
        self.assertEqual(payload["checks"]["serial_communication"], "starting")
        self.assertEqual(payload["checks"]["identity"], "unavailable")

    def test_health_down_when_collector_not_active(self):
        self.collect()
        self.serve(alive=False)
        status, payload = self.request("/health")

        self.assertEqual(status, 503)
        self.assertEqual(payload["status"], "down")
        self.assertEqual(payload["checks"]["collector_thread"], "failed")
        self.assertEqual(payload["checks"]["serial_communication"], "unknown")


class ReadOnlyApiTest(ApiHarness):
    def test_write_methods_return_405(self):
        self.serve()
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                status, payload = self.request("/api/v1/ups", method=method)
                self.assertEqual(status, 405)
                self.assertEqual(payload["error"]["code"], "method_not_allowed")

    def test_http_request_does_not_trigger_serial_reading(self):
        self.collect()
        commands = list(self.link.commands)
        self.serve()

        for path in (
            "/health",
            "/api/v1",
            "/api/v1/ups",
            f"/api/v1/ups/{DEVICE_ID}/telemetry",
            f"/api/v1/ups/{DEVICE_ID}/identity",
        ):
            self.request(path)

        self.assertEqual(self.link.commands, commands)  # no frame sent to the UPS
        self.assertGreaterEqual(self.stub.calls, 4)  # responses came from the in-memory state


if __name__ == "__main__":
    unittest.main()
