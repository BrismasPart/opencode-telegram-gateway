/**
 * Slash commands for authorized Telegram users.
 *
 * SECURITY — two independent checks:
 *   1. The caller must pass the gateway authorization chain (done in index.ts
 *      before this module is reached).
 *   2. Command permission is a SEPARATE axis. `/new`, `/stop`, `/setagent`,
 *      `/sessions`, `/resume` are admin-only when an admin list is configured. This is the
 *      fix for the Hermes W9 finding ("slash gating off by default").
 *
 * When no admin list is configured, gating is OFF and every authorized user
 * may run every command (documented backward-compatible default). Configure
 * `OPENCODE_TELEGRAM_ADMIN_USERS` to enable gating on a shared bot.
 */
import type { GatewayConfig } from "./config.js"
import type { SessionBridge } from "./sessions.js"
import { safeError } from "./redact.js"

export const ALWAYS_ALLOWED = new Set(["help", "whoami"])
/** Commands that change state or execution — admin-only when gating is on. */
export const ADMIN_COMMANDS = new Set(["new", "stop", "setagent", "sessions", "resume"])
export const USER_COMMANDS = new Set(["status", "models", "agents", "commands", "compact", "context", "effort", "approve", "deny"])

/**
 * Single source of truth for the client-facing surfaces: the `/` menu, the
 * inline picker, and /help. The /setagent alias resolves when typed but is
 * intentionally NOT advertised, mirroring the Hermes registry behavior.
 */
export type CommandDef = {
  name: string
  description: string
  /** Menu/picker priority tier (lower = earlier). Unranked entries keep collection order. */
  priority?: number
}

export const COMMAND_CATALOG: CommandDef[] = [
  { name: "help", description: "Show available commands", priority: 0 },
  { name: "new", description: "Start a fresh session", priority: 1 },
  { name: "stop", description: "Interrupt the current turn", priority: 2 },
  { name: "status", description: "Gateway status and your role", priority: 3 },
  { name: "models", description: "Open the model picker", priority: 4 },
  { name: "commands", description: "List OpenCode commands" },
  { name: "context", description: "Context window and token usage" },
  { name: "effort", description: "Show or change reasoning effort" },
  { name: "compact", description: "Compact the current session" },
  { name: "whoami", description: "Your Telegram ID and role" },
  { name: "agent", description: "Switch agent for this session" },
  { name: "agents", description: "List available agents" },
  { name: "sessions", description: "List sessions; 'all', 'search <q>' (admin only)" },
  { name: "resume", description: "Resume a session by id or list index (admin only)" },
]

export interface CommandEnv {
  ctx: any
  config: GatewayConfig
  sessions: SessionBridge
  userId: string
  chatId: string
  /** Routing key for this chat/user/topic (drives session isolation). */
  sessionKey: string
  botId: number
  title: string
}

export interface ParsedCommand {
  name: string
  arg: string
}

/** Parse "/cmd arg" and "/cmd@BotName arg". Returns null for plain text. */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  let trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  // Telegram group commands may carry an @botname mention attached to the
  // command token (/model@Bot x) OR as a separate token before/after the
  // arguments (/model @Bot x, /model x @Bot). Strip it everywhere so it never
  // leaks into the argument (e.g. being parsed as part of a model name).
  if (botUsername) {
    const bot = botUsername.replace(/^@/, "").toLowerCase()
    const esc = bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    trimmed = trimmed.replace(new RegExp(`@${esc}\\b`, "gi"), "").replace(/\s+/g, " ").trim()
  }
  // Also strip a generic attached @suffix on the command token (covers the
  // case where botUsername was not supplied).
  trimmed = trimmed.replace(/^(\/[a-zA-Z][a-zA-Z0-9_]*)@[A-Za-z0-9_]+/, "$1")

  const match = /^\/([a-zA-Z][a-zA-Z0-9_]*)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  return { name: match[1].toLowerCase(), arg: (match[2] ?? "").trim() }
}

