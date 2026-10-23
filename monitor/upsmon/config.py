"""Configuration of the unified app (defaults -> INI -> environment variables -> CLI).

An INI file describes the service and one block per device:

    [upsmon]
    http_host = 127.0.0.1
    http_port = 8080

    [device:tsshara-3200va-01]
    protocol = megatec-q1
    usb_vendor_id = 0483
    usb_product_id = 5740
    battery_voltage_low_v = 20.1
    battery_voltage_high_v = 26.8

    [device:sms-ups3200s-01]
    protocol = sms-1phase
    usb_vendor_id = 067b
    usb_product_id = 23d3
    battery_voltage_nominal_v = 24

Unrecognized fields of a `[device:*]` block go to `options` and become available
to the driver (e.g. battery calibration). Environment variables use the
`UPSMON_` prefix (only for the service fields).
"""
from __future__ import annotations

import configparser
import os
from dataclasses import asdict, dataclass, field, fields
from typing import Any

ENV_PREFIX = "UPSMON_"
GENERAL_SECTION = "upsmon"
DEVICE_SECTION_PREFIX = "device:"

# type of each recognized field of a [device:*] block
_DEVICE_TYPES = {
    "device_id": str,
    "brand": str,
    "model": str,
    "protocol": str,
    "transport": str,
    "serial_port": str,
    "serial_baud": int,
    "serial_timeout_s": float,
    "serial_exclusive": bool,
    "command_wait_s": float,
    "usb_vendor_id": str,
    "usb_product_id": str,
    "poll_interval_s": float,
    "stale_after_s": float,
    "identity_refresh_s": float,
}
_APP_TYPES = {"http_host": str, "http_port": int, "log_level": str, "log_file": str}


class ConfigError(Exception):
    """Invalid configuration."""


@dataclass
class DeviceConfig:
    """Configuration of ONE device (serial port + protocol + driver)."""

    device_id: str
    protocol: str
    brand: str = ""
    model: str = ""
    transport: str = "usb-serial"
    serial_port: str = ""          # empty = auto-detect by VID:PID
    serial_baud: int = 2400
    serial_timeout_s: float = 1.0
    serial_exclusive: bool = True  # prevents two applications on the same port
    command_wait_s: float = 0.4
    usb_vendor_id: str = ""
    usb_product_id: str = ""
    poll_interval_s: float = 5.0
    stale_after_s: float = 20.0
    identity_refresh_s: float = 3600.0
    options: dict = field(default_factory=dict)

    def opt_float(self, key: str, default: float) -> float:
        value = self.options.get(key)
        if value is None or str(value).strip() == "":
            return default
        return float(value)

    def opt_int(self, key: str, default: int) -> int:
        value = self.options.get(key)
        if value is None or str(value).strip() == "":
            return default
        return int(float(value))

    def opt_bool(self, key: str, default: bool) -> bool:
        value = self.options.get(key)
        if value is None or str(value).strip() == "":
            return default
        return bool(_coerce(default, value))

    def to_dict(self) -> dict:
        data = asdict(self)
        data["options"] = dict(self.options)
        return data


@dataclass
class AppConfig:
    """Service configuration (one HTTP API for all devices)."""

    http_host: str = "127.0.0.1"
    http_port: int = 8080
    log_level: str = "INFO"
    log_file: str = ""
    devices: list = field(default_factory=list)

    def device(self, device_id: str):
        for item in self.devices:
            if item.device_id == device_id:
                return item
        return None


def load_config(path: str | None = None, overrides: dict | None = None) -> AppConfig:
    config = AppConfig()
    if path:
        _apply_app(config, _section(path, GENERAL_SECTION), f"file {path}")
        config.devices.extend(_devices(path))
    _apply_app(config, _from_env(), "environment variables")
    _apply_app(config, overrides or {}, "command line")
    if not config.devices:
        raise ConfigError("no device configured (missing [device:<id>] blocks)")
    validate(config)
    return config


