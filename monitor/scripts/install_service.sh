#!/usr/bin/env bash
# Installs the UNIFIED UPS REST API (upsmon) as a systemd service, with a udev rule.
#
# Usage (requires sudo):
#   sudo scripts/install_service.sh
#
# What it does:
#   1. installs /etc/systemd/system/upsmon-api.service, adjusting the user and the
#      project folder for this host (the path contains spaces);
#   2. installs /etc/upsmon/upsmon.conf (preserves any existing configuration);
#   3. installs /etc/udev/rules.d/99-upsmon.rules (dialout permission, ModemManager
#      must ignore the devices and restart on cable reconnection);
#   4. warns if the legacy per-device services are still active (the migration
#      to the unified API replaces them);
#   5. runs daemon-reload, reloads udev and enables/starts the service.
#
# Note: the unit is named upsmon-api.service on purpose -- `upsmon.service` is
# already an alias of the NUT package (nut-monitor.service) and must not be overwritten.
#
# Afterwards: journalctl -u upsmon-api -f
#             curl -s http://127.0.0.1:8080/health | python3 -m json.tool
#             curl -s http://127.0.0.1:8080/api/v1/ups  | python3 -m json.tool
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXAMPLES_DIR="$PROJECT_DIR/config/examples"

UNIT_SRC="$EXAMPLES_DIR/upsmon-api.service"
CONF_SRC="$EXAMPLES_DIR/upsmon.conf"
RULES_SRC="$EXAMPLES_DIR/99-upsmon.rules"

UNIT_DST="/etc/systemd/system/upsmon-api.service"
CONF_DIR="/etc/upsmon"
CONF_DST="$CONF_DIR/upsmon.conf"
RULES_DST="/etc/udev/rules.d/99-upsmon.rules"

# per-device services that the unified API replaces
LEGACY_SERVICES=(ts-shara-api.service sms-api.service)

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "error: run with sudo: sudo $0" >&2
    exit 1
fi

for src in "$UNIT_SRC" "$CONF_SRC" "$RULES_SRC"; do
    [[ -f "$src" ]] || { echo "error: file not found: $src" >&2; exit 1; }
done

SYSTEMCTL="$(command -v systemctl || true)"
if [[ -z "$SYSTEMCTL" ]]; then
    echo "error: systemctl not found (host without systemd)" >&2
    exit 1
fi

# user that will run the service: whoever invoked sudo (must be in the dialout group)
SERVICE_USER="${SUDO_USER:-root}"
echo "==> project:  $PROJECT_DIR"
echo "==> user:     $SERVICE_USER"
if ! id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx dialout; then
    echo "warning: $SERVICE_USER is not in the dialout group; run: sudo usermod -aG dialout $SERVICE_USER" >&2
fi

# 1) systemd unit, with this host's user and folder
#    (a unit file does not use quotes; a URL with spaces is percent-encoded,
#     with the % sign escaped as %% in unit files)
DOC_URL="file:${PROJECT_DIR// /%%20}/docs/unified-api.md"
sed -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" \
    -e "s|^Documentation=file:.*|Documentation=$DOC_URL|" \
    "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"
echo "==> unit installed: $UNIT_DST"

# 2) configuration (never overwrites an existing one)
#    The service runs as $SERVICE_USER:dialout and MUST be able to read this file:
#    owner root, group dialout, mode 0640. Without the right group the configparser
#    reads nothing and the service dies with "no device configured".
install -d -m 0755 "$CONF_DIR"
if [[ -f "$CONF_DST" ]]; then
    echo "==> configuration preserved: $CONF_DST"
else
    install -m 0640 "$CONF_SRC" "$CONF_DST"
    echo "==> configuration installed: $CONF_DST"
fi
if ! getent group dialout >/dev/null; then
    echo "warning: dialout group does not exist; adjust the owner/group of $CONF_DST manually" >&2
else
    chown root:dialout "$CONF_DST"
    chmod 0640 "$CONF_DST"
fi

# 3) udev rule
install -m 0644 "$RULES_SRC" "$RULES_DST"
echo "==> udev rule installed: $RULES_DST"

# 4) warning about legacy (per-device) services
for legacy in "${LEGACY_SERVICES[@]}"; do
    if "$SYSTEMCTL" list-unit-files "$legacy" &>/dev/null; then
        echo "warning: $legacy still exists; the unified API replaces this service --"
        echo "         disable it after validating:  sudo systemctl disable --now $legacy"
    fi
done

# the legacy udev rule restarts the per-device service on cable reconnection, and
# `systemctl restart` re-enables the unit even when disabled -- that would steal the serial port
for rules in 99-ts-shara-ups.rules 99-sms-ups.rules; do
    if [[ -f "/etc/udev/rules.d/$rules" ]]; then
        echo "warning: /etc/udev/rules.d/$rules (legacy) still restarts the per-device API;"
        echo "         remove it:  sudo rm -f /etc/udev/rules.d/$rules"
    fi
done

# 5) activation
echo "==> reloading systemd and udev"
"$SYSTEMCTL" daemon-reload
udevadm control --reload-rules
udevadm trigger

echo "==> enabling and starting upsmon-api"
"$SYSTEMCTL" enable --now upsmon-api.service

echo
"$SYSTEMCTL" --no-pager --full status upsmon-api.service || true
echo
echo "Logs:      journalctl -u upsmon-api -f"
echo "Health:    curl -s http://127.0.0.1:8080/health | python3 -m json.tool"
echo "Devices:   curl -s http://127.0.0.1:8080/api/v1/ups | python3 -m json.tool"
echo "No cable:  /health responds 503 \"degraded\" until the USB is reconnected."
