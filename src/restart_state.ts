/**
 * Durable restart notices, modeled on Hermes' marker files.
 *
 * Three paths:
 *  1. Pre-restart warning — sent by the OLD process to active chats + home.
 *  2. Requester notice — marker written by /restart, replayed by the NEW
 *     process to the chat that typed it ("restarted successfully").
 *  3. Home online notice — planned-restart marker replayed on boot.
 *
 * Markers are kept on failure and have a TTL so a chat whose platform never
 * returns cannot hold a marker forever. Only terminal outcomes clear a marker.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, openSync, closeSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const TTL_MS = 30 * 60 * 1000

function dir(): string {
  return process.env.OPENCODE_TELEGRAM_RESTART_DIR?.trim()
    || join(homedir(), ".local", "state", "opencode")
}
function requesterFile(): string { return join(dir(), "telegram-restart-notify.json") }
function plannedFile(): string { return join(dir(), "telegram-restart-pending.json") }
function bootClaimFile(): string { return join(dir(), "telegram-boot-notice.claim") }

/**
 * Claim the boot-notice replay. Only ONE plugin instance (we load in multiple
 * locations) may send the online/restarted notices; otherwise every notice is
 * duplicated. The claim is atomic via exclusive create and TTL-bounded.
 */
export function claimBootNotice(): boolean {
  try {
    const fd = openSync(bootClaimFile(), "wx")
    closeSync(fd)
    writeFileSync(bootClaimFile(), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 })
    return true
  } catch (e: any) {
    if (e?.code !== "EEXIST") return false
    try {
      const v = JSON.parse(readFileSync(bootClaimFile(), "utf8"))
      if (typeof v?.at === "number" && Date.now() - v.at > TTL_MS) {
        // Stale claim — take over.
        writeFileSync(bootClaimFile(), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 })
        return true
      }
    } catch { /* unreadable claim — treat as taken */ }
    return false
  }
}

export function releaseBootNotice(): void {
  try { unlinkSync(bootClaimFile()) } catch { /* best effort */ }
}

export type RequesterMarker = {
  chatId: string
  userId: string
  sessionKey: string
  messageId?: number
  requestedAt: number
}
export type PlannedMarker = {
  requestedAt: number
  deliveredTargets: string[]
}

function read<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    const value = JSON.parse(readFileSync(path, "utf8"))
    if (!value || typeof value !== "object") return null
    if (typeof value.requestedAt !== "number" || Date.now() - value.requestedAt > TTL_MS) {
      // Expired marker — clear it.
      try { unlinkSync(path) } catch { /* best effort */ }
      return null
    }
    return value as T
  } catch {
    return null
  }
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, path)
}

export function writeRequesterMarker(m: Omit<RequesterMarker, "requestedAt">): void {
  writeAtomic(requesterFile(), { ...m, requestedAt: Date.now() })
}
export function readRequesterMarker(): RequesterMarker | null {
  return read<RequesterMarker>(requesterFile())
}
export function clearRequesterMarker(): void {
  try { unlinkSync(requesterFile()) } catch { /* best effort */ }
}

export function writePlannedMarker(): void {
  const existing = readPlannedMarker()
  writeAtomic(plannedFile(), {
    requestedAt: existing?.requestedAt ?? Date.now(),
    deliveredTargets: existing?.deliveredTargets ?? [],
  })
}
export function readPlannedMarker(): PlannedMarker | null {
  return read<PlannedMarker>(plannedFile())
}
export function markPlannedDelivered(chatId: string): void {
  const m = readPlannedMarker()
  if (!m) return
  if (!m.deliveredTargets.includes(chatId)) m.deliveredTargets.push(chatId)
  writeAtomic(plannedFile(), m)
}
export function clearPlannedMarker(): void {
  try { unlinkSync(plannedFile()) } catch { /* best effort */ }
}

export const NOTICE = {
  preRestart: "⚠️ Gateway is restarting — your current task will be interrupted.\nSend any message after the restart and I'll try to resume where you left off.",
  shutdown: "⚠️ Gateway is shutting down — your current task will be interrupted. When it is back online, send any message and I'll try to pick up where we left off.",
  online: "♻️ Gateway online — back and ready.",
  restarted: "♻️ Gateway restarted successfully. Your session continues.",
}
