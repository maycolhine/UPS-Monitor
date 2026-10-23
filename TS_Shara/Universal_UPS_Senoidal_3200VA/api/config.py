"""Application configuration (defaults -> INI file -> environment variables -> CLI).

Precedence (the last one wins):
  1. default values defined in Config;
  2. INI file passed via --config ([ts_shara_api] section);
  3. environment variables TS_SHARA_API_<FIELD_NAME>;
  4. command-line arguments.
"""
from __future__ import annotations

import configparser
import os
from dataclasses import asdict, dataclass, fields
from typing import Any

ENV_PREFIX = "TS_SHARA_API_"
SECTION = "ts_shara_api"


class ConfigError(Exception):
    """Invalid configuration."""


@dataclass
class Config:
    # Logical identification of the device (consumers do not depend on the port name)
    device_id: str = "tsshara-3200va-01"
    device_brand: str = "TS Shara"
    device_model: str = "Universal UPS Senoidal 3200VA"
    protocol: str = "megatec-q1"
    transport: str = "usb-serial-cdc-acm"

    # Serial communication
    serial_port: str = ""          # empty = autodetect by VID:PID
    serial_baud: int = 2400
    serial_timeout_s: float = 1.0
    serial_exclusive: bool = True  # prevents two applications from using the same port
    command_wait_s: float = 0.4
    usb_vendor_id: str = "0483"
    usb_product_id: str = "5740"

    # Collection
    poll_interval_s: float = 5.0
    stale_after_s: float = 20.0
    identity_refresh_s: float = 3600.0

    # Battery charge estimate (Spec.md 7.3.4)
    battery_voltage_low_v: float = 20.1
    battery_voltage_high_v: float = 26.8

    # HTTP API
    http_host: str = "127.0.0.1"
    http_port: int = 8081

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
    if config.battery_voltage_high_v <= config.battery_voltage_low_v:
        raise ConfigError("battery_voltage_high_v must be greater than battery_voltage_low_v")
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
