/**
 * Minimal, redacted diagnostics written to a local file.
 *
 * OpenCode captures its own logger but not plugin `console` output, so we
 * write a small event log we can inspect. NEVER write tokens, message text,
 * URLs, or payloads — only IDs and error class names.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { redact } from "./redact.js"

const FILE = join(homedir(), ".local", "state", "opencode", "telegram-gateway-events.log")

export function diag(event: string, token: string, fields: Record<string, string | number> = {}): void {
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${redact(String(value), token)}`)
    .join(" ")
  try {
    mkdirSync(dirname(FILE), { recursive: true })
    appendFileSync(FILE, `${new Date().toISOString()} ${event}${suffix ? " " + suffix : ""}\n`)
  } catch {
    // Diagnostics must never break the gateway.
  }
}
