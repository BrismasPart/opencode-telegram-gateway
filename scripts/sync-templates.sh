#!/usr/bin/env bash
# Sync the live plugin into the Telegram Gateway Builder skill's templates.
# Run this after changing the plugin so future from-scratch builds get the
# latest base. Copies to BOTH the global and project skill locations.
set -euo pipefail

PLUGIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve OpenCode's global config dir (do not hardcode across OSes).
if command -v opencode >/dev/null 2>&1; then
  CONFIG_DIR="$(opencode debug paths config 2>/dev/null || true)"
fi
CONFIG_DIR="${CONFIG_DIR:-${HOME}/.config/opencode}"

TARGETS=(
  "${CONFIG_DIR}/skills/telegram-gateway"
  "${HOME}/.config/opencode/skills/telegram-gateway"
  "${HOME}/.opencode/skills/telegram-gateway"
  "/data/workspace/.opencode/skills/telegram-gateway"
)

# De-duplicate targets while preserving order.
declare -A SEEN=()
UNIQUE=()
for t in "${TARGETS[@]}"; do
  [[ -n "$t" && -z "${SEEN[$t]+x}" ]] && SEEN[$t]=1 && UNIQUE+=("$t")
done

synced=0
for skill in "${UNIQUE[@]}"; do
  if [[ ! -f "${skill}/SKILL.md" ]]; then
    echo "skip ${skill}: not a Telegram Gateway skill (no SKILL.md)"
    continue
  fi
  if [[ ! -d "${skill}/templates" ]]; then
    echo "skip ${skill}: no templates/ directory (manual skill, not the builder)"
    continue
  fi

  # Copy plugin sources into templates, replacing only managed subpaths.
  rm -rf "${skill}/templates/src" "${skill}/templates/scripts" "${skill}/templates/test"
  cp -R "${PLUGIN_DIR}/src" "${skill}/templates/src"
  cp -R "${PLUGIN_DIR}/scripts" "${skill}/templates/scripts"
  cp -R "${PLUGIN_DIR}/test" "${skill}/templates/test"
  cp "${PLUGIN_DIR}/package.json" "${skill}/templates/package.json"
  cp "${PLUGIN_DIR}/README.md" "${skill}/templates/README.md"

  # sync-templates.sh itself must not land inside templates/scripts/ recursively.
  rm -f "${skill}/templates/scripts/sync-templates.sh"
  echo "synced ${skill}/templates ($(find "${skill}/templates" -type f | wc -l) files)"
  synced=$((synced + 1))
done

[[ "$synced" -gt 0 ]] || { echo "no skill templates found to sync" >&2; exit 1; }
