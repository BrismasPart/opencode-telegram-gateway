/**
 * Per-chat flood windows, persisted to an owner-only JSON file.
 *
 * Modeled on Hermes' telegram_flood_cooldown_<bot_id>.json:
 * - Clamp waits to [1, 300]s; longer penalties fail closed to the caller.
 * - Persist wall-clock "until" timestamps across restarts; boot load clamps
 *   them to <= 300s so a copied/stale file cannot silence the bot for hours.
 * - Check before EVERY chat-scoped send; arm on any flood refusal so sibling
 *   calls on the same chat do not hammer the penalty.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { diag } from "./diagnostics.js"

const MAX_WINDOW_MS = 300_000
const PREFIX = "tg:flood:"

type Store = Record<string, number>

export class FloodGuard {
  private store: Store = {}
  private dirty = false

  constructor(private readonly path: string, private readonly token: string) {
    this.load()
  }

  static forBot(botId: number, token: string): FloodGuard {
    const dir = join(homedir(), ".local", "state", "opencode")
    const path = process.env.OPENCODE_TELEGRAM_FLOOD_FILE?.trim()
      || join(dir, `telegram-flood-${botId}.json`)
    return new FloodGuard(path, token)
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return
      const parsed = JSON.parse(readFileSync(this.path, "utf8"))
      const now = Date.now()
      this.store = {}
      for (const [k, v] of Object.entries(parsed ?? {})) {
        if (typeof v !== "number") continue
        const remaining = v - now
        if (remaining > 0) this.store[k] = now + Math.min(remaining, MAX_WINDOW_MS)
      }
    } catch {
      this.store = {}
    }
  }

  private flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.store), { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // Best effort: a failed flush never blocks sends.
    }
  }

  /** Remaining seconds for a chat, or 0 if clear. */
  remaining(chatId: string): number {
    const until = this.store[chatId]
    if (!until) return 0
    const left = until - Date.now()
    if (left <= 0) {
      delete this.store[chatId]
      this.dirty = true
      this.flush()
      return 0
    }
    return Math.ceil(left / 1000)
  }

  /** Arm (or extend) a window. Returns the clamped seconds. */
  note(chatId: string, seconds: number): number {
    const clamped = Math.max(1, Math.min(300, Math.floor(seconds)))
    this.store[chatId] = Date.now() + clamped * 1000
    this.dirty = true
    this.flush()
    diag("flood_window", this.token, { chat: chatId, seconds: clamped })
    return clamped
  }

  clear(chatId: string): void {
    if (delete this.store[chatId]) {
      this.dirty = true
      this.flush()
    }
  }
}
