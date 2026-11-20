/**
 * The `/` command menu, exposed via Telegram's setMyCommands.
 *
 * Security/behavior modeled on the Hermes gateway's `/` menu pipeline:
 * - Single source of truth (COMMAND_CATALOG); aliases are never menu entries.
 * - Sanitize names to [a-z0-9_], clamp to 32 chars, fold unicode dashes in
 *   descriptions, then prioritize BEFORE the cap.
 * - Cap at 60 (Telegram allows 100, but has an undocumented ~4KB payload cap).
 *   Hidden ≠ disabled: every command still dispatches when typed.
 * - Register to three scopes: Default, AllPrivateChats, AllGroupChats.
 *   Forum supergroups don't inherit AllGroupChats, so they get a lazy per-chat
 *   BotCommandScopeChat on first message.
 * - Fingerprint the rows so unchanged menus are not re-pushed every reload.
 * - Non-fatal: registration happens as post-connect housekeeping.
 */
import { createHash } from "node:crypto"
import type { BotCommand, TelegramApi } from "./telegram.js"
import { COMMAND_CATALOG, type CommandDef } from "./commands.js"
import { diag } from "./diagnostics.js"

const NAME_LIMIT = 32
const DESC_LIMIT = 256
const DEFAULT_MAX = 60
const FINGERPRINT_KEY = "tg:menu:fingerprint"

/** Telegram accepts only [a-z0-9_] for command names. */
export function sanitizeName(raw: string): string | null {
  let name = raw.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "")
  if (!name || !/[a-z0-9]/.test(name)) return null
  return name
}

/** Clamp to 32 chars; collisions get a 31-char prefix + digit, else dropped. */
export function clampNames(rows: BotCommand[]): BotCommand[] {
  const used = new Set<string>()
  const out: BotCommand[] = []
  for (const row of rows) {
    let name = row.command
    if (name.length > NAME_LIMIT) {
      const base = name.slice(0, NAME_LIMIT - 1)
      let found: string | null = null
      for (let d = 0; d <= 9; d++) {
        const candidate = `${base}${d}`
        if (!used.has(candidate)) { found = candidate; break }
      }
      if (!found) continue
      name = found
    }
    if (used.has(name)) continue
    used.add(name)
    out.push({ command: name, description: row.description })
  }
  return out
}

/** BotFather rejects unicode dashes; fold them to ASCII '-' and cap length. */
export function normalizeDescription(raw: string): string {
  const folded = raw
    .replace(/[\u2010-\u2015\u2212\u2E3A\u2E3B]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
  return folded.slice(0, DESC_LIMIT)
}

/** Build menu rows with priority applied before the cap. */
export function buildMenuRows(
  catalog: CommandDef[] = COMMAND_CATALOG,
  maxCommands: number = DEFAULT_MAX,
): { rows: BotCommand[]; hidden: number } {
  const cap = Math.max(1, Math.min(100, maxCommands))
  const candidates = catalog
    .map((c) => {
      const name = sanitizeName(c.name)
      if (!name) return null
      return { name, description: normalizeDescription(c.description), priority: c.priority ?? Number.MAX_SAFE_INTEGER }
    })
    .filter((x): x is { name: string; description: string; priority: number } => x !== null)
    .sort((a, b) => a.priority - b.priority)

  const all = clampNames(candidates.map((c) => ({ command: c.name, description: c.description })))
  return { rows: all.slice(0, cap), hidden: Math.max(0, all.length - cap) }
}

export function menuFingerprint(rows: BotCommand[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex")
}

const SCOPES: Record<string, Record<string, unknown>> = {
  default: { type: "default" },
  private: { type: "all_private_chats" },
  group: { type: "all_group_chats" },
}

/** Register the menu to all three scopes. Non-fatal; returns true if pushed. */
export async function registerMenu(
  api: TelegramApi,
  ctx: any,
  token: string,
  maxCommands: number,
): Promise<boolean> {
  const { rows, hidden } = buildMenuRows(COMMAND_CATALOG, maxCommands)
  const fingerprint = menuFingerprint(rows)
  if ((await ctx.storage.get<string>(FINGERPRINT_KEY)) === fingerprint) {
    diag("menu_unchanged", token)
    return false
  }

  let ok = true
  for (const [name, scope] of Object.entries(SCOPES)) {
    try {
      await api.setMyCommands(rows, scope)
    } catch (e) {
      ok = false
      diag("menu_scope_failed", token, { scope: name, error: (e as Error)?.name ?? "unknown" })
    }
  }
  if (ok) {
    await ctx.storage.set(FINGERPRINT_KEY, fingerprint)
    diag("menu_registered", token, { count: rows.length, hidden })
  }
  return ok
}

/** Lazily register the identical menu for a forum supergroup (once per chat). */
export class ForumMenuGuard {
  private readonly done = new Set<string>()

  constructor(private readonly api: TelegramApi, private readonly token: string, private readonly rows: BotCommand[]) {}

  async ensure(chatId: string): Promise<void> {
    if (this.done.has(chatId)) return
    this.done.add(chatId)
    try {
      await this.api.setMyCommands(this.rows, { type: "chat", chat_id: Number(chatId) })
      diag("forum_menu", this.token, { chat: chatId })
    } catch (e) {
      diag("forum_menu_failed", this.token, { chat: chatId, error: (e as Error)?.name ?? "unknown" })
    }
  }
}

/** Build the rows used by the forum guard (same pipeline as the main menu). */
export function menuRowsForForum(maxCommands: number): BotCommand[] {
  return buildMenuRows(COMMAND_CATALOG, maxCommands).rows
}
