/**
 * Update dedup backed by the plugin's durable storage.
 *
 * Telegram redelivers updates whose acknowledgement was lost. Without a
 * receipt store, a reconnect would start duplicate agent turns. Receipts are
 * keyed by update_id and expire after 24h (Telegram's maximum redelivery
 * window), matching the Hermes gateway's receipt TTL.
 */
const PREFIX = "tg:seen:"
const TTL_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY = 200

export class ReceiptStore {
  private counter = 0

  constructor(private readonly ctx: any) {}

  private key(updateId: number): string {
    return `${PREFIX}${updateId}`
  }

  async seen(updateId: number): Promise<boolean> {
    const raw = await this.ctx.storage.get<string>(this.key(updateId))
    if (raw === undefined) return false
    const ts = Number(raw)
    if (!Number.isFinite(ts) || Date.now() - ts > TTL_MS) {
      await this.ctx.storage.remove(this.key(updateId))
      return false
    }
    return true
  }

  async mark(updateId: number): Promise<void> {
    await this.ctx.storage.set(this.key(updateId), String(Date.now()))
    if (++this.counter % PRUNE_EVERY === 0) void this.prune()
  }

  async prune(): Promise<void> {
    const now = Date.now()
    let cursor: string | undefined
    do {
      const page = await this.ctx.storage.scan({ prefix: PREFIX, limit: 200, ...(cursor ? { after: cursor } : {}) })
      for (const entry of page.entries ?? []) {
        const ts = Number(entry.value)
        if (!Number.isFinite(ts) || now - ts > TTL_MS) {
          await this.ctx.storage.remove(entry.key)
        }
      }
      cursor = page.next
    } while (cursor)
  }
}
