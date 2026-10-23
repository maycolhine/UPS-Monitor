---
description: Context, goal and boundaries of the UPS Monitor project — Web Viewer
globs:
alwaysApply: true
---

# 00 — Project context

## What it is

A **read-only** web dashboard that displays the telemetry of UPS units published by the local REST API
of the **UPS Monitor** repository's telemetry service (`monitor/`, package `upsmon`) (`GET /health`,
`GET /api/v1`, `GET /api/v1/ups`, `GET /api/v1/ups/{device_id}/telemetry`,
`GET /api/v1/ups/{device_id}/identity`) and allows, **by explicit user action**, requesting the battery
test of contract 3.0 (`POST/GET /api/v1/ups/{device_id}/tests`): `duration_10s` (fixed window of ~10 s)
or `discharge_20pct` (discharge until the charge reaches 20 % or the 30 min ceiling, whichever comes
first — only where the API declares it). No test is triggered autonomously.

The official scope is documented in [README.md](../../README.md). Documentation: [README.md](../../README.md)
and [docs/](../../docs).

## Integration context

- The `monitor/` service (package `upsmon`) reads the UPS units over USB serial (protocols `megatec-q1`
  and `sms-1phase`) and publishes the telemetry over HTTP/JSON through a unified API. The web viewer
  (`src/backend` + `src/frontend`) lives in the same repository; it reads the API over HTTP and does
  **not** touch the USB/serial layer.
- UPS units of **two protocols** have already been validated: TS Shara Universal UPS Senoidal 3200VA
  (`device_id` `tsshara-3200va-01`, `/dev/ttyACM0`, `0483:5740`, `megatec-q1`) and SMS Power Sinus
  NG uPS3200S (`sms-ups3200s-01`, USB-Serial, `sms-1phase`). The project **must not limit itself** to
  these models: new brands/models must work without changing the frontend.
- Practical consequence: no fixed brand/model in code. The devices are discovered in
  `GET /api/v1/ups` (the unified API publishes N UPS units, on different protocols) and the interface
  allows choosing **one at a time** (`GET /api/dashboard?device_id=`); the fields are read through the
  contract.

## Responsibility boundaries (do not exceed)

The Web Viewer does **not**:

- read or control the USB port;
- implement the UPS protocols (Megatec/Q1, `sms-1phase`);
- run the serial collector or send commands/shutdown to the UPS unit — the battery test **request** is
  forwarded to the telemetry service (which commands the device), and only by user action;
- modify the telemetry service or its files;
- persist history in this version (the test history lives in memory in the telemetry service);
- configure Zabbix;
- expose the API directly to the internet.

## Language

The entire project — code, comments, error messages, interface and documentation — in **English**.
