/**
 * OpenCode Telegram Gateway — V2 server plugin.
 *
 * Loads via `.opencode/plugins/telegram-gateway/` or the `plugins` config array.
 * Configuration is entirely via environment variables (see README.md).
 *
 * This plugin intentionally has no external dependencies: OpenCode runs it
 * with Bun/Node, and the Bot API is called with fetch.
 */
import { loadConfig } from "./config.js"
import { redact, safeError } from "./redact.js"
import { TelegramApi, messageText, splitByUtf16, type Update } from "./telegram.js"
import { ReceiptStore } from "./dedup.js"
import { SessionBridge } from "./sessions.js"
import { startStreaming, type ActiveTurn } from "./streaming.js"
import { startPolling, startWebhook } from "./transport.js"
import { diag } from "./diagnostics.js"
import { acquirePollerLock, type PollerLock } from "./single-instance.js"
import { parseCommand, commandAllowed, runCommand } from "./commands.js"
import { registerMenu, ForumMenuGuard, menuRowsForForum } from "./command_menu.js"
import { buildInlinePage, emptyResults, CACHE_TIME_SECONDS } from "./inline_picker.js"
import { fileURLToPath } from "node:url"
import { messageMedia, cacheTelegramFile, attachmentFor, mediaNote } from "./media_inbound.js"
import { parseMediaDirectives, sendMediaFile } from "./media_outbound.js"
import { transcribe } from "./stt.js"
import { FloodGuard } from "./flood.js"
import { toMarkdownV2 } from "./markdown.js"

type PluginCtx = {
  app: { version: string }
  location: { directory: string }
  storage: any
  session: any
  event: { subscribe(input: any): AsyncIterable<unknown> }
  options?: Record<string, unknown>
}

// Resolve relative to this module so the plugin works from any directory.
const ALLOW_SCRIPT = fileURLToPath(new URL("../scripts/allow-user.sh", import.meta.url))
/** One notice per sender per 10 minutes, so a stranger cannot spam the bot. */
const DENY_NOTICE_COOLDOWN_MS = 10 * 60 * 1000

