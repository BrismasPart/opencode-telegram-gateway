/**
 * Inbound batching: merge client-split text and photo bursts into one turn.
 *
 * Telegram splits long text into consecutive messages; photos sent together
 * arrive as separate updates. Without batching each becomes its own agent turn.
 * We hold a pending item per chat for a short window, then flush it to the real
 * handler once. Commands are never batched. Batching is cancel-safe: closing
 * the gateway flushes pending items synchronously rather than dropping them.
 */
import type { HandleUpdate } from "./transport.js"
import type { Update, TelegramMessage } from "./telegram.js"
import { diag } from "./diagnostics.js"

type Pending = {
  updates: Update[]
  timer: ReturnType<typeof setTimeout>
}

export class InboundBatcher {
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly handle: HandleUpdate,
    private readonly textMs: number,
    private readonly mediaMs: number,
    private readonly token: string,
  ) {}

  /** Feed an update. Returns true if it was batched, false if passed through. */
  feed(update: Update): boolean {
    const msg = update.message
    if (!msg) return false
    const text = msg.text ?? ""
    if (text.startsWith("/")) return false // commands never batch
    const hasText = !!text && text.length < 4000
    const hasPhoto = !!(msg.photo?.length) && !msg.media_group_id
    if (!hasText && !hasPhoto) return false

    const key = `${msg.chat.id}:${hasPhoto ? "photo" : "text"}`
    const delay = hasPhoto ? this.mediaMs : this.textMs
    if (delay <= 0) return false

    const existing = this.pending.get(key)
    if (existing) {
      existing.updates.push(update)
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => this.flush(key), delay)
      return true
    }
    const timer = setTimeout(() => this.flush(key), delay)
    this.pending.set(key, { updates: [update], timer })
    return true
  }

  private flush(key: string): void {
    const entry = this.pending.get(key)
    if (!entry) return
    this.pending.delete(key)
    clearTimeout(entry.timer)

    // Merge text chunks; keep media updates as separate attachments.
    const merged = this.merge(entry.updates)
    for (const u of merged) {
      void Promise.resolve(this.handle(u)).catch((e) => {
        diag("batch_handle_error", this.token, { error: (e as Error)?.name ?? "unknown" })
      })
    }
  }

  private merge(updates: Update[]): Update[] {
    const texts: string[] = []
    const others: Update[] = []
    for (const u of updates) {
      const m = u.message
      if (m?.text && !m.photo) texts.push(m.text)
      else others.push(u)
    }
    const out: Update[] = []
    if (texts.length) {
      const first = { ...(updates[0] as any) }
      const firstMsg: TelegramMessage = { ...(first.message as TelegramMessage) }
      firstMsg.text = texts.join("\n")
      first.message = firstMsg
      out.push(first as Update)
    }
    out.push(...others)
    return out
  }

  /** Flush everything without waiting (e.g. on shutdown). */
  close(): void {
    for (const key of [...this.pending.keys()]) this.flush(key)
  }
}
