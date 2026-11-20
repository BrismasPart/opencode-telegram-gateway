/**
 * Secret redaction. Telegram embeds the bot token in every API URL, so any
 * error text, URL, or log line can carry it. Every string that leaves this
 * plugin passes through here.
 */
export function redact(text: string, token: string): string {
  let out = text
  if (token) {
    out = out.split(token).join("<redacted-token>")
  }
  // Defense in depth: token-shaped sequences even if the exact token is unknown.
  out = out.replace(/bot\d{6,}:[-\w]{20,}/g, "bot<id>:<redacted>")
  // Strip query strings from URLs (may carry secrets).
  out = out.replace(/(https?:\/\/[^\s'"]+?)\?[^\s'"]*/g, "$1?<redacted>")
  return out
}

export function safeError(error: unknown, token: string): string {
  if (error instanceof Error) {
    return redact(`${error.name}: ${error.message}`, token)
  }
  return redact(String(error), token)
}

/** Never log full API URLs. Log only method + status. */
export function logMethod(method: string, ok: boolean, token: string, detail = ""): void {
  const suffix = detail ? ` ${redact(detail, token)}` : ""
  const line = `[telegram-gateway] ${method} ${ok ? "ok" : "failed"}${suffix}`
  if (ok) console.info(line)
  else console.warn(line)
}
