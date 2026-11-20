/**
 * Polling supervision: heartbeat, stall watchdog, and reconnect ladders.
 *
 * Modeled on the Hermes gateway's polling health machinery but simplified:
 * - Every successful getUpdates round-trip is "progress" (even zero updates).
 * - Heartbeat (90s) probes getMe so a half-open socket surfaces as an error.
 * - Stall watchdog (150s without progress) forces a reconnect.
 * - Network ladder: 10 retries, 5s → 60s exponential.
 * - Conflict (409) ladder: 5 retries, 20s → 60s, then a fatal signal — Telegram
 *   allows only one poller per token, so retrying longer rarely helps.
 *
 * A reconnect stops the current loop before starting a fresh one; a loop that
 * notices it lost ownership also stops itself (see transport.ts).
 */
import type { TelegramApi, Update } from "./telegram.js"
import { TelegramError } from "./telegram.js"
import { startPolling } from "./transport.js"
import { diag } from "./diagnostics.js"
import { safeError } from "./redact.js"

export type ReliabilityOptions = {
  heartbeatMs?: number
  stallMs?: number
  maxNetworkRetries?: number
  maxConflictRetries?: number
  onFatal?: (reason: string) => void
  onProgress?: () => void
}

const HEARTBEAT_MS = 90_000
const STALL_MS = 150_000
const MAX_NETWORK_RETRIES = 10
const MAX_CONFLICT_RETRIES = 5

export class PollingSupervisor {
  private stopCurrent: (() => void) | null = null
  private stopped = false
  private lastProgress = Date.now()
  private timer: ReturnType<typeof setInterval> | null = null
  private reconnecting = false

  constructor(
    private readonly api: TelegramApi,
    private readonly token: string,
    private readonly handle: (u: Update) => Promise<void>,
    private readonly outer: AbortSignal,
    private readonly isOwner: () => boolean,
    private readonly opts: ReliabilityOptions = {},
  ) {}

  start(): void {
    this.lastProgress = Date.now()
    this.startLoop()
    this.timer = setInterval(() => void this.tick(), Math.min(30_000, this.opts.heartbeatMs ?? HEARTBEAT_MS))
    this.outer.addEventListener("abort", () => this.stop(), { once: true })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopCurrent?.()
    this.stopCurrent = null
  }

  private noteProgress(): void {
    this.lastProgress = Date.now()
    this.opts.onProgress?.()
  }

  private startLoop(): void {
    if (this.stopped || !this.isOwner()) return
    this.stopCurrent = startPolling(
      this.api,
      async (u) => { await this.handle(u) },
      this.outer,
      this.token,
      this.isOwner,
      () => this.noteProgress(),
      (e) => this.onPollError(e),
    )
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.reconnecting || !this.isOwner()) return
    const idleMs = Date.now() - this.lastProgress

    // Stall watchdog: no progress at all → reconnect immediately.
    if (idleMs > (this.opts.stallMs ?? STALL_MS)) {
      diag("stall_watchdog", this.token, { idleMs })
      await this.reconnect("stall")
      return
    }

    // Heartbeat: a long-poll can be silent for ~10s, so only probe after the
    // heartbeat interval. A getMe failure means the transport is wedged.
    if (idleMs >= (this.opts.heartbeatMs ?? HEARTBEAT_MS)) {
      try {
        await this.api.verify()
        diag("heartbeat_ok", this.token)
        this.noteProgress() // a verified path counts as progress
      } catch (e) {
        diag("heartbeat_failed", this.token, { error: (e as Error)?.name ?? "unknown" })
        await this.reconnect("heartbeat")
      }
    }
  }

  /** Stop the current loop and retry with the appropriate ladder. */
  async reconnect(reason: string, firstError?: unknown): Promise<void> {
    if (this.reconnecting || this.stopped) return
    this.reconnecting = true
    this.stopCurrent?.()
    this.stopCurrent = null

    let isConflict = firstError instanceof TelegramError && firstError.kind === "conflict"
      || /conflict/i.test(String(reason))
    const max = isConflict ? (this.opts.maxConflictRetries ?? MAX_CONFLICT_RETRIES) : (this.opts.maxNetworkRetries ?? MAX_NETWORK_RETRIES)
    let attempt = 0

    try {
      while (attempt < max && !this.stopped && this.isOwner()) {
        attempt++
        const delay = isConflict
          ? Math.min(60_000, 20_000 + (attempt - 1) * 10_000)
          : Math.min(60_000, 5_000 * 2 ** Math.min(attempt - 1, 4))
        diag("reconnect_wait", this.token, { reason, attempt, delay: delay / 1000, kind: isConflict ? "conflict" : "network" })
        if (await this.sleep(delay)) return // stopped during wait

        try {
          await this.api.verify()
          this.noteProgress()
          this.startLoop()
          diag("reconnect_ok", this.token, { reason, attempt })
          return
        } catch (e) {
          diag("reconnect_failed", this.token, { reason, attempt, error: (e as Error)?.name ?? "unknown", detail: safeError(e, this.token) })
          // If verify returned a conflict, switch to the conflict ladder.
          if (e instanceof TelegramError && e.kind === "conflict") {
            isConflict = true
          }
        }
      }
      if (!this.stopped) {
        diag("reconnect_exhausted", this.token, { reason, attempts: attempt })
        this.opts.onFatal?.(isConflict ? "polling_conflict" : "polling_network")
      }
    } finally {
      this.reconnecting = false
    }
  }

  /** Called by the polling loop when it hits an error. */
  onPollError(error: unknown): void {
    if (error instanceof TelegramError && error.kind === "conflict") {
      void this.reconnect("conflict", error)
    } else if (error instanceof TelegramError && error.kind === "lost") {
      // A LOST getUpdates is ambiguous; the stall watchdog/heartbeat will
      // decide whether a reconnect is needed. No immediate resend.
      diag("poll_lost", this.token, { detail: safeError(error, this.token) })
    }
  }

  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      this.outer.addEventListener("abort", () => { clearTimeout(t); resolve(true) }, { once: true })
    })
  }
}
