/**
 * Session routing: derive a stable key from a message's chat / user / topic.
 *
 * Mirrors Hermes' build_session_key semantics:
 *  - DMs: one session per chat (chat_id == user_id). DM threads are isolated
 *    per thread by default, or collapsed when dmThreads="shared".
 *  - Groups: per-user sessions by default (groupSessionsPerUser=true) —
 *    key `chatId:u:userId`.
 *  - Forum topics: SHARED across members by default (threadSessionsPerUser=false)
 *    — key `chatId:t:threadId`. Set threadSessionsPerUser=true to append the
 *    user: `chatId:t:threadId:u:userId`.
 *
 * The key is used only as the plugin-storage key (`tg:session:<key>`); the
 * underlying OpenCode session is created lazily by SessionBridge.
 */
import type { GatewayConfig } from "./config.js"
import type { TelegramMessage } from "./telegram.js"

export function messageThreadId(msg: TelegramMessage): string | null {
  const raw = (msg as any).message_thread_id
  // A plain group reply may carry message_thread_id as a reply anchor, not a
  // topic. Only treat it as a topic for forum groups / topic messages / DMs.
  if (raw === undefined || raw === null) return null
  return String(raw)
}

export function sessionKeyFor(msg: TelegramMessage, config: GatewayConfig, userId: string): string {
  const chatId = String(msg.chat?.id ?? "")
  const chatType = msg.chat?.type ?? ""
  const tid = messageThreadId(msg)
  const isDm = chatType === "private"

  if (isDm) {
    if (tid && config.dmThreads === "per_thread") return `${chatId}:t:${tid}`
    return chatId
  }

  // Group / supergroup / channel.
  const isForum = msg.chat?.is_forum === true || chatType === "forum" || !!(msg as any).is_topic_message
  if (isForum && tid) {
    if (config.threadSessionsPerUser) return `${chatId}:t:${tid}:u:${userId}`
    return `${chatId}:t:${tid}`
  }
  if (config.groupSessionsPerUser) return `${chatId}:u:${userId}`
  return chatId
}

/** Human-readable label for a session (used in titles and /sessions output). */
export function sessionLabel(msg: TelegramMessage, key: string): string {
  const title = msg.chat?.title
  const base = title ? `${title}` : `Telegram ${msg.chat?.type ?? "chat"}`
  const thread = key.includes(":t:") ? ` topic ${key.split(":t:")[1].split(":")[0]}` : ""
  const user = key.includes(":u:") ? ` user ${key.split(":u:").pop()}` : ""
  return `${base}${thread}${user}`
}
