/**
 * Bridges Telegram chats to OpenCode sessions.
 *
 * SECURITY: Telegram-driven sessions get a restrictive permission set by
 * default. Dangerous actions are set to `ask`, so a human watching the
 * OpenCode TUI/desktop must approve them — this is the equivalent of the
 * Hermes gateway's exec-approval flow, and is the primary mitigation for
 * prompt injection in message bodies.
 */
import type { GatewayConfig } from "./config.js"

const SESSION_PREFIX = "tg:session:"

/** List endpoints may return a bare array or { data: [...] }. */
function unwrap(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.data)) return value.data
  return []
}

/** Pull the last assistant text from a session context message list. */
export function extractAssistantText(messages: readonly any[]): string {
  for (const m of [...messages].reverse()) {
    const any = m as any
    const info = any.info ?? any
    // V2 assistant messages use `type: "assistant"` and a `content` array.
    // Accept the older `role` + `parts` shape too, for forward/backward safety.
    const isAssistant = info?.type === "assistant" || info?.role === "assistant" || any.type === "assistant"
    if (!isAssistant) continue
    const parts = any.content ?? any.parts
    if (!Array.isArray(parts)) continue
    const text = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n\n")
      .trim()
    if (text) return text
  }
  return ""
}

export class SessionBridge {
  constructor(
    private readonly ctx: any,
    private readonly config: GatewayConfig,
  ) {}

  async getOrCreate(sessionKey: string, title: string): Promise<string> {
    const key = `${SESSION_PREFIX}${sessionKey}`
    const existing = await this.ctx.storage.get<string>(key)
    if (existing) {
      try {
        await this.ctx.session.get({ sessionID: existing })
        return existing
      } catch {
        // Stale mapping — fall through and create a new session.
      }
    }

    // Set agent and permissions AT CREATION so restrictions are in place before
    // the very first prompt (no race window where a tool could run unrestricted).
    const createInput: Record<string, unknown> = { title }
    if (this.config.workdir) createInput.location = { directory: this.config.workdir }
    if (this.config.agent) createInput.agent = this.config.agent
    const rules = this.config.deniedTools.map((action) => ({
      action,
      resource: "*",
      effect: "ask",
    }))
    if (rules.length) createInput.permissions = rules

    const created = await this.ctx.session.create(createInput)
    const sessionID: string = created.id ?? created.sessionID
    if (!sessionID) throw new Error("session.create returned no id")

    await this.ctx.storage.set(key, sessionID)
    return sessionID
  }

  /** The current session id for a routing key, if one is bound. */
  async current(sessionKey: string): Promise<string | null> {
    const key = `${SESSION_PREFIX}${sessionKey}`
    const id = await this.ctx.storage.get<string>(key)
    if (!id) return null
    try {
      await this.ctx.session.get({ sessionID: id })
      return id
    } catch {
      return null
    }
  }

  /** Rotate to a fresh session (/new). Does not delete the old session. */
  async rotate(sessionKey: string, title: string): Promise<string> {
    await this.ctx.storage.remove(`${SESSION_PREFIX}${sessionKey}`)
    return this.getOrCreate(sessionKey, title)
  }

  /** Bind this routing key to an existing session (/resume). Verifies first. */
  async bind(sessionKey: string, sessionID: string): Promise<boolean> {
    try {
      await this.ctx.session.get({ sessionID })
    } catch {
      return false
    }
    await this.ctx.storage.set(`${SESSION_PREFIX}${sessionKey}`, sessionID)
    return true
  }

  /** List sessions (optionally filtered). Returns info objects with ids. */
  async list(opts: { search?: string; limit?: number } = {}): Promise<any[]> {
    const out: any[] = []
    let cursor: string | undefined
    do {
      const page = await this.ctx.session.list({
        ...(opts.search ? { search: opts.search } : {}),
        limit: opts.limit ?? 50,
        ...(cursor ? { cursor } : {}),
      })
      const rows = unwrap(page)
      out.push(...rows)
      cursor = page?.cursor?.next ?? undefined
      if (out.length >= (opts.limit ?? 50)) break
    } while (cursor)
    return out.slice(0, opts.limit ?? 50)
  }

  /** Interrupt a running turn (/stop). Session is preserved. */
  async interrupt(sessionID: string): Promise<void> {
    await this.ctx.session.interrupt({ sessionID, resume: false })
  }

  async prompt(sessionID: string, text: string, files?: Array<{ uri: string; name: string; description: string }>): Promise<void> {
    await this.ctx.session.prompt({ sessionID, text, ...(files?.length ? { files } : {}) })
  }

  /** Wait for the turn to finish, then read the last assistant text.
   * A pending permission is NOT "done" — keep waiting so we never deliver an
   * interim message between two approvals. After `session.wait()` returns we
   * SETTLE: a short grace period, then re-check for (a) a newly-created
   * permission and (b) newly-arrived messages. Only when both are stable do we
   * declare the turn finished. This prevents the "message arrives after the
   * approval request" problem when a turn needs more than one approval. */
  async finalText(sessionID: string, timeoutMs = 600_000, settleMs = 1_500): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("turn timeout")), timeoutMs)
    let messages: any[] = []
    try {
      let stableRounds = 0
      for (;;) {
        await this.ctx.session.wait({ sessionID }, { signal: controller.signal })
        // Settle: the agent can go briefly idle between consecutive tool calls
        // (e.g. between two approvals). Don't treat that as "turn finished".
        await new Promise((r) => setTimeout(r, settleMs))
        if (controller.signal.aborted) break

        let pending = 0
        try {
          const list = await this.ctx.permission.list({ sessionID })
          pending = Array.isArray(list) ? list.length : (Array.isArray((list as any)?.data) ? (list as any).data.length : 0)
        } catch { /* permission API unavailable — treat as no pending */ }
        const current = unwrap(await this.ctx.session.context({ sessionID }))
        if (pending > 0) {
          stableRounds = 0
          continue
        }
        // If the message list is still growing, the turn is still active.
        if (current.length !== messages.length) {
          messages = current
          stableRounds = 0
          continue
        }
        messages = current
        stableRounds++
        if (stableRounds >= 2) break // two consecutive stable checks
      }
    } catch {
      // A timeout does not mean the turn failed; read whatever is available.
    } finally {
      clearTimeout(timer)
    }
    if (!messages.length) {
      try { messages = unwrap(await this.ctx.session.context({ sessionID })) } catch { /* best effort */ }
    }
    return extractAssistantText(messages) || "_(No text response was produced.)_"
  }
}