def validate(config: AppConfig) -> None:
    if not 1 <= config.http_port <= 65535:
        raise ConfigError("http_port must be between 1 and 65535")
    if config.log_level.upper() not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigError(f"invalid log_level: {config.log_level!r}")
    seen = set()
    for device in config.devices:
        label = device.device_id or "<no id>"
        if not device.device_id.strip():
            raise ConfigError("device_id cannot be empty")
        if device.device_id in seen:
            raise ConfigError(f"duplicated device_id: {device.device_id!r}")
        seen.add(device.device_id)
        if not device.protocol.strip():
            raise ConfigError(f"protocol not defined for {label!r}")
        if device.poll_interval_s <= 0:
            raise ConfigError(f"invalid poll_interval_s for {label!r}")
        if device.stale_after_s < device.poll_interval_s:
            raise ConfigError(
                f"stale_after_s cannot be smaller than poll_interval_s ({label!r})"
            )
        if device.serial_baud <= 0:
            raise ConfigError(f"invalid serial_baud for {label!r}")


def _apply_app(config: AppConfig, values: dict, source: str) -> None:
    # `devices` never comes from INI/environment: it is built from the [device:*] blocks.
    known = {field.name for field in fields(config)} - {"devices"}
    for raw_key, raw_value in values.items():
        key = str(raw_key).strip().lower()
        if key not in known or raw_value is None or raw_value == "":
            continue
        try:
            setattr(config, key, _coerce(getattr(config, key), raw_value))
        except (TypeError, ValueError) as exc:
            raise ConfigError(f"invalid value for {key} ({source}): {raw_value!r}") from exc


def _devices(path: str) -> list:
    parser = _parser(path)
    devices = []
    for section in parser.sections():
        if not section.startswith(DEVICE_SECTION_PREFIX):
            continue
        suffix = section[len(DEVICE_SECTION_PREFIX):].strip()
        if not suffix:
            raise ConfigError(f"[device:] block without identifier ({path})")
        values = {key: value for key, value in parser.items(section)}
        devices.append(_build_device(suffix, values))
    return devices


def _build_device(device_id: str, values: dict) -> DeviceConfig:
    data: dict[str, Any] = {"device_id": device_id, "protocol": ""}
    options: dict[str, str] = {}
    for raw_key, raw_value in values.items():
        key = str(raw_key).strip().lower()
        if raw_value is None or str(raw_value).strip() == "":
            continue
        if key in _DEVICE_TYPES:
            data[key] = _coerce(_DEVICE_TYPES[key](), raw_value)
        else:
            options[key] = raw_value
    return DeviceConfig(options=options, **data)


def _coerce(current: Any, value: Any) -> Any:
    if isinstance(current, bool):
        text = str(value).strip().lower()
        if text in {"1", "true", "yes", "on", "sim"}:
            return True
        if text in {"0", "false", "no", "off", "nao"}:
            return False
        raise ValueError(f"invalid boolean: {value!r}")
    if isinstance(current, int):
        return int(float(value))
    if isinstance(current, float):
        return float(value)
    return str(value)


def _parser(path: str) -> configparser.ConfigParser:
    if not os.path.exists(path):
        raise ConfigError(f"configuration file not found: {path}")
    # configparser.read() silently ignores unreadable files, which would produce a
    # misleading "no device configured"; here the cause is made explicit.
    if not os.access(path, os.R_OK):
        raise ConfigError(f"no read permission on the configuration file: {path}")
    parser = configparser.ConfigParser()
    try:
        parser.read(path)
    except configparser.Error as exc:
        raise ConfigError(f"invalid configuration file ({path}): {exc}") from exc
    return parser


def _section(path: str, name: str) -> dict:
    parser = _parser(path)
    if not parser.has_section(name):
        return {}
    return {key: value for key, value in parser.items(name)}


def _from_env() -> dict:
    values = {}
    for name in _APP_TYPES:
        env_name = ENV_PREFIX + name.upper()
        if env_name in os.environ:
            values[name] = os.environ[env_name]
    return values
