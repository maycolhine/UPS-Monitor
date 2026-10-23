"""Application configuration (defaults -> INI file -> environment variables -> CLI).

Precedence (the last one wins):
  1. default values defined in Config;
  2. INI file passed in --config ([sms_api] section);
  3. environment variables SMS_API_<FIELD_NAME>;
  4. command-line arguments.
"""
from __future__ import annotations

import configparser
import os
from dataclasses import asdict, dataclass, fields
from typing import Any

ENV_PREFIX = "SMS_API_"
SECTION = "sms_api"


class ConfigError(Exception):
    """Invalid configuration."""


@dataclass
class Config:
    # Logical identification of the equipment (the consumer does not depend on the port name)
    device_id: str = "sms-ups3200s-01"
    device_brand: str = "SMS"
    device_model: str = "Power Sinus NG uPS3200S"
    protocol: str = "sms-1phase"
    transport: str = "usb-serial"

    # Serial communication
    serial_port: str = ""          # empty = auto-detect by VID:PID
    serial_baud: int = 2400
    serial_timeout_s: float = 1.0
    serial_exclusive: bool = True  # prevents two applications on the same port
    command_wait_s: float = 0.5
    usb_vendor_id: str = "067b"
    usb_product_id: str = "23d3"

    # Collection
    poll_interval_s: float = 5.0
    stale_after_s: float = 20.0
    identity_refresh_s: float = 3600.0

    # Battery (the percentage COMES FROM the equipment; the nominal voltage is confirmed
    # by command F and used to derive the battery voltage — see Spec.md 7.3)
    battery_voltage_nominal_v: int = 24

    # HTTP API
    http_host: str = "127.0.0.1"
    http_port: int = 8082

    # Log
    log_level: str = "INFO"
    log_file: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def load_config(path: str | None = None, overrides: dict | None = None) -> Config:
    config = Config()
    if path:
        _apply(config, _from_ini(path), f"file {path}")
    _apply(config, _from_env(), "environment variables")
    _apply(config, overrides or {}, "command line")
    validate(config)
    return config


def validate(config: Config) -> None:
    if config.poll_interval_s <= 0:
        raise ConfigError("poll_interval_s must be greater than zero")
    if config.stale_after_s < config.poll_interval_s:
        raise ConfigError("stale_after_s cannot be less than poll_interval_s")
    if config.battery_voltage_nominal_v <= 0:
        raise ConfigError("battery_voltage_nominal_v must be greater than zero")
    if config.serial_baud <= 0:
        raise ConfigError("serial_baud must be greater than zero")
    if not 1 <= config.http_port <= 65535:
        raise ConfigError("http_port must be between 1 and 65535")
    if not config.device_id.strip():
        raise ConfigError("device_id cannot be empty")
    if config.log_level.upper() not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigError(f"invalid log_level: {config.log_level!r}")


def _apply(config: Config, values: dict, source: str) -> None:
    known = {field.name: field for field in fields(config)}
    for raw_key, raw_value in values.items():
        key = str(raw_key).strip().lower()
        if key not in known or raw_value is None or raw_value == "":
            continue
        try:
            setattr(config, key, _coerce(getattr(config, key), raw_value))
        except (TypeError, ValueError) as exc:
            raise ConfigError(f"invalid value for {key} ({source}): {raw_value!r}") from exc


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


def _from_ini(path: str) -> dict:
    if not os.path.exists(path):
        raise ConfigError(f"configuration file not found: {path}")
    parser = configparser.ConfigParser()
    try:
        parser.read(path)
    except configparser.Error as exc:
        raise ConfigError(f"invalid configuration file ({path}): {exc}") from exc
    if not parser.has_section(SECTION):
        return {}
    return {key: value for key, value in parser.items(SECTION)}


def _from_env() -> dict:
    values = {}
    for field in fields(Config):
        env_name = ENV_PREFIX + field.name.upper()
        if env_name in os.environ:
            values[field.name] = os.environ[env_name]
    return values