export default {
  id: "telegram-gateway",

  async setup(ctx: PluginCtx) {
    // Config validation throws on bad/missing secrets -> plugin fails closed.
    const config = loadConfig()
    const token = config.token
    diag("setup", token)
    // Flood guard needs the bot id, so verify the token first with a plain API
    // client, then create the real client with the persisted guard.
    const bootstrap = new TelegramApi(token)
    let me: { id: number; username?: string }
    try {
      me = await bootstrap.verify()
    } catch (e) {
      throw new Error(`Telegram token verification failed: ${safeError(e, token)}`)
    }
    const flood = new FloodGuard(
      config.floodFile || `${process.env.HOME || ""}/.local/state/opencode/telegram-flood-${me.id}.json`,
      token,
    )
    const api = new TelegramApi(token, flood)

    if (config.allowedUsers.size === 0) {
      console.warn(
        "[telegram-gateway] TELEGRAM_ALLOWED_USERS is empty: NOBODY is authorized (default-deny). " +
          "Add your numeric Telegram user ID to the allowlist.",
      )
    }

    diag("verified", token, { bot: me.id, allowlist: config.allowedUsers.size })
    console.info(`[telegram-gateway] authenticated as bot id ${me.id}`)

    const receipts = new ReceiptStore(ctx)
    const sessions = new SessionBridge(ctx, config)
    const active = new Map<string, ActiveTurn>()
    const controller = new AbortController()
    const lastDenyNotice = new Map<string, number>()
    const forumMenu = new ForumMenuGuard(api, token, menuRowsForForum(config.commandMenuMax))

    const stopStreaming = config.streaming ? startStreaming(ctx, config, active, api) : () => {}

    // Post-connect housekeeping: register the `/` menu off the connect path so
    // a slow Bot API call cannot sink the timed plugin setup (non-fatal).
    void registerMenu(api, ctx, token, config.commandMenuMax).catch((e) => {
      diag("menu_setup_failed", token, { error: (e as Error)?.name ?? "unknown" })
    })

    const deliver = async (chatId: string, text: string, replyTo?: number, previewId?: number) => {
      // Strip MEDIA: directives and upload the files as native attachments.
      const parsed = parseMediaDirectives(text)
      for (const directive of parsed.media) {
        await sendMediaFile(api, chatId, directive, config.maxMediaBytes, token)
      }
      const raw = parsed.text || "_(empty response)_"
      const formatted = config.markdown ? toMarkdownV2(raw) : raw
      const chunks = splitByUtf16(formatted, config.maxTextChars)
      const plainChunks = splitByUtf16(raw, config.maxTextChars)
      const plainFor = (i: number) => plainChunks[i] ?? raw.slice(0, config.maxTextChars)
      const parseMode = config.markdown ? "MarkdownV2" : undefined
      if (previewId !== undefined) {
        // Edit the placeholder with chunk 1, then send the rest as new messages.
        await api.editText(chatId, previewId, chunks[0], parseMode, plainFor(0))
        for (let i = 1; i < chunks.length; i++) await api.sendText(chatId, chunks[i], undefined, parseMode, plainFor(i))
      } else {
        let first = true
        for (let i = 0; i < chunks.length; i++) {
          await api.sendText(chatId, chunks[i], first ? replyTo : undefined, parseMode, plainFor(i))
          first = false
        }
      }
    }

    const handleUpdate: (u: Update) => Promise<void> = async (update) => {
      // Inline queries: authorize on user identity alone (no chat context),
      // fail closed with an answered empty list. Never leak the catalog.
      if (update.inline_query) {
        const iq = update.inline_query
        const uid = String(iq.from?.id ?? "")
        try {
          if (!uid || !config.allowedUsers.has(uid)) {
            await api.answerInlineQuery(iq.id, emptyResults(), { cacheTime: CACHE_TIME_SECONDS, isPersonal: true })
            diag("inline_deny", token, { user: uid })
            return
          }
          const page = buildInlinePage(iq.query ?? "", iq.offset ?? "")
          await api.answerInlineQuery(iq.id, page.results, {
            cacheTime: CACHE_TIME_SECONDS,
            isPersonal: true,
            ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
          })
          diag("inline_answer", token, { user: uid, count: page.results.length })
        } catch (e) {
          diag("inline_error", token, { user: uid, error: (e as Error)?.name ?? "unknown" })
        }
        return
      }

      const msg = update.message ?? update.edited_message ?? update.channel_post
      if (!msg) return
      const chatId = String(msg.chat?.id ?? "")
      const userId = String(msg.from?.id ?? "")
      if (!chatId || !userId) return
      if (msg.from?.is_bot) return

      // Two-layer authorization: dedup first, allowlist second.
      if (await receipts.seen(update.update_id)) return
      await receipts.mark(update.update_id)

      if (!config.allowedUsers.has(userId)) {
        // Log IDs only, never message content.
        diag("deny", token, { update: update.update_id, user: userId, chat: chatId, allowlist: config.allowedUsers.size })
        console.warn(`[telegram-gateway] denied user ${userId} in chat ${chatId}`)
        if (config.unauthorizedBehavior === "pair") {
          const last = lastDenyNotice.get(userId) ?? 0
          if (Date.now() - last >= DENY_NOTICE_COOLDOWN_MS) {
            lastDenyNotice.set(userId, Date.now())
            const notice = [
              "Hi! I don't recognize you yet, so I can't reply until the person running this bot approves you.",
              "",
              "If you run this bot, approve this user on the machine hosting it:",
              `  ${ALLOW_SCRIPT} ${userId}`,
              "Then run /reload in OpenCode and send your message again.",
              "",
              `Otherwise, send your Telegram user ID (${userId}) to the bot owner.`,
            ].join("\n")
            try {
              await deliver(chatId, notice, msg.message_id)
              diag("deny_notice", token, { update: update.update_id, user: userId })
            } catch (e) {
              diag("deny_notice_failed", token, { user: userId, error: (e as Error)?.name ?? "unknown" })
            }
          }
        }
        return
      }
      diag("accept", token, { update: update.update_id, user: userId, chat: chatId })

      // Forum supergroups do not inherit AllGroupChats; register the menu for
      // the chat on first message (once per chat per gateway run).
      if (msg.chat?.is_forum || msg.chat?.type === "forum") {
        void forumMenu.ensure(chatId)
      }

      const text = (msg.text ?? "").trim()

      // Slash commands: authorized user, THEN a separate command-ACL check.
      // Never let a command reach the agent as a prompt.
      const cmd = parseCommand(text === "/start" ? "/help" : text)
      if (cmd) {
        if (!commandAllowed(cmd.name, userId, config)) {
          diag("command_denied", token, { user: userId, command: cmd.name })
          await deliver(chatId, "You are not allowed to run that command.", msg.message_id)
          return
        }
        diag("command", token, { user: userId, command: cmd.name })
        try {
          const reply = await runCommand(cmd, {
            ctx, config, sessions, userId, chatId, botId: me.id, title: `Telegram ${msg.chat.type} ${chatId}`,
          })
          await deliver(chatId, reply, msg.message_id)
        } catch (e) {
          diag("command_error", token, { user: userId, command: cmd.name, error: (e as Error)?.name ?? "unknown" })
          await deliver(chatId, `Command failed: ${safeError(e, token)}`, msg.message_id)
        }
        return
      }

      // Download inbound media and build OpenCode attachments.
      const files: Array<{ uri: string; name: string; description: string }> = []
      const notes: string[] = []
      if (config.mediaEnabled) {
        for (const item of messageMedia(msg)) {
          const cached = await cacheTelegramFile(api, item.fileId, item.label, config.maxMediaBytes, token, item.name, item.mime)
          if (!cached) continue
          diag("media_cached", token, { kind: cached.kind, bytes: cached.bytes })
          if (cached.kind === "audio") {
            const transcript = await transcribe(cached.path, token)
            notes.push(transcript ? `[Voice transcript] ${transcript}` : mediaNote(cached))
          } else {
            files.push(attachmentFor(cached, mediaNote(cached)))
            if (cached.kind === "binary" || cached.kind === "audio" || cached.kind === "video") notes.push(mediaNote(cached))
          }
        }
      }

      if (!text && files.length === 0 && notes.length === 0) {
        await deliver(chatId, "I only understand text and media attachments.", msg.message_id)
        return
      }

      const title = `Telegram ${msg.chat.type} ${chatId}`
      const sessionID = await sessions.getOrCreate(chatId, title)

      let previewId: number | undefined
      if (config.streaming) {
        try {
          previewId = await api.sendText(chatId, "…", msg.message_id)
          active.set(sessionID, { chatId, messageId: previewId, buffer: "", lastEditAt: Date.now() })
        } catch (e) {
          console.warn(`[telegram-gateway] preview send failed: ${safeError(e, token)}`)
          previewId = undefined
        }
      }

      try {
        const prompt = [messageText(msg), ...notes].filter(Boolean).join("\n\n")
        await sessions.prompt(sessionID, prompt, files)
        const final = await sessions.finalText(sessionID)
        await deliver(chatId, final, msg.message_id, previewId)
        diag("reply", token, { update: update.update_id, chat: chatId })
        console.info(`[telegram-gateway] replied in chat ${chatId} via session ${redact(sessionID, token)}`)
      } catch (e) {
        diag("turn_error", token, { update: update.update_id, chat: chatId, error: (e as Error)?.name ?? "unknown" })
        console.error(`[telegram-gateway] turn failed in chat ${chatId}: ${safeError(e, token)}`)
        if (previewId !== undefined) {
          try {
            await api.editText(chatId, previewId, "Sorry — I couldn't complete that turn.")
          } catch {
            // best effort
          }
        } else {
          try {
            await api.sendText(chatId, "Sorry — I couldn't complete that turn.")
          } catch {
            // best effort
          }
        }
      } finally {
        active.delete(sessionID)
      }
    }

    let stopTransport: () => void = () => {}
    let lock: PollerLock | null = null
    if (config.webhookUrl) {
      stopTransport = await startWebhook(config, api, handleUpdate)
    } else {
      // Telegram allows only one getUpdates poller per token. A global plugin
      // loads in every OpenCode location, so elect a single owner.
      const startPollingHere = (owner: PollerLock) => {
        diag("poll_start", token)
        startPolling(api, handleUpdate, controller.signal, token, () => owner.isOwner())
        console.info("[telegram-gateway] polling started")
      }
      lock = acquirePollerLock(token)
      if (lock) {
        startPollingHere(lock)
      } else {
        // The previous owner may have been torn down by a reload without
        // running cleanup. Retry so we take over once its lock goes stale.
        diag("lock_busy", token)
        const retry = setInterval(() => {
          if (controller.signal.aborted) return
          const acquired = acquirePollerLock(token)
          if (acquired) {
            clearInterval(retry)
            lock = acquired
            startPollingHere(acquired)
          }
        }, 5_000)
        retry.unref?.()
        stopTransport = () => clearInterval(retry)
      }
    }

    return () => {
      stopTransport()
      stopStreaming()
      lock?.release()
      active.clear()
    }
  },
}
