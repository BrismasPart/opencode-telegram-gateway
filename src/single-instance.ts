/**
 * Single-writer poller lock, keyed on sha256(token) (Hermes-style).
 *
 * The plugin is loaded once per OpenCode location, so a global config can
 * create several instances. Telegram rejects concurrent getUpdates pollers
 * with 409. This file lock ensures only one instance polls a given token.
 * No token material is written to disk — only a truncated hash.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

const LOCK_DIR = join(homedir(), ".local", "state", "opencode", "telegram-gateway-locks")
// OpenCode reloads can tear down a plugin instance without running its
// cleanup, so stale locks must expire quickly. Heartbeat well inside the
// stale window so a live owner never gets displaced.
const STALE_MS = 15_000
const HEARTBEAT_MS = 5_000

type LockRecord = { id: string; ts: number; pid: number }

function readRecord(path: string): LockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"))
    return value && typeof value.id === "string" && typeof value.ts === "number" ? value : null
  } catch {
    return null
  }
}

export interface PollerLock {
  release(): void
  /** False once another instance has taken over this lock. */
  isOwner(): boolean
}

export function acquirePollerLock(token: string, lockDir: string = LOCK_DIR): PollerLock | null {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 16)
  mkdirSync(lockDir, { recursive: true })
  const path = join(lockDir, `poller-${hash}.lock`)
  const id = randomUUID()
  const write = (ts: number) => writeFileSync(path, JSON.stringify({ id, ts, pid: process.pid }))
  const now = Date.now()

  try {
    const fd = openSync(path, "wx")
    try {
      writeFileSync(fd, JSON.stringify({ id, ts: now, pid: process.pid }))
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
    const existing = readRecord(path)
    const stale = !existing || now - existing.ts > STALE_MS
    if (!stale) return null
    // Stale lock: take it over. Rare race, acceptable for this use case.
    write(now)
  }

  const timer = setInterval(() => {
    try {
      const current = readRecord(path)
      if (current?.id === id) write(Date.now())
    } catch {
      // Ignore heartbeat failures; the next poll will surface real errors.
    }
  }, HEARTBEAT_MS)
  timer.unref?.()

  return {
    isOwner() {
      try {
        return readRecord(path)?.id === id
      } catch {
        return false
      }
    },
    release() {
      clearInterval(timer)
      try {
        if (readRecord(path)?.id === id) unlinkSync(path)
      } catch {
        // Best effort.
      }
    },
  }
}
