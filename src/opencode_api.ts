/**
 * Direct OpenCode server API client for operations that must target a
 * specific location (e.g. permission.reply).
 *
 * Why: the plugin-level `ctx.permission.reply` is bound to the plugin
 * instance's location. With a GLOBAL plugin loaded in multiple locations,
 * the instance that handles a Telegram tap may differ from the one owning
 * the session, so the reply resolves in the wrong location and fails with
 * "Permission request not found". The HTTP API accepts an explicit
 * `x-opencode-directory` header, which is what the CLI uses.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type ServiceInfo = { url?: string; password?: string }

function serviceInfo(): ServiceInfo | null {
  try {
    const path = join(homedir(), ".local", "state", "opencode", "service.json")
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/** Reply to a permission request via the HTTP API, scoped to a location. */
export async function httpPermissionReply(
  sessionID: string,
  requestID: string,
  decision: "once" | "always" | "reject",
  location?: string,
): Promise<boolean> {
  const info = serviceInfo()
  if (!info?.url || !info.password) return false
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
    }
    if (location) headers["x-opencode-directory"] = encodeURIComponent(location)
    const res = await fetch(
      `${info.url.replace(/\/$/, "")}/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
      { method: "POST", headers, body: JSON.stringify({ decision }), signal: AbortSignal.timeout(15_000) },
    )
    return res.ok
  } catch {
    return false
  }
}
