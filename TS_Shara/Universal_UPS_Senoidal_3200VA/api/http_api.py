"""HTTP/REST layer (read-only).

No handler performs serial I/O: they all read the collector's in-memory state.
The response format is the JSON contract `/api/v1` (see docs/rest-api.md).
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
from .models import Snapshot, iso_utc

LOGGER = logging.getLogger("ts_shara.api")

HEALTH_PATH = "/health"
API_INDEX_PATH = "/api/v1"
DEVICES_PATH = "/api/v1/ups"
TELEMETRY_PATH_RE = re.compile(r"^/api/v1/ups/(?P<device_id>[^/]+)/telemetry$")
IDENTITY_PATH_RE = re.compile(r"^/api/v1/ups/(?P<device_id>[^/]+)/identity$")

ENDPOINTS = (
    {"method": "GET", "path": "/health", "description": "Application and collection availability"},
    {"method": "GET", "path": "/api/v1", "description": "Contract index (this document)"},
    {"method": "GET", "path": "/api/v1/ups", "description": "Configured devices"},
    {"method": "GET", "path": "/api/v1/ups/{device_id}/telemetry",
     "description": "Last valid telemetry and collection state"},
    {"method": "GET", "path": "/api/v1/ups/{device_id}/identity",
     "description": "Device identification and nominal information"},
)


@dataclass
class AppContext:
    """Dependencies shared by the handlers (config + collector)."""

    config: object
    collector: object
    started_at: datetime


# --------------------------- payload builders ---------------------------
def error_payload(code: str, message: str) -> dict:
    return {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "error": {"code": code, "message": message},
    }


def health_payload(context: AppContext, snapshot: Snapshot, now: datetime) -> tuple[int, dict]:
    state = snapshot.state
    if not snapshot.collector_alive:
        status = "down"
    elif state.telemetry_valid:
        status = "ok"
    else:
        status = "degraded"

    if snapshot.collector_alive:
        freshness = "ok" if state.telemetry_valid else ("stale" if state.stale else "no_data")
        communication = "ok" if state.state == "ok" else state.state
    else:
        freshness = "no_data"
        communication = "unknown"

    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "status": status,
        "checked_at_utc": iso_utc(now),
        "uptime_seconds": round(max(0.0, (now - context.started_at).total_seconds()), 3),
        "device_id": context.config.device_id,
        "checks": {
            "process": "ok",
            "collector_thread": "ok" if snapshot.collector_alive else "failed",
            "serial_communication": communication,
            "telemetry_freshness": freshness,
            "identity": "ok" if snapshot.identity is not None else "unavailable",
        },
        "collector": state.to_dict(),
    }
    return (200 if status == "ok" else 503), payload


def index_payload() -> tuple[int, dict]:
    return 200, {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "description": "Read API for the telemetry of the TS Shara UPS (Megatec/Q1)",
        "endpoints": [dict(endpoint) for endpoint in ENDPOINTS],
        "documentation": "docs/rest-api.md",
        "read_only": True,
    }


def devices_payload(context: AppContext, snapshot: Snapshot) -> tuple[int, dict]:
    config = context.config
    device_id = config.device_id
    device = {
        "device_id": device_id,
        "brand": config.device_brand,
        "model": config.device_model,
        "transport": config.transport,
        "protocol": config.protocol,
        "serial_port": snapshot.state.port or config.serial_port or None,
        "communication_state": snapshot.state.state,
        "telemetry_endpoint": f"/api/v1/ups/{device_id}/telemetry",
        "identity_endpoint": f"/api/v1/ups/{device_id}/identity",
    }
    return 200, {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "count": 1,
        "devices": [device],
    }


def telemetry_payload(context: AppContext, snapshot: Snapshot, device_id: str, now: datetime):
    if device_id != context.config.device_id:
        return 404, error_payload(
            "device_not_found",
            f"device {device_id!r} is not configured "
            f"(available: {context.config.device_id})",
        )

    state = snapshot.state
    telemetry = snapshot.telemetry
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": context.config.device_id,
        "telemetry_valid": state.telemetry_valid,
        "stale": state.stale,
        "data_available": telemetry is not None,
        "data": telemetry.to_dict(now=now) if telemetry is not None else None,
        "communication": state.to_dict(),
    }
    # 200 only when there is a valid and fresh reading; 503 when there is no
    # telemetry or when the last reading is out of date.
    return (200 if state.telemetry_valid else 503), payload


def identity_payload(context: AppContext, snapshot: Snapshot, device_id: str):
    config = context.config
    if device_id != config.device_id:
        return 404, error_payload(
            "device_not_found",
            f"device {device_id!r} is not configured (available: {config.device_id})",
        )

    identity = snapshot.identity
    payload = {
        "api_version": API_VERSION,
        "contract_version": CONTRACT_VERSION,
        "device_id": config.device_id,
        "identity_available": identity.available if identity is not None else False,
        "data": identity.to_dict() if identity is not None else None,
        "configured": {
            "device_id": config.device_id,
            "brand": config.device_brand,
            "model": config.device_model,
            "protocol": config.protocol,
            "transport": config.transport,
            "serial_port": snapshot.state.port or config.serial_port or None,
            "serial_baud": config.serial_baud,
            "poll_interval_s": config.poll_interval_s,
            "stale_after_s": config.stale_after_s,
        },
        "communication": snapshot.state.to_dict(),
    }
    return (200 if payload["identity_available"] else 503), payload


# ------------------------------- HTTP server --------------------------------
class ApiHandler(BaseHTTPRequestHandler):
    server_version = f"ts-shara-api/{CONTRACT_VERSION}"
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
        self._method_not_allowed()

    do_PUT = do_PATCH = do_DELETE = do_POST

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

        match = TELEMETRY_PATH_RE.match(path)
        if match:
            return partial(self._handle_telemetry, match.group("device_id"))

        match = IDENTITY_PATH_RE.match(path)
        if match:
            return partial(self._handle_identity, match.group("device_id"))

        return None

    @staticmethod
    def _normalize(path: str) -> str:
        if path != "/":
            path = path.rstrip("/")
        return path or "/"

    def _handle_health(self):
        status, payload = health_payload(self.context, self.context.collector.snapshot(), _utcnow())
        self._send_json(status, payload)

    def _handle_index(self):
        status, payload = index_payload()
        self._send_json(status, payload)

    def _handle_devices(self):
        status, payload = devices_payload(self.context, self.context.collector.snapshot())
        self._send_json(status, payload)

    def _handle_telemetry(self, device_id: str):
        status, payload = telemetry_payload(
            self.context, self.context.collector.snapshot(), device_id, _utcnow()
        )
        self._send_json(status, payload)

    def _handle_identity(self, device_id: str):
        status, payload = identity_payload(self.context, self.context.collector.snapshot(), device_id)
        self._send_json(status, payload)

    def _method_not_allowed(self):
        self._send_json(
            405,
            error_payload(
                "method_not_allowed",
                "the API is read-only: use GET (no command is sent to the UPS)",
            ),
        )

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
