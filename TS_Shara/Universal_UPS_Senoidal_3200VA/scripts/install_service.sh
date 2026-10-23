#!/usr/bin/env bash
# Installs the TS Shara UPS REST API as a systemd service, with a udev rule.
#
# Usage (requires sudo):
#   sudo scripts/install_service.sh
#
# What it does:
#   1. installs /etc/systemd/system/ts-shara-api.service, adjusting the user and
#      the project folder for this host (the path contains spaces);
#   2. installs /etc/ts-shara-api/ts_shara_api.conf (preserves an existing configuration);
#   3. installs /etc/udev/rules.d/99-ts-shara-ups.rules (dialout permission,
#      ModemManager ignoring the device and restart on cable reconnection);
#   4. runs daemon-reload, reloads udev and enables/starts the service.
#
# Afterwards: journalctl -u ts-shara-api -f
#             curl -s http://127.0.0.1:8081/health | python3 -m json.tool
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
EXAMPLES_DIR="$PROJECT_DIR/config/examples"

UNIT_SRC="$EXAMPLES_DIR/ts-shara-api.service"
CONF_SRC="$EXAMPLES_DIR/ts_shara_api.conf"
RULES_SRC="$EXAMPLES_DIR/99-ts-shara-ups.rules"

UNIT_DST="/etc/systemd/system/ts-shara-api.service"
CONF_DIR="/etc/ts-shara-api"
CONF_DST="$CONF_DIR/ts_shara_api.conf"
RULES_DST="/etc/udev/rules.d/99-ts-shara-ups.rules"

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
echo "==> project:  $PROJECT_DIR"
echo "==> user:     $SERVICE_USER"
if ! id -nG "$SERVICE_USER" 2>/dev/null | tr ' ' '\n' | grep -qx dialout; then
    echo "warning: $SERVICE_USER is not in the dialout group; run: sudo usermod -aG dialout $SERVICE_USER" >&2
fi

# 1) systemd unit, with this host's user and folder
#    (a unit file does not use quotes; a URL with spaces is percent-encoded,
#     with the % sign escaped as %% in unit files)
DOC_URL="file:${PROJECT_DIR// /%%20}/docs/rest-api.md"
sed -e "s|^User=.*|User=$SERVICE_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$PROJECT_DIR|" \
    -e "s|^Documentation=file:.*|Documentation=$DOC_URL|" \
    "$UNIT_SRC" > "$UNIT_DST"
chmod 0644 "$UNIT_DST"
echo "==> unit installed: $UNIT_DST"

# 2) configuration (never overwrites an existing one)
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

echo "==> enabling and starting ts-shara-api"
"$SYSTEMCTL" enable --now ts-shara-api.service

echo
"$SYSTEMCTL" --no-pager --full status ts-shara-api.service || true
echo
echo "Logs:      journalctl -u ts-shara-api -f"
echo "Health:    curl -s http://127.0.0.1:8081/health | python3 -m json.tool"
echo "No cable:  /health responds 503 \"degraded\" until the USB is reconnected."
