#!/usr/bin/env bash
# Installs the REST API of the SMS Power Sinus NG uPS3200S UPS as a systemd service,
# with a udev rule.
#
# Usage (needs sudo):
#   sudo scripts/install_service.sh
#
# What it does:
#   1. installs /etc/systemd/system/sms-api.service, adjusting the user and
#      project folder for this host (the path contains spaces);
#   2. installs /etc/sms-api/sms_api.conf (preserves existing configuration);
#   3. installs /etc/udev/rules.d/99-sms-ups.rules (dialout permission,
#      ModemManager ignoring the device and restart on cable reconnection);
#   4. runs daemon-reload, reloads udev and enables/starts the service.
#
# Afterwards: journalctl -u sms-api -f
#             curl -s http://127.0.0.1:8082/health | python3 -m json.tool
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXAMPLES_DIR="$PROJECT_DIR/config/examples"

UNIT_SRC="$EXAMPLES_DIR/sms-api.service"
CONF_SRC="$EXAMPLES_DIR/sms_api.conf"
RULES_SRC="$EXAMPLES_DIR/99-sms-ups.rules"

UNIT_DST="/etc/systemd/system/sms-api.service"
CONF_DIR="/etc/sms-api"
CONF_DST="$CONF_DIR/sms_api.conf"
RULES_DST="/etc/udev/rules.d/99-sms-ups.rules"

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

# user that will run the service: whoever called sudo (must be in the dialout group)
SERVICE_USER="${SUDO_USER:-root}"
echo "==> project: $PROJECT_DIR"
echo "==> user:    $SERVICE_USER"
if ! id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx dialout; then
    echo "warning: $SERVICE_USER is not in the dialout group; run: sudo usermod -aG dialout $SERVICE_USER" >&2
fi

# 1) systemd unit, with the user and folder of this host
#    (a unit file does not use quotes; a URL with spaces is percent-encoded,
#     with the % sign escaped as %% in unit files)
DOC_URL="file:${PROJECT_DIR// /%%20}/docs/rest-api.md"
sed -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" \
    -e "s|^Documentation=file:.*|Documentation=$DOC_URL|" \
    "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"
echo "==> unit installed: $UNIT_DST"

# 2) configuration (never overwrites the existing one)
install -d -m 0755 "$CONF_DIR"
if [[ -f "$CONF_DST" ]]; then
    echo "==> configuration preserved: $CONF_DST"
else
    install -m 0640 "$CONF_SRC" "$CONF_DST"
    echo "==> configuration installed: $CONF_DST"
fi

# 3) udev rule
install -m 0644 "$RULES_SRC" "$RULES_DST"
echo "==> udev rule installed: $RULES_DST"

# 4) activation
echo "==> reloading systemd and udev"
"$SYSTEMCTL" daemon-reload
udevadm control --reload-rules
udevadm trigger

echo "==> enabling and starting sms-api"
"$SYSTEMCTL" enable --now sms-api.service

echo
"$SYSTEMCTL" --no-pager --full status sms-api.service || true
echo
echo "Logs:      journalctl -u sms-api -f"
echo "Health:    curl -s http://127.0.0.1:8082/health | python3 -m json.tool"
echo "No cable:  /health answers 503 \"degraded\" until the USB is reconnected."
