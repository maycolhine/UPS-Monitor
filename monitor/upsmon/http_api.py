"""Multi-device HTTP/REST layer.

No READ handler performs serial I/O: all of them read the in-memory state of the
collectors. A single HTTP port serves all devices, addressed by
`/api/v1/ups/{device_id}` (JSON contract v1, see docs/unified-api.md).

As of contract 3.0 there are WRITE endpoints for the battery test
(`POST .../tests`), enabled per device (`allow_battery_test`). Those handlers also
do not touch the serial port: they only validate the preconditions and enqueue the
request, which is run by the loop of the collector itself (the only owner of the
port). The rest of the API remains read-only.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import API_VERSION, CONTRACT_VERSION
from .collector import DEFAULT_TEST_TYPE, BatteryTestError
from .models import TEST_RUNNING, Snapshot, iso_utc

LOGGER = logging.getLogger("upsmon.api")

HEALTH_PATH = "/health"
API_INDEX_PATH = "/api/v1"
DEVICES_PATH = "/api/v1/ups"
TELEMETRY_PATH_RE = re.compile(r"^/api/v1/ups/(?P<device_id>[^/]+)/telemetry$")
IDENTITY_PATH_RE = re.compile(r"^/api/v1/ups/(?P<device_id>[^/]+)/identity$")
TESTS_PATH_RE = re.compile(r"^/api/v1/ups/(?P<device_id>[^/]+)/tests$")
TEST_PATH_RE = re.compile(r"^/api/v1/ups/(?P<device_id>[^/]+)/tests/(?P<test_id>[^/]+)$")
TEST_ABORT_PATH_RE = re.compile(
    r"^/api/v1/ups/(?P<device_id>[^/]+)/tests/(?P<test_id>[^/]+)/abort$"
)

DEFAULT_TEST_LIST_LIMIT = 10

ENDPOINTS = (
    {"method": "GET", "path": "/health",
     "description": "Availability of the application and of each device"},
    {"method": "GET", "path": "/api/v1",
     "description": "Contract index (this document)"},
    {"method": "GET", "path": "/api/v1/ups",
     "description": "All configured devices (multi-device)"},
    {"method": "GET", "path": "/api/v1/ups/{device_id}/telemetry",
     "description": "Last valid telemetry and collection state of a device"},
    {"method": "GET", "path": "/api/v1/ups/{device_id}/identity",
     "description": "Identification and nominal ratings of a device"},
    {"method": "POST", "path": "/api/v1/ups/{device_id}/tests",
     "description": "Requests the battery test (type: duration_10s | discharge_20pct; asynchronous; 202 Accepted)"},
    {"method": "GET", "path": "/api/v1/ups/{device_id}/tests",
     "description": "Latest battery tests of the device (in memory)"},
    {"method": "GET", "path": "/api/v1/ups/{device_id}/tests/{test_id}",
     "description": "Report of a test (partial while running, complete at the end)"},
    {"method": "POST", "path": "/api/v1/ups/{device_id}/tests/{test_id}/abort",
     "description": "Aborts an ongoing battery test"},
)


@dataclass
class AppContext:
    """Dependencies shared by the handlers (config + collectors)."""

    config: object
    collectors: dict          # device_id -> Collector
    started_at: datetime

    def collector(self, device_id: str):
        return self.collectors.get(device_id)


# --------------------------- payload builders ---------------------------
def error_payload(code: str, message: str) -> dict:
    return {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "error": {"code": code, "message": message},
    }


def _device_summary(snapshot: Snapshot) -> dict:
    state = snapshot.state
    alive = snapshot.collector_alive
    return {
        "telemetry_valid": state.telemetry_valid,
        "stale": state.stale,
        "state": state.state,
        "serial_port": state.port,
        "collector_thread": "ok" if alive else "failed",
        "telemetry_freshness": "ok" if state.telemetry_valid else ("stale" if state.stale else "no_data"),
        "communication": state.state if alive else "unknown",
        "identity": "ok" if snapshot.identity is not None else "unavailable",
        "last_success_utc": iso_utc(state.last_success_utc),
        "age_seconds": state.age_seconds,
    }


def health_payload(context: AppContext, now: datetime) -> tuple[int, dict]:
    snapshots = {device_id: collector.snapshot() for device_id, collector in context.collectors.items()}
    total = len(snapshots)
    alive_count = sum(1 for snap in snapshots.values() if snap.collector_alive)
    ok_count = sum(1 for snap in snapshots.values() if snap.state.telemetry_valid)

    if alive_count < total:
        status = "down"
    elif ok_count == total:
        status = "ok"
    else:
        status = "degraded"

    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "status": status,
        "checked_at_utc": iso_utc(now),
        "uptime_seconds": round(max(0.0, (now - context.started_at).total_seconds()), 3),
        "devices_total": total,
        "devices_ok": ok_count,
        "devices": {device_id: _device_summary(snap) for device_id, snap in snapshots.items()},
    }
    return (200 if status == "ok" else 503), payload


def index_payload(config) -> tuple[int, dict]:
    return 200, {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "description": "UPS telemetry API (multi-device, multi-protocol) with battery test",
        "endpoints": [dict(endpoint) for endpoint in ENDPOINTS],
        "devices": [device.device_id for device in config.devices],
        "documentation": "docs/unified-api.md",
        # telemetry remains read-only; the only write is the battery test, per
        # device (allow_battery_test).
        "read_only": False,
        "capabilities": {"battery_test": True},
    }


def devices_payload(context: AppContext) -> tuple[int, dict]:
    devices = []
    for device in context.config.devices:
        collector = context.collectors[device.device_id]
        snapshot = collector.snapshot()
        devices.append(
            {
                "device_id": device.device_id,
                "brand": device.brand,
                "model": device.model,
                "transport": device.transport,
                "protocol": device.protocol,
                "serial_port": snapshot.state.port or device.serial_port or None,
                "communication_state": snapshot.state.state,
                "telemetry_valid": snapshot.state.telemetry_valid,
                "telemetry_endpoint": f"/api/v1/ups/{device.device_id}/telemetry",
                "identity_endpoint": f"/api/v1/ups/{device.device_id}/identity",
                "capabilities": {"battery_test": collector.test_capabilities()},
            }
        )
    return 200, {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "count": len(devices),
        "devices": devices,
    }


def telemetry_payload(context: AppContext, device_id: str, now: datetime):
    collector = context.collector(device_id)
    if collector is None:
        return 404, error_payload(
            "device_not_found",
            f"device {device_id!r} is not configured "
            f"(available: {', '.join(sorted(context.collectors))})",
        )

    snapshot = collector.snapshot()
    state = snapshot.state
    telemetry = snapshot.telemetry
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": device_id,
        "telemetry_valid": state.telemetry_valid,
        "stale": state.stale,
        "data_available": telemetry is not None,
        "data": telemetry.to_dict(now=now) if telemetry is not None else None,
        "communication": state.to_dict(),
    }
    # 200 only when there is a valid and fresh reading; 503 when there is no
    # telemetry or when the last reading is out of date.
    return (200 if state.telemetry_valid else 503), payload


def identity_payload(context: AppContext, device_id: str):
    device = context.config.device(device_id)
    if device is None:
        return 404, error_payload(
            "device_not_found",
            f"device {device_id!r} is not configured "
            f"(available: {', '.join(sorted(context.collectors))})",
        )

    snapshot = context.collectors[device_id].snapshot()
    identity = snapshot.identity
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": device_id,
        "identity_available": identity.available if identity is not None else False,
        "data": identity.to_dict() if identity is not None else None,
        "configured": {
            "device_id": device.device_id,
            "brand": device.brand,
            "model": device.model,
            "protocol": device.protocol,
            "transport": device.transport,
            "serial_port": snapshot.state.port or device.serial_port or None,
            "serial_baud": device.serial_baud,
            "poll_interval_s": device.poll_interval_s,
            "stale_after_s": device.stale_after_s,
        },
        "communication": snapshot.state.to_dict(),
    }
    return (200 if payload["identity_available"] else 503), payload


# --------------------------- battery test (3.0) ---------------------------
def _unknown_device(context: AppContext, device_id: str) -> dict:
    return error_payload(
        "device_not_found",
        f"device {device_id!r} is not configured "
        f"(available: {', '.join(sorted(context.collectors))})",
    )


def test_create_payload(context: AppContext, device_id: str, test_type: str):
    """POST /tests: validates the preconditions and enqueues the test (asynchronous)."""
    collector = context.collector(device_id)
    if collector is None:
        return 404, _unknown_device(context, device_id)
    try:
        result = collector.request_test(test_type)
    except BatteryTestError as exc:
        return exc.http_status, error_payload(exc.code, exc.message)

    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "accepted_at_utc": iso_utc(_utcnow()),
        "poll_interval_s": 0.5,
        **result,
    }
    return 202, payload


def test_list_payload(context: AppContext, device_id: str, limit: int):
    collector = context.collector(device_id)
    if collector is None:
        return 404, _unknown_device(context, device_id)
    reports = collector.test_list(limit)
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": device_id,
        "count": len(reports),
        "tests": [report.summary_dict() for report in reports],
    }
    return 200, payload


def test_report_payload(context: AppContext, device_id: str, test_id: str):
    collector = context.collector(device_id)
    if collector is None:
        return 404, _unknown_device(context, device_id)
    report = collector.test_report(test_id)
    if report is None:
        return 404, error_payload(
            "test_not_found",
            f"test {test_id!r} not found for {device_id!r} "
            "(tests are kept in memory and are lost when the service restarts)",
        )
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": device_id,
        "test": report.to_dict(),
    }
    return 200, payload


def test_abort_payload(context: AppContext, device_id: str, test_id: str):
    collector = context.collector(device_id)
    if collector is None:
        return 404, _unknown_device(context, device_id)
    try:
        result = collector.abort_test(test_id)
    except BatteryTestError as exc:
        return exc.http_status, error_payload(exc.code, exc.message)
    if result is None:
        return 404, error_payload(
            "test_not_found", f"test {test_id!r} not found for {device_id!r}"
        )
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": device_id,
        **result,
    }
    return 202, payload


# ------------------------------- HTTP server --------------------------------
class ApiHandler(BaseHTTPRequestHandler):
    server_version = f"upsmon-api/{CONTRACT_VERSION}"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    @property
    def context(self) -> AppContext:
        return self.server.context

    def do_GET(self):  # noqa: N802 - name required by BaseHTTPRequestHandler
        path = self._normalize(self.path.split("?", 1)[0])
        handler = self._resolve(path)
        if handler is None:
            self._send_json(404, error_payload("not_found", f"resource not found: {path}"))
            return
        handler()

    def do_POST(self):  # noqa: N802
        path = self._normalize(self.path.split("?", 1)[0])
        handler = self._resolve_post(path)
        if handler is None:
            self._method_not_allowed()
            return
        handler()

    do_PUT = do_PATCH = do_DELETE = lambda self: self._method_not_allowed()  # noqa: E731

    def log_message(self, fmt, *args):  # noqa: A003 - stdlib signature
        LOGGER.debug("%s - %s", self.address_string(), fmt % args)

    def log_error(self, fmt, *args):  # noqa: A003
        LOGGER.warning("%s - %s", self.address_string(), fmt % args)

    # -- internals -------------------------------------------------------
    def _resolve(self, path):
        if path == HEALTH_PATH:
            return self._handle_health
        if path in (API_INDEX_PATH, "/api"):
            return self._handle_index
        if path == DEVICES_PATH:
            return self._handle_devices

        match = TESTS_PATH_RE.match(path)
        if match:
            return partial(self._handle_test_list, match.group("device_id"))

        match = TEST_ABORT_PATH_RE.match(path)
        if match:
            return partial(
                self._handle_test_abort, match.group("device_id"), match.group("test_id")
            )

        match = TEST_PATH_RE.match(path)
        if match:
            return partial(
                self._handle_test_report, match.group("device_id"), match.group("test_id")
            )

        match = TELEMETRY_PATH_RE.match(path)
        if match:
            return partial(self._handle_telemetry, match.group("device_id"))

        match = IDENTITY_PATH_RE.match(path)
        if match:
            return partial(self._handle_identity, match.group("device_id"))

        return None

    def _resolve_post(self, path):
        match = TESTS_PATH_RE.match(path)
        if match:
            return partial(self._handle_test_create, match.group("device_id"))

        match = TEST_ABORT_PATH_RE.match(path)
        if match:
            return partial(
                self._handle_test_abort, match.group("device_id"), match.group("test_id")
            )

        return None

    @staticmethod
    def _normalize(path: str) -> str:
        if path != "/":
            path = path.rstrip("/")
        return path or "/"

    def _handle_health(self):
        status, payload = health_payload(self.context, _utcnow())
        self._send_json(status, payload)

    def _handle_index(self):
        status, payload = index_payload(self.context.config)
        self._send_json(status, payload)

    def _handle_devices(self):
        status, payload = devices_payload(self.context)
        self._send_json(status, payload)

    def _handle_telemetry(self, device_id: str):
        status, payload = telemetry_payload(self.context, device_id, _utcnow())
        self._send_json(status, payload)

    def _handle_identity(self, device_id: str):
        status, payload = identity_payload(self.context, device_id)
        self._send_json(status, payload)

    def _handle_test_create(self, device_id: str):
        body = self._read_json_body()
        if body is None:
            return  # 400 already sent
        test_type = body.get("type") or DEFAULT_TEST_TYPE
        if not isinstance(test_type, str):
            self._send_json(
                400,
                error_payload("invalid_request", "'type' must be a string (e.g. \"duration_10s\")"),
            )
            return
        status, payload = test_create_payload(self.context, device_id, test_type)
        self._send_json(status, payload)

    def _handle_test_list(self, device_id: str):
        limit = self._query_int("limit", DEFAULT_TEST_LIST_LIMIT)
        status, payload = test_list_payload(self.context, device_id, limit)
        self._send_json(status, payload)

    def _handle_test_report(self, device_id: str, test_id: str):
        status, payload = test_report_payload(self.context, device_id, test_id)
        self._send_json(status, payload)

    def _handle_test_abort(self, device_id: str, test_id: str):
        status, payload = test_abort_payload(self.context, device_id, test_id)
        self._send_json(status, payload)

    def _method_not_allowed(self):
        self._send_json(
            405,
            error_payload(
                "method_not_allowed",
                "method not allowed on this resource: telemetry is read-only and "
                "only /api/v1/ups/{device_id}/tests accepts POST",
            ),
        )

    def _read_json_body(self):
        """Reads and validates the JSON body of a POST. Sends 400 and returns None if invalid."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(
                400, error_payload("invalid_request", "the request body is not valid JSON")
            )
            return None
        if body is None:
            return {}
        if not isinstance(body, dict):
            self._send_json(
                400, error_payload("invalid_request", "the JSON body must be an object")
            )
            return None
        return body

    def _query_int(self, name: str, default: int) -> int:
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        for pair in query.split("&"):
            key, _, value = pair.partition("=")
            if key == name:
                try:
                    return max(1, int(value))
                except ValueError:
                    return default
        return default

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class ApiServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, context: AppContext):
        super().__init__(address, ApiHandler)
        self.context = context


def make_server(context: AppContext) -> ApiServer:
    """Creates the HTTP server on the configured interface/port."""
    return ApiServer((context.config.http_host, context.config.http_port), context)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)
