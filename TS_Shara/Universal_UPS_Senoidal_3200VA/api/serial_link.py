"""Serial communication layer (the only component that accesses the UPS port).

Responsibilities:
  - locate the device port by VID:PID;
  - open/close the port (with an exclusive lock, preventing two processes on the port);
  - send a read command and return the received frame;
  - classify failures into API contract codes.
"""
from __future__ import annotations

import glob
import os
import time

try:  # pyserial is the only external dependency of the application
    import serial
except ImportError:  # pragma: no cover - environment without pyserial
    serial = None

from .protocol import command_bytes

READ_CHUNK = 512


class LinkError(Exception):
    """Serial communication failure. `code` follows the API contract."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class PortUnavailableError(LinkError):
    def __init__(self, message: str):
        super().__init__("port_unavailable", message)


class PermissionDeniedError(LinkError):
    def __init__(self, message: str):
        super().__init__("permission_denied", message)


class DisconnectedError(LinkError):
    def __init__(self, message: str):
        super().__init__("disconnected", message)


class ResponseTimeoutError(LinkError):
    def __init__(self, message: str):
        super().__init__("timeout", message)


class SerialIOError(LinkError):
    def __init__(self, message: str):
        super().__init__("serial_error", message)


def detect_port(vendor_id: str, product_id: str) -> str | None:
    """Locates the device CDC-ACM port by VID:PID (e.g. 0483:5740)."""
    for device in sorted(glob.glob("/sys/bus/usb/devices/*")):
        def read(name):
            try:
                with open(os.path.join(device, name)) as handle:
                    return handle.read().strip()
            except OSError:
                return None

        if read("idVendor") != vendor_id or read("idProduct") != product_id:
            continue
        base = os.path.basename(device)
        for tty in sorted(glob.glob(f"/sys/bus/usb/devices/{base}/{base}:*/tty/*")):
            node = f"/dev/{os.path.basename(tty)}"
            if os.path.exists(node):
                return node
    return None


class SerialLink:
    """Serial access to the UPS, with automatic port reopening."""

    def __init__(self, config):
        self._config = config
        self._serial = None
        self._path: str | None = None

    @property
    def port(self) -> str | None:
        return self._path

    def close(self) -> None:
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:  # pragma: no cover - defensive shutdown
                pass
            self._serial = None

    def query(self, command: str) -> str:
        """Sends a read command and returns the received frame (without <CR>)."""
        self._ensure_open()
        try:
            self._serial.reset_input_buffer()
            self._serial.write(command_bytes(command))
            self._serial.flush()
            time.sleep(self._config.command_wait_s)
            raw = self._serial.read(READ_CHUNK)
        except (serial.SerialException, OSError) as exc:
            path = self._path or self._config.serial_port or "?"
            self.close()
            text = str(exc)
            lowered = text.lower()
            if "no such" in lowered or "disconnected" in lowered or "i/o error" in lowered:
                raise DisconnectedError(f"USB connection lost on {path}: {text}") from None
            raise SerialIOError(f"I/O failure on {path}: {text}") from None

        response = raw.decode("ascii", "replace").strip()
        if not response:
            raise ResponseTimeoutError(
                f"no response to command {command!r} within {self._config.command_wait_s}s "
                f"(port {self._path})"
            )
        return response

    # -- internals --------------------------------------------------------
    def _ensure_open(self) -> None:
        if serial is None:
            raise SerialIOError("pyserial not installed (sudo apt install python3-serial)")

        if self._serial is not None and self._serial.is_open:
            if self._path and not os.path.exists(self._path):
                self.close()
                raise DisconnectedError(f"port {self._path} disappeared (USB disconnection)")
            return

        port = self._config.serial_port or detect_port(
            self._config.usb_vendor_id, self._config.usb_product_id
        )
        if not port:
            raise PortUnavailableError(
                "UPS serial port not found "
                f"(VID:PID {self._config.usb_vendor_id}:{self._config.usb_product_id}); "
                "check the USB cable or set serial_port in the configuration"
            )
        # records the attempted port: it stays visible in the contract even when
        # opening fails (permission, port in use, disconnection).
        self._path = port
        if not os.path.exists(port):
            raise PortUnavailableError(f"serial port {port} unavailable")

        if not os.access(port, os.R_OK | os.W_OK):
            raise PermissionDeniedError(
                f"no read/write permission on {port} (add the user to the dialout group)"
            )

        try:
            self._serial = serial.Serial(
                port,
                self._config.serial_baud,
                timeout=self._config.serial_timeout_s,
                exclusive=self._config.serial_exclusive,
            )
        except (serial.SerialException, OSError, ValueError) as exc:
            self._serial = None
            text = str(exc)
            lowered = text.lower()
            if "permission" in lowered or "exclusiv" in lowered or "busy" in lowered:
                raise PortUnavailableError(
                    f"could not open {port} (in use by another process?): {text}"
                ) from None
            raise SerialIOError(f"failed to open {port}: {text}") from None
        self._path = port
