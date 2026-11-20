/**
 * Secure secrets-file loader, modeled on Hermes' `.env` handling.
 *
 * - Never logs values (or paths containing values).
 * - Requires owner-only permissions (mode 0600) and current-user ownership.
 * - Real environment variables always win over the file.
 * - Only gateway-related keys are accepted, limiting the blast radius of a
 *   malformed or edited file.
 */
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const DEFAULT_ENV_FILE = join(homedir(), ".config", "opencode", "telegram-gateway.env")

const ALLOWED_PREFIXES = ["TELEGRAM_", "OPENCODE_TELEGRAM_"]
const KEY_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/** `explicit === false` disables file loading (useful for tests). */
export function resolveEnvFile(explicit?: string | false): string | false {
  if (explicit === false) return false
  const raw = explicit ?? process.env.TELEGRAM_GATEWAY_ENV_FILE ?? DEFAULT_ENV_FILE
  return raw.trim() || DEFAULT_ENV_FILE
}

export function loadSecretsFile(explicit?: string | false): number {
  const path = resolveEnvFile(explicit)
  if (path === false) return 0

  let st
  try {
    st = statSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw new Error(`Cannot access secrets file ${path}: ${(e as Error).message}`)
  }
  if (!st.isFile()) throw new Error(`Secrets path ${path} is not a regular file.`)

  if (process.platform !== "win32") {
    if (st.mode & 0o077) {
      throw new Error(`Secrets file ${path} is readable by group/other. Run: chmod 600 ${path}`)
    }
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
      throw new Error(`Secrets file ${path} is not owned by the current user.`)
    }
  }

  const text = readFileSync(path, "utf8")
  let loaded = 0
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return
    const match = KEY_RE.exec(trimmed)
    if (!match) {
      throw new Error(`Invalid line ${index + 1} in secrets file ${path} (expected KEY=VALUE).`)
    }
    const [, key, rawValue] = match
    if (!ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      throw new Error(`Unsupported key ${key} on line ${index + 1} in secrets file ${path}.`)
    }
    if (process.env[key] !== undefined) return // real environment wins
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
    loaded += 1
  })
  return loaded
}
