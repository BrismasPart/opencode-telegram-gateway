#!/usr/bin/env bash
# Add a Telegram user ID to the gateway allowlist in the owner-only secrets file.
# Run this on the machine that hosts the gateway:
#   ./allow-user.sh 123456789
# Then run /reload in OpenCode. The user ID is not a secret, so passing it on
# the command line is fine; nothing sensitive is written or echoed.
set -euo pipefail

USER_ID="${1:-}"
if ! [[ "$USER_ID" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <numeric-telegram-user-id>" >&2
  exit 1
fi

ENV_FILE="${HOME}/.config/opencode/telegram-gateway.env"
mkdir -p "$(dirname -- "${ENV_FILE}")"
if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 600 /dev/null "${ENV_FILE}"
fi

TMP="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
awk -v id="$USER_ID" '
  /^TELEGRAM_ALLOWED_USERS=/ {
    found = 1
    line = substr($0, index($0, "=") + 1)
    n = split(line, parts, ",")
    for (i = 1; i <= n; i++) {
      gsub(/^[ \t]+|[ \t]+$/, "", parts[i])
      if (parts[i] == id) { duplicate = 1; break }
    }
    if (duplicate) print $0
    else printf "TELEGRAM_ALLOWED_USERS=%s,%s\n", line, id
    next
  }
  { print }
  END { if (!found) printf "TELEGRAM_ALLOWED_USERS=%s\n", id }
' "${ENV_FILE}" > "$TMP"
cat "$TMP" > "${ENV_FILE}"
rm -f "$TMP"
chmod 600 "${ENV_FILE}"

echo "Allowed Telegram user ${USER_ID}. Run /reload in OpenCode to apply."
