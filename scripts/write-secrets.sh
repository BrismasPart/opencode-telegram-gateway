#!/usr/bin/env bash
# Run this YOURSELF in a real terminal (not through the agent). The token is
# read with `read -s` so it is never echoed, never enters shell history, and
# never appears in a tool call, prompt, or log.
set -euo pipefail

ENV_FILE="${HOME}/.config/opencode/telegram-gateway.env"
mkdir -p "$(dirname -- "${ENV_FILE}")"
if [[ ! -e "${ENV_FILE}" ]]; then
  install -m 600 /dev/null "${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

read -rsp 'BotFather token (input hidden): ' TOKEN; echo
read -rp 'Allowed Telegram user IDs, comma-separated (blank = deny everyone): ' ALLOWED

{
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "${TOKEN}"
  if [[ -n "${ALLOWED}" ]]; then
    printf 'TELEGRAM_ALLOWED_USERS=%s\n' "${ALLOWED}"
  fi
} >> "${ENV_FILE}"

unset TOKEN ALLOWED
echo "Wrote ${ENV_FILE} (mode 0600). Token was not echoed or placed in history."
echo "Tell the agent you are done, then run /reload in OpenCode."
