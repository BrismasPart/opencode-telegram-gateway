/**
 * Streaming previews via OpenCode's `session.text.delta` events.
 *
 * The event payload shape is handled defensively because V2 event details are
 * experimental; we look for a session id and a text delta in the common places.
 * Only the *preview* is edited here. The final send is always owned by the
 * main dispatch path, so a missed/garbled delta can never duplicate the answer.
 */
import type { GatewayConfig } from "./config.js"
import type { TelegramApi } from "./telegram.js"
import { safeError } from "./redact.js"

export interface ActiveTurn {
  chatId: string
  messageId: number
  buffer: string
  lastEditAt: number
}

/** Extract (sessionID, delta) from a session.text.delta event. */
export function extractDelta(ev: any): { sessionID: string; delta: string } | null {
  if (!ev || ev.type !== "session.text.delta") return null
  const d = ev.data ?? {}
  const sessionID: string | undefined =
    d.sessionID ?? ev.sessionID ?? ev.properties?.sessionID ?? ev.payload?.sessionID
  const delta: string | undefined =
    d.delta ?? ev.delta ?? ev.text ?? ev.part?.text ?? ev.properties?.delta ?? ev.payload?.delta
  if (typeof sessionID !== "string" || typeof delta !== "string" || !delta) return null
  return { sessionID, delta }
}

export function startStreaming(
  ctx: any,
  config: GatewayConfig,
  active: Map<string, ActiveTurn>,
  api: TelegramApi,
): () => void {
  const controller = new AbortController()

  void (async () => {
    try {
      const stream = ctx.event.subscribe({
        types: ["session.text.delta"],
        signal: controller.signal,
      })
      for await (const event of stream) {
        if (controller.signal.aborted) break
        const parsed = extractDelta(event)
        if (!parsed) continue
        const { sessionID, delta } = parsed
        const turn = active.get(sessionID)
        if (!turn) continue

        turn.buffer += delta
        const now = Date.now()
        if (now - turn.lastEditAt < config.editIntervalMs) continue
        turn.lastEditAt = now
        const preview = turn.buffer.length > config.maxTextChars
          ? turn.buffer.slice(0, config.maxTextChars - 1) + "…"
          : turn.buffer
        try {
          await api.editText(turn.chatId, turn.messageId, preview || "…")
        } catch (e) {
          // Streaming is best-effort; never fail the turn over a preview.
          console.warn(`[telegram-gateway] preview edit: ${safeError(e, config.token)}`)
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        console.warn(`[telegram-gateway] event stream stopped: ${safeError(e, config.token)}`)
      }
    }
  })()

  return () => controller.abort()
}
