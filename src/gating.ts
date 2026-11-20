/**
 * Group trigger gates: decide WHEN to answer (authorization is separate).
 *
 * Order (mirrors Hermes' _should_process_message):
 *  1. Ignore bots and ignored threads/topics.
 *  2. allowed_chats / allowed_topics whitelist (missing thread id = General "1").
 *  3. exclusive_bot_mentions: a leading @otherbot silences this bot.
 *  4. require_mention: need @thisbot or a reply to the bot (unless free-response).
 *  5. guest_mode: outside allowed chats, respond only to explicit @mention.
 *
 * These are TRIGGER gates, not authorization — a group member still has to
 * pass the allowlist before reaching a session.
 */
import type { GatewayConfig } from "./config.js"
import type { TelegramMessage } from "./telegram.js"

export type GateResult = { process: boolean; reason: string }

function threadId(msg: TelegramMessage): string | null {
  const raw = (msg as any).message_thread_id
  return raw === undefined || raw === null ? null : String(raw)
}

/** Bot username from getMe (without leading @), for mention matching. */
export function shouldProcess(
  msg: TelegramMessage,
  botUsername: string | undefined,
  config: GatewayConfig,
): GateResult {
  if (msg.from?.is_bot) return { process: false, reason: "bot" }
  const chatId = String(msg.chat?.id ?? "")
  const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup"
  if (!isGroup) return { process: true, reason: "dm" }

  const tid = threadId(msg)
  const topics = config.allowedTopics
  if (tid && config.ignoredThreads.has(tid)) return { process: false, reason: "ignored_thread" }
  if (topics.size && (!tid || !topics.has(tid))) return { process: false, reason: "topic_not_allowed" }

  const inAllowedChat = config.allowedChats.size === 0 || config.allowedChats.has(chatId)
  if (!inAllowedChat && !config.guestMode) return { process: false, reason: "chat_not_allowed" }

  const text = msg.text ?? msg.caption ?? ""
  const bot = (botUsername ?? "").replace(/^@/, "").toLowerCase()
  const mentioned = !!bot && new RegExp(`@${escapeRegex(bot)}\\b`, "i").test(text)
  const leadingOtherBot = config.exclusiveBotMentions && /^\s*@([A-Za-z0-9_]+)/.test(text)
    && !new RegExp(`^\\s*@${escapeRegex(bot)}\\b`, "i").test(text)
  if (leadingOtherBot) return { process: false, reason: "other_bot_mentioned" }

  const free = config.freeResponseChats.has(chatId)
  const repliedToBot = (msg as any).reply_to_message?.from?.is_bot === true

  if (config.requireMention && !free && !mentioned && !repliedToBot) {
    return { process: false, reason: "mention_required" }
  }
  if (!inAllowedChat && config.guestMode && !mentioned) {
    return { process: false, reason: "guest_requires_mention" }
  }
  return { process: true, reason: "ok" }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
