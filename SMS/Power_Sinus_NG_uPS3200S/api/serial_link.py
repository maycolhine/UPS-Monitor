"""Serial communication layer (the only component that accesses the UPS port).

Responsibilities:
  - locate the equipment port by VID:PID;
  - open/close the port (with an exclusive lock, preventing two processes on the port);
  - send a read command and return the binary frame received;
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

from .protocol import RESULT_SIZE, command_bytes


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
    """Locates the equipment port by VID:PID (e.g.: 067b:23d3).

    Walks the tty ports of the system and climbs the sysfs tree of each one up
    to the USB device that declares `idVendor`/`idProduct`. This covers the two
    possible layouts: CDC-ACM (`<iface>/tty/ttyACM*`) and USB-Serial
    (`<iface>/ttyUSB*/tty/ttyUSB*`, pl2303 driver).
    """
    candidates = sorted(glob.glob("/sys/class/tty/ttyUSB*") + glob.glob("/sys/class/tty/ttyACM*"))
    for tty in candidates:
        if _usb_ids(tty) != (vendor_id, product_id):
            continue
        node = f"/dev/{os.path.basename(tty)}"
        if os.path.exists(node):
            return node
    return None


def _usb_ids(tty_path: str) -> tuple[str | None, str | None]:
    """Climbs the sysfs tree from the tty and returns (idVendor, idProduct)."""
    current = os.path.realpath(tty_path)
    while current and current != "/":
        vendor = _read_text(os.path.join(current, "idVendor"))
        product = _read_text(os.path.join(current, "idProduct"))
        if vendor and product:
            return vendor, product
        current = os.path.dirname(current)
    return None, None


def _read_text(path: str) -> str | None:
    try:
        with open(path) as handle:
            return handle.read().strip()
    except OSError:
        return None


class SerialLink:
    """Serial access to the UPS, with automatic reopening of the port."""

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

    def query(self, command: str) -> bytes:
        """Sends a read command and returns the binary frame (18 bytes)."""
        self._ensure_open()
        try:
            self._serial.reset_input_buffer()
            self._serial.write(command_bytes(command))
            self._serial.flush()
            time.sleep(self._config.command_wait_s)
            raw = self._serial.read(RESULT_SIZE)
        except (serial.SerialException, OSError) as exc:
            path = self._path or self._config.serial_port or "?"
            self.close()
            text = str(exc)
            lowered = text.lower()
            if "no such" in lowered or "disconnected" in lowered or "i/o error" in lowered:
                raise DisconnectedError(f"USB connection lost on {path}: {text}") from None
            raise SerialIOError(f"I/O failure on {path}: {text}") from None

        if not raw:
            raise ResponseTimeoutError(
                f"no response to command {command!r} within {self._config.command_wait_s}s "
                f"(port {self._path})"
            )
        return bytes(raw)

    # -- internos --------------------------------------------------------
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
                "serial port of the UPS not found "
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
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
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
