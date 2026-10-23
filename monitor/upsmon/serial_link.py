"""Serial communication layer (the only component that accesses the UPS port).

Responsibilities:
  - locate the device port by VID:PID;
  - open/close the port (with an exclusive lock, preventing two processes on the same port);
  - send a READ command and return the raw response bytes;
  - send an ACTION command (battery test) without waiting for a response;
  - classify failures into API contract codes.

The protocol driver decides how to build the command and how many bytes to read.
"""
from __future__ import annotations

import glob
import os
import time

try:  # pyserial is the only external dependency of the application
    import serial
except ImportError:  # pragma: no cover - environment without pyserial
    serial = None

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
    """Locates the device port by VID:PID (e.g. 067b:23d3).

    Walks the system tty ports (`ttyUSB*` and `ttyACM*`) and goes up the sysfs
    tree of each one up to the USB device that declares `idVendor`/`idProduct`.
    This covers both possible layouts: CDC-ACM (`<iface>/tty/ttyACM*`) and
    USB-Serial (`<iface>/ttyUSB*/tty/ttyUSB*`, pl2303 driver).
    """
    if not vendor_id or not product_id:
        return None
    candidates = sorted(glob.glob("/sys/class/tty/ttyUSB*") + glob.glob("/sys/class/tty/ttyACM*"))
    for tty in candidates:
        if _usb_ids(tty) != (vendor_id, product_id):
            continue
        node = f"/dev/{os.path.basename(tty)}"
        if os.path.exists(node):
            return node
    return None


def _usb_ids(tty_path: str) -> tuple[str | None, str | None]:
    """Goes up the sysfs tree from the tty and returns (idVendor, idProduct)."""
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
    """Serial access to ONE UPS, with automatic reopening of the port."""

    def __init__(self, device, driver):
        self._device = device
        self._driver = driver
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
        """Sends a read command and returns the raw response bytes."""
        self._ensure_open()
        try:
            self._serial.reset_input_buffer()
            self._serial.write(self._driver.command_bytes(command))
            self._serial.flush()
            time.sleep(self._device.command_wait_s)
            # some protocols define the exact frame size (SMS = 18 bytes)
            size = self._driver.read_size or READ_CHUNK
            raw = self._serial.read(size)
        except (serial.SerialException, OSError) as exc:
            self._raise_io_error(exc)

        if not raw:
            raise ResponseTimeoutError(
                f"no response to command {command!r} within {self._device.command_wait_s}s "
                f"(port {self._path})"
            )
        return bytes(raw)

    def send_action(self, command: str, duration_s: float | None = None) -> None:
        """Sends an ACTION command (fire-and-forget) and does NOT wait for a response.

        Used only by the action commands declared by the driver (battery test and
        its abort). `duration_s` is the requested duration of the test, forwarded
        to the driver: protocols that require the duration as a parameter
        (SMS Brazil 1Phase, `Param1`) use it to build the frame. Those commands go
        to the UPS with no immediate return (see the protocol docs), which is why
        the input buffer is cleared before sending: the next reading then does not
        inherit leftovers from previous frames. There is no read or wait here.
        """
        payload = self._driver.action_bytes(command, duration_s)
        self._ensure_open()
        try:
            self._serial.reset_input_buffer()
            self._serial.write(payload)
            self._serial.flush()
        except (serial.SerialException, OSError) as exc:
            self._raise_io_error(exc)

    # -- internals -------------------------------------------------------
    def _raise_io_error(self, exc: Exception) -> None:
        """Closes the port and translates an OSError/SerialException into the contract code."""
        path = self._path or self._device.serial_port or "?"
        self.close()
        text = str(exc)
        lowered = text.lower()
        if "no such" in lowered or "disconnected" in lowered or "i/o error" in lowered:
            raise DisconnectedError(f"USB connection lost on {path}: {text}") from None
        raise SerialIOError(f"I/O failure on {path}: {text}") from None

    def _ensure_open(self) -> None:
        if serial is None:
            raise SerialIOError("pyserial not installed (sudo apt install python3-serial)")

        if self._serial is not None and self._serial.is_open:
            if self._path and not os.path.exists(self._path):
                self.close()
                raise DisconnectedError(f"port {self._path} disappeared (USB disconnection)")
            return

        port = self._device.serial_port or detect_port(
            self._device.usb_vendor_id, self._device.usb_product_id
        )
        if not port:
            raise PortUnavailableError(
                "serial port of the UPS not found "
                f"(VID:PID {self._device.usb_vendor_id or '?'}:{self._device.usb_product_id or '?'}); "
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
                self._device.serial_baud,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=self._device.serial_timeout_s,
                exclusive=self._device.serial_exclusive,
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
