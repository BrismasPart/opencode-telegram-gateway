#!/usr/bin/env bash
# Install a systemd --user unit that runs OpenCode headless as the gateway host.
# Contains no secrets: the token is read from the owner-only env file at runtime.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${HOME}/.config/opencode/telegram-gateway.env"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_FILE="${UNIT_DIR}/telegram-gateway.service"

command -v opencode >/dev/null 2>&1 || { echo "opencode not found in PATH" >&2; exit 1; }
OPENCODE_BIN="$(command -v opencode)"

command -v systemctl >/dev/null 2>&1 || { echo "systemctl not found (systemd --user required)" >&2; exit 1; }

# Create an owner-only secrets file if absent. Values are added by the user/wizard,
# never by this script (so the token never appears in a command line or history).
if [[ ! -e "${ENV_FILE}" ]]; then
  mkdir -p "$(dirname -- "${ENV_FILE}")"
  install -m 600 /dev/null "${ENV_FILE}"
  echo "Created ${ENV_FILE} (mode 0600). Add your TELEGRAM_* values before starting."
else
  chmod 600 "${ENV_FILE}"
fi

mkdir -p "${UNIT_DIR}"
sed "s|@OPENCODE_BIN@|${OPENCODE_BIN}|g" "${SCRIPT_DIR}/telegram-gateway.service" > "${UNIT_FILE}"
systemctl --user daemon-reload

echo
echo "Installed ${UNIT_FILE}"
echo
echo "Next steps:"
echo "  1. Put TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS into ${ENV_FILE}"
echo "  2. opencode service set disabled true   # avoid a second auto-started server clashing on port 4096"
echo "  3. systemctl --user enable --now telegram-gateway"
echo "  4. systemctl --user status telegram-gateway"
echo
echo "Plugin config in opencode.jsonc:"
echo '  "plugins": ["~/.config/opencode/plugins/opencode-telegram-gateway"]'
