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
import { PollingSupervisor } from "./reliability.js"
import { VisionDescriber, visionConfig } from "./vision.js"
import { shouldProcess } from "./gating.js"
import { InboundBatcher } from "./batching.js"
import { sessionKeyFor, sessionLabel } from "./session_routing.js"
import { shouldUseRich } from "./rich.js"
import { httpPermissionReply, httpFormReply, httpFormCancel } from "./opencode_api.js"
import { TurnQueue } from "./turn_queue.js"
import { questionText, questionKeyboard, optionAt, applyTyped, type QuestionState, type FormInfo } from "./questions.js"
import {
  writeRequesterMarker, readRequesterMarker, clearRequesterMarker,
  writePlannedMarker, readPlannedMarker, markPlannedDelivered, clearPlannedMarker,
  claimBootNotice, releaseBootNotice, NOTICE,
} from "./restart_state.js"
import {
  groupProviders, providerKeyboard, modelKeyboard, providerText, modelText,
  modelAt, type PickerState, type PickerModel,
} from "./model_picker.js"
import {
  approvalText, approvalChoices, approvalWord, decisionFor, newApprovalId,
  type ApprovalState, type ApprovalChoice,
} from "./approval.js"
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
    const pickerState = new Map<string, PickerState>() // one picker per chat
    const approvals = new Map<string, ApprovalState>() // approvalId → state
    const questions = new Map<string, QuestionState>() // questionId → state
    const typingAnswer = new Map<string, QuestionState>() // chatId → awaiting typed answer
    const turnQueue = new TurnQueue()
    const sessionOwner = new Map<string, { chatId: string; ownerId: string }>() // OpenCode session → chat
    const approvalTimerMs = config.approvalTimeoutMs
    const forumMenu = new ForumMenuGuard(api, token, menuRowsForForum(config.commandMenuMax))
    const vision = visionConfig() ? new VisionDescriber(token) : null
    let richDisabled = false // latched off on a capability error (method not found)

    // Status indicator: capture the original short description once, restore at shutdown.
    const statusFile = `${process.env.HOME || ""}/.local/state/opencode/telegram-status-${me.id}.json`
    if (config.statusIndicator) {
      try {
        const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs")
        if (!existsSync(statusFile)) {
          // Don't overwrite an operator's real description with "Online".
          mkdirSync(`${process.env.HOME || ""}/.local/state/opencode`, { recursive: true })
          writeFileSync(statusFile, JSON.stringify({ original: "" }), { mode: 0o600 })
        }
        await api.setShortDescription("Online")
      } catch { /* best effort */ }
    }

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

      // Native Rich Messages lane: raw GFM markdown rendered by Telegram.
      if (shouldUseRich(raw, config.richMessages, richDisabled)) {
        try {
          await api.sendRichMessage(chatId, raw, replyTo)
          diag("rich_sent", token, { chat: chatId, bytes: new TextEncoder().encode(raw).byteLength })
          return
        } catch (e) {
          if (TelegramApi.richUnavailable(e)) {
            richDisabled = true
            diag("rich_disabled", token, { error: (e as Error)?.name ?? "unknown" })
          } else if (TelegramApi.richParseError(e)) {
            diag("rich_parse_fallback", token)
            // fall through to MarkdownV2 for this reply
          } else {
            throw e // network/flood — do not duplicate via a different lane
          }
        }
      }

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

    // Boot-time replay of restart notices (new process). Non-blocking, so a
    // Telegram flood wait cannot hold the inbound gate.
    if (config.restartNotification && claimBootNotice()) {
      void (async () => {
        // Home-channel "online" ping — only when a restart was planned.
        const planned = readPlannedMarker()
        if (config.homeChannel && planned) {
          const target = config.homeChannel
          if (!planned.deliveredTargets.includes(target)) {
            try {
              await api.sendText(target, NOTICE.online)
              markPlannedDelivered(target)
              diag("restart_online_sent", token, { chat: target })
            } catch (e) {
              diag("restart_online_failed", token, { error: (e as Error)?.name ?? "unknown" })
            }
          }
          if (planned.deliveredTargets.includes(config.homeChannel)) clearPlannedMarker()
        }
        // Requester "restarted successfully" reply.
        const req = readRequesterMarker()
        if (req) {
          try {
            await api.sendText(req.chatId, NOTICE.restarted, req.messageId)
            clearRequesterMarker()
            diag("restarted_notice_sent", token, { chat: req.chatId })
          } catch (e) {
            // Keep the marker on failure so it can be replayed later.
            diag("restarted_notice_failed", token, { error: (e as Error)?.name ?? "unknown" })
          }
        }
      })().finally(() => {
        // Release the claim so a future restart can claim again. Notice
        // dedup is already handled by the markers (deliveredTargets/cleared).
        releaseBootNotice()
      })
    }

    /** Build the model catalog and send the first provider page. */
    const openModelPicker = async (chatId: string, userId: string, sessionKey: string, replyTo?: number) => {
      try {
        const raw = await ctx.model.list()
        const models: PickerModel[] = (Array.isArray(raw) ? raw : (raw as any)?.data ?? []).map((m: any) => ({
          id: m.modelID ?? m.id ?? "?",
          name: m.name,
          providerID: m.providerID ?? m.provider?.id ?? "unknown",
        }))
        if (!models.length) {
          await deliver(chatId, "No models are available from configured providers.")
          return
        }
        const providers = groupProviders(models)
        const sessionID = await sessions.current(sessionKey)
        if (!sessionID) {
          await deliver(chatId, "No active session yet — send a message first, then try /models.")
          return
        }
        const defaultRaw = await ctx.model.default()
        const d = (defaultRaw as any)?.data ?? defaultRaw
        const current = d ? `${d.providerID ?? "?"}/${d.modelID ?? d.id ?? "?"}` : "unknown"
        const state: PickerState = {
          msgId: 0, chatId, sessionKey, sessionID, ownerId: userId,
          adminIds: config.adminUsers, level: "providers",
          providerPage: 0, modelPage: 0, providers,
        }
        const msgId = await api.sendText(chatId, providerText(state, current), replyTo, undefined, undefined, providerKeyboard(state))
        state.msgId = msgId
        pickerState.set(chatId, state)
        diag("picker_open", token, { chat: chatId, providers: providers.length })
      } catch (e) {
        diag("picker_error", token, { chat: chatId, error: (e as Error)?.name ?? "unknown" })
        await deliver(chatId, "Could not open the model picker. Try again in a moment.")
      }
    }

    /** Handle a picker callback tap. Returns true if handled. */
    const handlePickerCallback = async (q: any, data: string): Promise<boolean> => {
      const chatId = String(q.message?.chat?.id ?? "")
      const userId = String(q.from?.id ?? "")
      const tappedId = q.message?.message_id
      const state = pickerState.get(chatId)
      // Only known picker callbacks are handled here.
      if (!/^(mp:|mpv:|mg:|mm:|mb$|mx)/.test(data)) return false
      await api.answerCallback(q.id)
      if (!state) {
        await api.answerCallback(q.id, "Picker expired — use /model again").catch(() => {})
        return true
      }
      // Bind to the exact message and opener/admin authority.
      if (String(tappedId) !== String(state.msgId)) {
        await api.answerCallback(q.id, "Picker expired — use /model again").catch(() => {})
        return true
      }
      const isOwner = userId === state.ownerId
      const isAdmin = state.adminIds.has(userId)
      if ((!isOwner && !isAdmin) || (q.from?.is_bot)) {
        await api.answerCallback(q.id, "Only the person who opened this picker can use it.").catch(() => {})
        return true
      }

      if (data === "mx") {
        pickerState.delete(chatId)
        await api.editText(chatId, state.msgId, "Cancelled.", undefined, undefined, { inline_keyboard: [] }).catch(() => {})
        return true
      }
      if (data === "mx:noop") return true
      if (data === "mb") {
        state.level = "providers"
        await api.editText(chatId, state.msgId, providerText(state, "see above"), undefined, undefined, providerKeyboard(state))
        return true
      }
      if (data.startsWith("mpv:")) {
        state.providerPage = Number(data.slice(4)) || 0
        state.level = "providers"
        await api.editText(chatId, state.msgId, providerText(state, "see above"), undefined, undefined, providerKeyboard(state))
        return true
      }
      if (data.startsWith("mg:")) {
        state.modelPage = Number(data.slice(3)) || 0
        await api.editText(chatId, state.msgId, modelText(state), undefined, undefined, modelKeyboard(state))
        return true
      }
      if (data.startsWith("mp:")) {
        const slug = data.slice(3)
        const provider = state.providers.find((p) => p.slug === slug)
        if (!provider) { await api.answerCallback(q.id, "Provider not found").catch(() => {}); return true }
        state.provider = provider
        state.level = "models"
        state.modelPage = 0
        await api.editText(chatId, state.msgId, modelText(state), undefined, undefined, modelKeyboard(state))
        return true
      }
      if (data.startsWith("mm:")) {
        const idx = Number(data.slice(3))
        const model = modelAt(state, idx)
        if (!model) { await api.answerCallback(q.id, "Model not found").catch(() => {}); return true }
        try {
          await ctx.session.switchModel({ sessionID: state.sessionID, model: { providerID: model.providerID, id: model.id } })
          pickerState.delete(chatId)
          await api.editText(chatId, state.msgId, `Model switched to ${model.providerID}/${model.id}.`, undefined, undefined, { inline_keyboard: [] })
          diag("picker_switched", token, { chat: chatId, model: model.id })
        } catch (e) {
          await api.answerCallback(q.id, "Could not switch model").catch(() => {})
          diag("picker_switch_failed", token, { chat: chatId, error: (e as Error)?.name ?? "unknown", detail: safeError(e, token) })
        }
        return true
      }
      return true
    }

    /** Resolve a question/form by sending answers via the location-scoped API. */
    const resolveQuestion = async (qid: string, answers: Record<string, unknown>, actorId: string): Promise<void> => {
      const st = questions.get(qid)
      if (!st || st.resolved) return
      if (actorId !== st.ownerId && !st.adminIds.has(actorId)) {
        await api.answerCallback(qid, "Only the person who triggered this can answer.").catch(() => {})
        return
      }
      st.resolved = true
      questions.delete(qid)
      if (typingAnswer.get(st.chatId)?.id === qid) typingAnswer.delete(st.chatId)
      const ok = await httpFormReply(st.sessionID, st.formID, answers, st.location?.directory)
      if (ok) {
        await api.editText(st.chatId, st.messageId, "Answer sent.", undefined, undefined, { inline_keyboard: [] }).catch(() => {})
        diag("question_answered", token, { session: st.sessionID })
      } else {
        diag("question_reply_failed", token, { session: st.sessionID })
      }
    }

    /** Fail-closed timeout: always reject, no authorization gate. */
    const timeoutApproval = async (id: string): Promise<void> => {
      const state = approvals.get(id)
      if (!state || state.resolved) return
      state.resolved = true
      if (state.timer) clearTimeout(state.timer)
      approvals.delete(id)
      try {
        const ok = await httpPermissionReply(state.sessionID, state.requestID, "reject", state.location?.directory)
        if (!ok) {
          await ctx.permission.reply({
            sessionID: state.sessionID, requestID: state.requestID, decision: "reject",
            ...(state.location?.directory ? { location: state.location } : {}),
          } as any)
        }
        await api.editText(
          state.chatId, state.messageId,
          "⏱️ Approval timed out after 5 minutes — command did NOT run.",
          undefined, undefined, { inline_keyboard: [] },
        ).catch(() => {})
        diag("approval_timeout_denied", token, { session: state.sessionID })
      } catch (e) {
        diag("approval_timeout_error", token, { error: (e as Error)?.name ?? "unknown" })
      }
    }

    /** Resolve a pending approval via OpenCode's permission API, then edit the card. */
    const resolveApproval = async (id: string, choice: ApprovalChoice, actorId: string): Promise<boolean> => {
      const state = approvals.get(id)
      if (!state || state.resolved) return false
      // Authorize: allowlist already checked at dispatch; enforce opener/admin here.
      if (actorId !== state.ownerId && !state.adminIds.has(actorId)) {
        await api.answerCallback(id, "Only the person who triggered this can approve.").catch(() => {})
        return false
      }
      state.resolved = true
      if (state.timer) clearTimeout(state.timer)
      approvals.delete(id)
      try {
        const ok = await httpPermissionReply(
          state.sessionID, state.requestID, decisionFor(choice), state.location?.directory,
        )
        if (!ok) {
          await ctx.permission.reply({
            sessionID: state.sessionID, requestID: state.requestID, decision: decisionFor(choice),
            ...(state.location?.directory ? { location: state.location } : {}),
          } as any)
        }
        await api.editText(
          state.chatId, state.messageId,
          `${choice === "deny" ? "Denied" : "Approved"} by ${actorId} — command ${choice === "deny" ? "did NOT run" : "will run"}.`,
          undefined, undefined, { inline_keyboard: [] },
        ).catch(() => {})
        diag("approval_resolved", token, { choice, session: state.sessionID })
        return true
      } catch (e) {
        diag("approval_error", token, { choice, error: (e as Error)?.name ?? "unknown", detail: safeError(e, token) })
        // Fail closed: try to reject so the command never runs.
        try {
          if (!await httpPermissionReply(state.sessionID, state.requestID, "reject", state.location?.directory)) {
            await ctx.permission.reply({
              sessionID: state.sessionID, requestID: state.requestID, decision: "reject",
              ...(state.location?.directory ? { location: state.location } : {}),
            } as any)
          }
        } catch { /* best effort */ }
        return false
      }
    }

    /** Subscribe to OpenCode permission requests and render Telegram cards. */
    const startApprovalListener = (): (() => void) => {
      if (!config.approvalsEnabled) return () => {}
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ types: ["permission.asked", "permission.replied", "form.created", "form.replied", "form.cancelled"], signal: controller.signal })) {
            const ev = event as any

            // ── Question tool (session forms) ──────────────────────────────
            if (ev.type === "form.created" || ev.type === "form.replied" || ev.type === "form.cancelled") {
              const fd = ev.data ?? {}
              const formID = fd.id ?? fd.form?.id
              const sid = fd.sessionID ?? fd.form?.sessionID
              if (ev.type !== "form.created") {
                for (const [qid, st] of questions) {
                  if (st.sessionID === sid && st.formID === formID) {
                    st.resolved = true
                    questions.delete(qid)
                    if (typingAnswer.get(st.chatId)?.id === qid) typingAnswer.delete(st.chatId)
                  }
                }
                continue
              }
              const owner = sessionOwner.get(sid)
              if (!owner) continue // not a Telegram-driven session
              const form: FormInfo = fd.form
              if (!form?.fields?.length) continue
              const qid = newApprovalId()
              const state: QuestionState = {
                id: qid, sessionID: sid, formID: form.id, chatId: owner.chatId,
                ownerId: owner.ownerId, adminIds: config.adminUsers, messageId: 0,
                form, location: ev.location ?? undefined, answers: {}, resolved: false,
              }
              try {
                state.messageId = await api.sendText(
                  owner.chatId, questionText(state), undefined, "HTML", undefined, questionKeyboard(state),
                )
                questions.set(qid, state)
                diag("question_card", token, { session: sid, fields: form.fields.length })
              } catch (e) {
                diag("question_send_failed", token, { error: (e as Error)?.name ?? "unknown" })
                try { await httpFormCancel(sid, form.id, ev.location?.directory) } catch { /* best effort */ }
              }
              continue
            }

            if (ev.type === "permission.replied" || ev.type === "permission.asked") {
              const d = ev.data ?? {}
              if (ev.type === "permission.replied") {
                // Answered elsewhere (e.g. TUI) — drop our card state.
                for (const [id, st] of approvals) {
                  if (st.sessionID === d.sessionID && st.requestID === d.requestID) {
                    st.resolved = true
                    if (st.timer) clearTimeout(st.timer)
                    approvals.delete(id)
                  }
                }
                continue
              }
              const owner = sessionOwner.get(d.sessionID)
              if (!owner) continue // not a Telegram-driven session
              const command = (d.resources ?? []).join(" ") || d.message || ""
              const id = newApprovalId()
              const state: ApprovalState = {
                id, sessionID: d.sessionID, requestID: d.id,
                chatId: owner.chatId, ownerId: owner.ownerId, adminIds: config.adminUsers,
                messageId: 0, canApprove: false, action: d.action ?? "tool", command,
                location: ev.location ?? undefined, resolved: false,
              }
              // Whole-command proof: show it in the card if it fits; otherwise
              // send a document first and only then enable Approve.
              // Pull the agent's own last message so the "why" is part of the
              // card, not a separate text arriving after the approval request.
              let contextText: string | undefined
              try {
                const msgs = await ctx.session.context({ sessionID: d.sessionID })
                contextText = extractAssistantText(msgs) || undefined
              } catch { /* best effort */ }
              const text = approvalText(state, contextText)
              if (new TextEncoder().encode(text).byteLength <= config.maxTextChars) {
                state.canApprove = true
              }
              const kb = { inline_keyboard: [approvalChoices(state.canApprove).map((c) => ({
                text: c === "once" ? "✅ Allow Once" : c === "always" ? "✅ Always" : "🚫 Deny",
                callback_data: `ea:${c}:${id}`,
              }))] }
              try {
                state.messageId = await api.sendText(owner.chatId, text, undefined, "HTML", undefined, kb)
                approvals.set(id, state)
                diag("approval_card", token, { session: d.sessionID, canApprove: state.canApprove })
                state.timer = setTimeout(() => { void timeoutApproval(id) }, approvalTimerMs)
                state.timer.unref?.()
              } catch (e) {
                diag("approval_send_failed", token, { error: (e as Error)?.name ?? "unknown" })
                // Fail closed: reject so the command never runs.
                try { await ctx.permission.reply({ sessionID: d.sessionID, requestID: d.id, decision: "reject", ...(ev.location?.directory ? { location: ev.location } : {}) } as any) } catch { /* best effort */ }
              }
            }
          }
        } catch (e: any) {
          if (!controller.signal.aborted) diag("approval_listener_error", token, { error: e?.name ?? "unknown" })
        }
      })()
      return () => controller.abort()
    }
    let stopApprovals = startApprovalListener()

    const handleUpdate: (u: Update) => Promise<void> = async (update) => {
      // Inline-keyboard callback taps (model picker). Authorize before acting.
      if (update.callback_query) {
        const q = update.callback_query
        const uid = String(q.from?.id ?? "")
        const chatId = String(q.message?.chat?.id ?? "")
        if (q.from?.is_bot || !uid || !chatId || !config.allowedUsers.has(uid)) {
          await api.answerCallback(q.id, "Not authorized.").catch(() => {})
          return
        }
        try {
          const data = q.data ?? ""
          if (data.startsWith("qf:")) {
            // qf:<questionId>:<fieldIndex|cancel>:<optionIndex|other>
            const parts = data.split(":")
            const qid = parts[1]
            const st = questions.get(qid)
            if (!st || st.resolved) {
              await api.answerCallback(q.id, "Question expired — ask again").catch(() => {})
              return
            }
            if (String(q.message?.message_id) !== String(st.messageId)) {
              await api.answerCallback(q.id, "Question expired — ask again").catch(() => {})
              return
            }
            if ((uid !== st.ownerId && !st.adminIds.has(uid)) || q.from?.is_bot) {
              await api.answerCallback(q.id, "Only the person who triggered this can answer.").catch(() => {})
              return
            }
            await api.answerCallback(q.id)
            if (parts[2] === "cancel") {
              st.resolved = true
              questions.delete(qid)
              if (typingAnswer.get(st.chatId)?.id === qid) typingAnswer.delete(st.chatId)
              await httpFormCancel(st.sessionID, st.formID, st.location?.directory)
              await api.editText(st.chatId, st.messageId, "Question cancelled.", undefined, undefined, { inline_keyboard: [] }).catch(() => {})
              return
            }
            const fieldIndex = Number(parts[2])
            const choice = parts[3]
            if (choice === "other") {
              // Capture the next typed message as this field's answer.
              typingAnswer.set(st.chatId, st)
              await api.editText(st.chatId, st.messageId, `Type your answer for: ${st.form.fields[fieldIndex]?.key ?? ""}`, undefined, undefined, { inline_keyboard: [] }).catch(() => {})
              return
            }
            const opt = optionAt(st, fieldIndex, Number(choice))
            if (!opt) { await api.answerCallback(q.id, "Option not found").catch(() => {}); return }
            applyTyped(st, fieldIndex, opt.value)
            await resolveQuestion(qid, st.answers, uid)
          } else if (data.startsWith("ea:")) {
            // ea:<choice>:<id> — approval card tap.
            const parts = data.split(":")
            const choice = parts[1] as ApprovalChoice
            const id = parts[2]
            await api.answerCallback(q.id)
            const st = approvals.get(id)
            if (!st || st.resolved) {
              await api.answerCallback(q.id, "Already resolved or expired").catch(() => {})
              return
            }
            if (String(q.message?.message_id) !== String(st.messageId)) {
              await api.answerCallback(q.id, "Approval expired — try again").catch(() => {})
              return
            }
            if (!["once", "always", "deny"].includes(choice)) return
            if (!st.canApprove && choice !== "deny") {
              await api.answerCallback(q.id, "Full command not confirmed — deny only").catch(() => {})
              return
            }
            await resolveApproval(id, choice, uid)
          } else {
            await handlePickerCallback(q, data)
          }
        } catch (e) {
          diag("callback_error", token, { user: uid, error: (e as Error)?.name ?? "unknown" })
          await api.answerCallback(q.id).catch(() => {})
        }
        return
      }

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

      // Group trigger gates (WHEN to answer), separate from authorization.
      if (update.message) {
        const gate = shouldProcess(msg, me.username, config)
        if (!gate.process) {
          diag("gate_skip", token, { chat: chatId, reason: gate.reason })
          return
        }
      }

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
      const sessionKey = sessionKeyFor(msg, config, userId)
      const sessionTitle = sessionLabel(msg, sessionKey)

      // Typed answer to a question ("Other" was tapped) — capture before the
      // message becomes an agent turn.
      const awaiting = typingAnswer.get(chatId)
      if (awaiting && !awaiting.resolved && text) {
        if (userId !== awaiting.ownerId && !awaiting.adminIds.has(userId)) {
          await deliver(chatId, "Only the person who asked can answer.", msg.message_id)
          return
        }
        const f = awaiting.form.fields[0]
        await resolveQuestion(awaiting.id, { [f.key]: text }, userId)
        return
      }

      // Typed /approve|/deny, or bare yes/no — only while an approval is pending.
      const pendingForChat = [...approvals.values()].find((s) => !s.resolved && s.chatId === chatId)
      if (text.startsWith("/approve") || text.startsWith("/deny")) {
        if (!pendingForChat) {
          await deliver(chatId, "No pending approval.", msg.message_id)
          return
        }
        const choice: ApprovalChoice = text.startsWith("/deny")
          ? "deny"
          : /always/i.test(text) ? "always" : "once"
        await resolveApproval(pendingForChat.id, choice, userId)
        return
      }
      if (pendingForChat) {
        const word = approvalWord(text)
        if (word) {
          await resolveApproval(pendingForChat.id, word, userId)
          return
        }
      }

      // Slash commands: authorized user, THEN a separate command-ACL check.
      // Never let a command reach the agent as a prompt.
      const cmd = parseCommand(text === "/start" ? "/help" : text, me.username)
      if (cmd) {
        if (!commandAllowed(cmd.name, userId, config)) {
          diag("command_denied", token, { user: userId, command: cmd.name })
          await deliver(chatId, "You are not allowed to run that command.", msg.message_id)
          return
        }
        diag("command", token, { user: userId, command: cmd.name })
        // /models opens an inline picker (bare /model shows the current model).
        if (cmd.name === "models") {
          await openModelPicker(chatId, userId, sessionKey, msg.message_id)
          return
        }
        if (cmd.name === "restart") {
          // Pre-restart notice: active chats + home channel, sent by THIS
          // process while the adapter is alive. Then write durable markers
          // and trigger a service restart in a detached child.
          await deliver(chatId, NOTICE.preRestart, msg.message_id)
          if (config.homeChannel && config.homeChannel !== chatId) {
            await api.sendText(config.homeChannel, NOTICE.preRestart).catch(() => {})
          }
          writeRequesterMarker({ chatId, userId, sessionKey, messageId: msg.message_id })
          writePlannedMarker()
          diag("restart_requested", token, { chat: chatId, user: userId })
          // Detached spawn so the child survives this process exiting.
          void (async () => {
            try {
              const { spawn } = await import("node:child_process")
              const child = spawn("opencode", ["service", "restart"], {
                detached: true, stdio: "ignore", shell: true,
              })
              child.unref?.()
            } catch (e) {
              diag("restart_spawn_failed", token, { error: (e as Error)?.name ?? "unknown" })
            }
          })()
          return
        }
        if (cmd.name === "sethome") {
          const target = cmd.arg.trim() || chatId
          // Update the 0600 env file in place (no echo of secrets).
          try {
            const fs = await import("node:fs")
            const path = `${process.env.HOME || ""}/.config/opencode/telegram-gateway.env`
            let text = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : ""
            const re = /^TELEGRAM_HOME_CHANNEL=.*$/m
            if (re.test(text)) text = text.replace(re, `TELEGRAM_HOME_CHANNEL=${target}`)
            else text += `\nTELEGRAM_HOME_CHANNEL=${target}\n`
            fs.writeFileSync(path, text, { mode: 0o600 })
            config.homeChannel = target
            await deliver(chatId, `Home channel set to ${target}. Run /restart to apply it to boot notices.`, msg.message_id)
            diag("sethome", token, { chat: target })
          } catch (e) {
            await deliver(chatId, `Could not set home channel: ${safeError(e, token)}`, msg.message_id)
          }
          return
        }
        try {
          const reply = await runCommand(cmd, {
            ctx, config, sessions, userId, chatId, sessionKey, botId: me.id, title: sessionTitle,
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
            // Stickers (and optionally images) can be described by the vision
            // provider; the description is cached by file_unique_id.
            const uniqueId = item.label === "sticker" ? msg.sticker?.file_unique_id : undefined
            const wantsVision = vision && (item.label === "sticker" || visionConfig()?.images)
            const description = wantsVision ? await vision!.describe(cached.path, uniqueId, msg.sticker?.emoji) : null
            if (description) {
              notes.push(`[Sticker: ${description}]`)
              diag("vision_note", token, { kind: cached.kind })
            } else {
              files.push(attachmentFor(cached, mediaNote(cached)))
            }
            if (cached.kind === "binary" || cached.kind === "audio" || cached.kind === "video") notes.push(mediaNote(cached))
          }
        }
      }

      if (!text && files.length === 0 && notes.length === 0) {
        await deliver(chatId, "I only understand text and media attachments.", msg.message_id)
        return
      }

      const sessionID = await sessions.getOrCreate(sessionKey, sessionTitle)
      sessionOwner.set(sessionID, { chatId, ownerId: userId })

      // Quick polish: 👀 reaction acknowledges the message immediately.
      if (config.reactions) void api.setReaction(chatId, msg.message_id, "👀")

      // Serialize turns per session: only one prompt in flight at a time,
      // so two close-together messages cannot both read the same last answer.
      await turnQueue.run(sessionID, async () => {
        // Typing indicator only while THIS turn is actually running.
        let typingTimer: ReturnType<typeof setInterval> | undefined
        if (config.typingIndicator) {
          void api.setTyping(chatId)
          typingTimer = setInterval(() => void api.setTyping(chatId), 3_000)
          typingTimer.unref?.()
        }
        let previewId: number | undefined
        if (config.streaming && !config.richMessages) {
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
          if (typingTimer) clearInterval(typingTimer)
          typingTimer = undefined
          await deliver(chatId, final, msg.message_id, previewId)
          if (config.reactions) void api.setReaction(chatId, msg.message_id, "👍")
          diag("reply", token, { update: update.update_id, chat: chatId })
          console.info(`[telegram-gateway] replied in chat ${chatId} via session ${redact(sessionID, token)}`)
        } catch (e) {
          if (typingTimer) clearInterval(typingTimer)
          typingTimer = undefined
          if (config.reactions) void api.setReaction(chatId, msg.message_id, "👎")
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
          if (typingTimer) clearInterval(typingTimer)
          active.delete(sessionID)
        }
      });
    }

    // Batch client-split text / photo bursts before they reach the agent.
    const batcher = new InboundBatcher(handleUpdate, config.textBatchMs, config.mediaBatchMs, token)
    const admit: (u: Update) => Promise<void> = async (u) => {
      if (!batcher.feed(u)) await handleUpdate(u)
    }

    let stopTransport: () => void = () => {}
    let supervisor: PollingSupervisor | null = null
    let lock: PollerLock | null = null
    if (config.webhookUrl) {
      stopTransport = await startWebhook(config, api, admit)
    } else {
      // Telegram allows only one getUpdates poller per token. A global plugin
      // loads in every OpenCode location, so elect a single owner.
      const startPollingHere = (owner: PollerLock) => {
        diag("poll_start", token)
        supervisor = new PollingSupervisor(api, token, admit, controller.signal, () => owner.isOwner(), {
          onProgress: () => owner.refresh(),
          onFatal: (reason) => {
            diag("polling_fatal", token, { reason })
            lock?.release()
            lock = null
          },
        })
        supervisor.start()
        console.info("[telegram-gateway] polling started (with watchdog)")
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
      // Note: an externally-initiated `opencode service stop` cannot reliably
      // deliver a Telegram message — the process is torn down before a
      // fire-and-forget HTTP call can finish. Hermes can do it only because it
      // owns its shutdown/drain sequence. The /restart warning (sent before
      // respawn) and the boot-time notices are reliable; a plain-stop warning
      // is intentionally not attempted. Any clean shutdown still writes a
      // planned marker so a CLI restart produces the ♻️ online ping on boot.
      if (config.restartNotification && !readPlannedMarker()) writePlannedMarker()
      if (config.statusIndicator) {
        void api.setShortDescription("Offline").catch(() => {})
      }
      batcher.close()
      stopApprovals()
      for (const st of approvals.values()) if (st.timer) clearTimeout(st.timer)
      approvals.clear()
      stopTransport()
      supervisor?.stop()
      stopStreaming()
      lock?.release()
      active.clear()
    }
  },
}