/** Whether a given user may run a command, given the config's ACL. */
export function commandAllowed(name: string, userId: string, config: GatewayConfig): boolean {
  if (ALWAYS_ALLOWED.has(name)) return true
  if (config.adminUsers.size === 0) return true // gating off (documented default)
  if (config.adminUsers.has(userId)) return true
  if (ADMIN_COMMANDS.has(name)) return false
  return config.userCommands.has(name) || USER_COMMANDS.has(name)
}

/** List endpoints may return a bare array or an API envelope { data: [...] }. */
function unwrapList<T = any>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === "object" && Array.isArray((value as any).data)) {
    return (value as any).data as T[]
  }
  return []
}

const HELP_TEXT = "Commands:\n" + COMMAND_CATALOG.map((c) => `/${c.name} — ${c.description}`).join("\n")

/** Execute an allowed command. Returns the text to send back to Telegram. */
export async function runCommand(cmd: ParsedCommand, env: CommandEnv): Promise<string> {
  const { ctx, config, sessions, userId, chatId, sessionKey, botId, title } = env
  switch (cmd.name) {
    case "help":
      return HELP_TEXT

    case "whoami": {
      const admin = config.adminUsers.size === 0 || config.adminUsers.has(userId)
      return `Telegram user ID: ${userId}\nChat ID: ${chatId}\nRole: ${admin ? "admin" : "user"}`
    }

    case "status": {
      const sessionID = await sessions.current(sessionKey)
      const admin = config.adminUsers.size === 0 || config.adminUsers.has(userId)
      return [
        `Gateway status: connected to Telegram as bot ${botId}`,
        `Authorized users: ${config.allowedUsers.size}`,
        `Command gating: ${config.adminUsers.size ? "on" : "off"}`,
        `Your role: ${admin ? "admin" : "user"}`,
        `Session: ${sessionID ? "active" : "none"}`,
      ].join("\n")
    }

    case "sessions": {
      // Admin-only via ADMIN_COMMANDS + commandAllowed().
      //   /sessions            → Telegram-bound sessions
      //   /sessions all        → every OpenCode session
      //   /sessions search <q> → sessions matching a query
      // Stores a numbered index so `/resume <n>` can select by position.
      const mode = cmd.arg.split(/\s+/)[0]?.toLowerCase() ?? ""
      const query = mode === "search" ? cmd.arg.slice(cmd.arg.toLowerCase().indexOf("search") + 6).trim() : ""
      const INDEX_KEY = `tg:sessions:index:${chatId}`
      try {
        let rows: Array<{ id: string; title: string; chatId?: string; model?: string; tokens?: number; current?: boolean }> = []

        if (mode === "all" || mode === "search") {
          const all = await sessions.list(mode === "search" && query ? { search: query, limit: 50 } : { limit: 50 })
          const currentId = await sessions.current(sessionKey)
          rows = all.map((info: any) => {
            const t = info?.tokens ?? {}
            return {
              id: info.id,
              title: info.title ?? "(untitled)",
              model: info.model ? `${info.model.providerID ?? "?"}/${info.model.modelID ?? info.model.id ?? "?"}` : "?",
              tokens: Number(t.input ?? 0) + Number(t.output ?? 0) + Number(t.cache?.read ?? 0),
              current: info.id === currentId,
            }
          })
        } else {
          // Bound Telegram sessions from durable storage.
          const entries: Array<{ chatId: string; sessionID: string }> = []
          let cursor: string | undefined
          do {
            const page = await ctx.storage.scan({ prefix: "tg:session:", limit: 100, ...(cursor ? { after: cursor } : {}) })
            for (const entry of page.entries ?? []) {
              const c = String(entry.key).slice("tg:session:".length)
              entries.push({ chatId: c, sessionID: String(entry.value) })
            }
            cursor = page.next
          } while (cursor)
          const currentId = await sessions.current(sessionKey)
          for (const { chatId: c, sessionID } of entries) {
            try {
              const raw = await ctx.session.get({ sessionID })
              const info: any = (raw as any)?.data ?? raw
              const t = info?.tokens ?? {}
              rows.push({
                id: sessionID,
                title: info?.title ?? "(untitled)",
                chatId: c,
                tokens: Number(t.input ?? 0) + Number(t.output ?? 0) + Number(t.cache?.read ?? 0),
                current: sessionID === currentId,
              })
            } catch {
              rows.push({ id: sessionID, title: "(session no longer available)", chatId: c })
            }
          }
        }

        if (!rows.length) return mode === "search" ? `No sessions match "${query}".` : "No sessions found."

        const shown = rows.slice(0, 30)
        await ctx.storage.set(INDEX_KEY, shown.map((r) => r.id))
        const lines: string[] = [
          `${mode === "all" ? "All" : mode === "search" ? `Search "${query}"` : "Telegram"} sessions (${rows.length}):`,
        ]
        shown.forEach((r, i) => {
          const suffix = `${r.chatId ? ` | key ${r.chatId}` : ""}${r.model ? ` | ${r.model}` : ""}${r.tokens ? ` | ~${r.tokens >= 1000 ? `${(r.tokens / 1000).toFixed(1)}k` : r.tokens} tok` : ""}${r.current ? " | ← current" : ""}`
          lines.push(`${i + 1}. ${r.id} | ${r.title}${suffix}`)
        })
        if (rows.length > shown.length) lines.push(`…and ${rows.length - shown.length} more`)
        lines.push("Resume with /resume <number> or /resume <session_id>")
        return lines.join("\n")
      } catch (e) {
        return `Could not list sessions: ${safeError(e, config.token)}`
      }
    }

    case "resume": {
      // Admin-only. Resume by full/partial session id or by index from the
      // last /sessions listing. Rebinds this chat to the chosen session.
      const target = cmd.arg.trim()
      if (!target) return "Usage: /resume <session_id> or /resume <number> (from /sessions)"
      try {
        const INDEX_KEY = `tg:sessions:index:${chatId}`
        let sessionID = target
        if (/^\d+$/.test(target)) {
          const index = await ctx.storage.get<string[]>(INDEX_KEY)
          const n = Number(target)
          if (!index || n < 1 || n > index.length) {
            return `Invalid index ${target}. Run /sessions first, then /resume <number>.`
          }
          sessionID = index[n - 1]
        }
        const ok = await sessions.bind(sessionKey, sessionID)
        if (!ok) return `Session ${sessionID} not found.`
        return `Resumed session ${sessionID}. Your next message continues that conversation.`
      } catch (e) {
        return `Could not resume session: ${safeError(e, config.token)}`
      }
    }

    case "new": {
      await sessions.rotate(sessionKey, title)
      return "Started a fresh session. Your next message begins a new conversation."
    }

    case "stop": {
      const sessionID = await sessions.current(sessionKey)
      if (!sessionID) return "No active turn to interrupt."
      await sessions.interrupt(sessionID)
      return "Interrupted the current turn. The session is preserved."
    }

    case "models": {
      try {
        const models = unwrapList(await ctx.model.list())
        const list = models.slice(0, 30).map((m: any) => {
          const provider = m.providerID ?? m.provider?.id ?? "?"
          const id = m.modelID ?? m.id ?? "?"
          return `${provider}/${id}${m.name && m.name !== id ? ` — ${m.name}` : ""}`
        })
        return list.length ? `Models:\n${list.join("\n")}` : "No models available."
      } catch (e) {
        return `Could not list models: ${safeError(e, config.token)}`
      }
    }

    case "agent": {
      if (!cmd.arg) return "Usage: /agent <name> (see /agents)"
      try {
        const sessionID = await sessions.getOrCreate(sessionKey, title)
        await ctx.session.switchAgent({ sessionID, agent: cmd.arg })
        return `Agent switched to ${cmd.arg} for this session.`
      } catch (e) {
        return `Could not switch agent: ${safeError(e, config.token)}`
      }
    }

    case "agents": {
      try {
        const agents = unwrapList(await ctx.agent.list())
        const list = agents.map((a: any) => a.id ?? a.name ?? "?")
        return list.length ? `Agents:\n${list.join("\n")}` : "No agents available."
      } catch (e) {
        return `Could not list agents: ${safeError(e, config.token)}`
      }
    }

    case "commands": {
      try {
        const commands = unwrapList(await ctx.command.list())
        const list = commands.map((c: any) => `/${c.name}`)
        return list.length ? `OpenCode commands:\n${list.join("\n")}` : "No OpenCode commands available."
      } catch (e) {
        return `Could not list commands: ${safeError(e, config.token)}`
      }
    }

    case "context": {
      try {
        const sessionRaw = await ctx.session.get({ sessionID: await sessions.current(sessionKey) ?? "" })
        const info: any = (sessionRaw as any)?.data ?? sessionRaw
        const t = info?.tokens ?? {}
        const input = t.input ?? 0
        const output = t.output ?? 0
        const reasoning = t.reasoning ?? 0
        const cacheRead = t.cache?.read ?? 0
        const cacheWrite = t.cache?.write ?? 0

        // Find the model's context cap. Cache reads are cumulative across the
        // whole session, so they are NOT part of the live context occupancy.
        const models = unwrapList(await ctx.model.list())
        const ref = info?.model ?? ((await ctx.model.default() as any)?.data ?? await ctx.model.default())
        const match = models.find((m: any) =>
          (m.modelID ?? m.id) === (ref?.modelID ?? ref?.id) &&
          (!ref?.providerID || m.providerID === ref.providerID))
        const limit = match?.limit?.context ?? 0
        const used = input + output + reasoning
        const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null

        const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
        const lines = [
          `Model: ${ref?.providerID ?? "?"}/${ref?.modelID ?? ref?.id ?? "?"}`,
          `Context limit: ${limit ? fmt(limit) : "unknown"} tokens`,
          `Context used: ~${fmt(used)} (${pct === null ? "n/a" : `${pct}%`}) — approximate`,
          `Session totals (cumulative):`,
          `  input ${fmt(input)}, output ${fmt(output)}, reasoning ${fmt(reasoning)}`,
          `  cache read ${fmt(cacheRead)}, cache write ${fmt(cacheWrite)}`,
          `Session cost: ${info?.cost ?? 0}`,
        ]
        if (cacheRead > 0) lines.push("(cache-read tokens are cumulative across turns and excluded from the estimate)")
        return lines.join("\n")
      } catch (e) {
        return `Could not read context usage: ${safeError(e, config.token)}`
      }
    }

    case "effort": {
      try {
        const sessionID = await sessions.current(sessionKey)
        if (!sessionID) return "No active session. Send a message first."
        const raw = await ctx.session.get({ sessionID })
        const info: any = (raw as any)?.data ?? raw
        const current: any = info?.model ?? {}
        const providerID: string = current.providerID ?? "?"
        const modelID: string = current.modelID ?? current.id ?? "?"
        const currentVariant: string = current.variant ?? "default"

        const models = unwrapList(await ctx.model.list())
        const match = models.find((m: any) =>
          (m.modelID ?? m.id) === modelID && (!providerID || providerID === "?" || m.providerID === providerID))
        const variants: string[] = (match?.variants ?? []).map((v: any) => String(v.id)).filter(Boolean)
        const options = variants.length ? [...variants, "default"] : ["default"]

        if (!cmd.arg) {
          return [
            `Model: ${providerID}/${modelID}`,
            `Effort: ${currentVariant}`,
            `Available: ${options.join(", ")}`,
            "Change with /effort <level>.",
          ].join("\n")
        }

        const requested = cmd.arg.toLowerCase()
        if (!options.includes(requested)) {
          return `Unknown effort "${cmd.arg}". Available: ${options.join(", ")}`
        }
        await ctx.session.switchModel({
          sessionID,
          model: {
            providerID: current.providerID ?? providerID,
            id: modelID,
            ...(requested === "default" ? {} : { variant: requested }),
          },
        })
        return `Effort set to ${requested} for this session. (Resets with /new.)`
      } catch (e) {
        return `Could not change effort: ${safeError(e, config.token)}`
      }
    }

    case "compact": {
      const sessionID = await sessions.current(sessionKey)
      if (!sessionID) return "No active session to compact."
      await ctx.session.compact({ sessionID })
      return "Compaction requested. It will run at the next step boundary."
    }

    case "setagent": {
      // Alias for /agent <name>.
      return await runCommand({ name: "agent", arg: cmd.arg }, env)
    }

    default:
      return `Unknown command: /${cmd.name}. Use /help for the list.`
  }
}
