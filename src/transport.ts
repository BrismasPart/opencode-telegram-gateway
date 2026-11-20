/**
 * Inbound transports: long polling (default) and webhook.
 *
 * Polling has no inbound attack surface — updates arrive over the
 * authenticated outbound TLS connection. Webhook has one, so it is
 * hardened: mandatory secret (constant-time compare), POST + JSON only,
 * a 1 MiB body cap read *before* parsing, and immediate 200 so a slow
 * agent turn never holds the HTTP request open.
 */
import { createServer, type Server } from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { GatewayConfig } from "./config.js"
import type { TelegramApi, Update } from "./telegram.js"
import { safeError } from "./redact.js"
import { diag } from "./diagnostics.js"

export type HandleUpdate = (update: Update) => Promise<void>

const MAX_BODY_BYTES = 1024 * 1024

let activeStop: (() => void) | null = null

export function startPolling(
  api: TelegramApi,
  handle: HandleUpdate,
  signal: AbortSignal,
  token: string,
  isOwner: () => boolean = () => true,
): void {
  // A plugin reload re-runs setup without reliably invoking the old cleanup.
  // Stop any loop from a previous setup in this process before starting ours.
  if (activeStop) activeStop()
  const own = new AbortController()
  const stop = () => own.abort()
  activeStop = stop
  const onOuterAbort = () => own.abort()
  signal.addEventListener("abort", onOuterAbort, { once: true })

  void (async () => {
    let offset = 0
    let failures = 0
    while (!own.signal.aborted) {
      // A reload can leave an old instance's loop alive without cleanup.
      // Stop as soon as a newer instance owns the lock.
      if (!isOwner()) {
        diag("poll_displaced", token)
        break
      }
      try {
        const updates = await api.getUpdates(offset, own.signal)
        failures = 0
        diag("poll_ok", token, { updates: updates.length, offset })
        for (const update of updates) {
          if (own.signal.aborted) break
          offset = Math.max(offset, update.update_id + 1)
          try {
            await handle(update)
          } catch (e) {
            console.warn(`[telegram-gateway] update ${update.update_id}: ${safeError(e, token)}`)
          }
        }
      } catch (e) {
        if (own.signal.aborted) break
        failures += 1
        diag("poll_error", token, { attempt: failures, error: (e as Error)?.name ?? "unknown", detail: safeError(e, token) })
        const delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4))
        console.warn(`[telegram-gateway] polling error (${failures}): ${safeError(e, token)}; retry in ${delay / 1000}s`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    if (activeStop === stop) activeStop = null
    signal.removeEventListener("abort", onOuterAbort)
  })()
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function startWebhook(
  config: GatewayConfig,
  api: TelegramApi,
  handle: HandleUpdate,
): Promise<() => void> {
  if (!config.webhookUrl || !config.webhookSecret) {
    throw new Error("webhook mode requires both TELEGRAM_WEBHOOK_URL and TELEGRAM_WEBHOOK_SECRET")
  }
  await api.setWebhook(config.webhookUrl, config.webhookSecret)

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(body)
    }
    if (req.method !== "POST") return reply(405)
    if ((req.headers["content-type"] ?? "").split(";")[0].trim() !== "application/json") return reply(403)
    if (
      !secretMatches(
        req.headers["x-telegram-bot-api-secret-token"] as string | undefined,
        config.webhookSecret!,
      )
    ) {
      return reply(403)
    }

    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      let update: Update
      try {
        update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Update
        if (typeof update.update_id !== "number") throw new Error("missing update_id")
      } catch {
        // Never log the payload: it may contain a vault code or user data.
        return reply(400, '{"ok":false}')
      }
      // Ack immediately; process off the request path.
      reply(200, '{"ok":true}')
      void handle(update).catch((e) => {
        console.warn(`[telegram-gateway] webhook update ${update.update_id}: ${safeError(e, config.token)}`)
      })
    })
    req.on("error", () => reply(400))
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.webhookPort, config.webhookHost, resolve)
  })
  console.info(`[telegram-gateway] webhook listener on ${config.webhookHost}:${config.webhookPort}`)

  return () => {
    server.close()
    void api.deleteWebhook()
  }
}
