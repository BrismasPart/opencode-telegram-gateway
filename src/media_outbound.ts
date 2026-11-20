/**
 * Outbound media: the agent emits `MEDIA: /path/to/file` lines in its final
 * answer; we strip them from the text and upload the files as native Telegram
 * photos / audio / video / documents.
 *
 * Ambiguous uploads are never retried in another shape (Hermes duplicate-
 * delivery rule). Oversized files are rejected before upload.
 */
import { readFileSync, statSync, existsSync } from "node:fs"
import { extname, basename } from "node:path"
import type { TelegramApi } from "./telegram.js"
import { safeError } from "./redact.js"

export type MediaDirective = { path: string; caption?: string }

/** Extract MEDIA: directives. Supports `MEDIA: /path` and `[[MEDIA:/path]]`. */
export function parseMediaDirectives(text: string): { text: string; media: MediaDirective[] } {
  const media: MediaDirective[] = []
  const lines = text.split(/\r?\n/)
  const kept: string[] = []
  for (const line of lines) {
    const simple = /^\s*MEDIA:\s*(\S+)(?:\s+(.*))?$/.exec(line)
    if (simple) {
      media.push({ path: simple[1], caption: simple[2]?.trim() || undefined })
      continue
    }
    const bracket = /\[\[MEDIA:\s*(\S+)\s*\]\]/.exec(line)
    if (bracket) {
      media.push({ path: bracket[1], caption: undefined })
      // If the line is only the tag, drop it; otherwise keep the surrounding text.
      const stripped = line.replace(/\[\[MEDIA:\s*\S+\s*\]\]/g, "").replace(/\s+/g, " ").trim()
      if (stripped) kept.push(stripped)
      continue
    }
    kept.push(line)
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), media }
}

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])
const AUDIO = new Set([".ogg", ".oga", ".mp3", ".m4a", ".wav", ".flac", ".opus"])
const VIDEO = new Set([".mp4", ".webm", ".mov"])

export function uploadPlan(ext: string): { method: string; field: string } {
  if (IMAGE.has(ext)) return { method: "sendPhoto", field: "photo" }
  if (ext === ".ogg" || ext === ".oga" || ext === ".opus") return { method: "sendVoice", field: "voice" }
  if (AUDIO.has(ext)) return { method: "sendAudio", field: "audio" }
  if (VIDEO.has(ext)) return { method: "sendVideo", field: "video" }
  return { method: "sendDocument", field: "document" }
}

/** Send one local file. Returns true on success. Non-fatal. */
export async function sendMediaFile(
  api: TelegramApi,
  chatId: string,
  directive: MediaDirective,
  maxBytes: number,
  token: string,
): Promise<boolean> {
  try {
    const path = directive.path.replace(/^~/, process.env.HOME ?? "")
    if (!existsSync(path)) {
      console.warn(`[telegram-gateway] MEDIA file not found: ${basename(path)}`)
      return false
    }
    const st = statSync(path)
    if (!st.isFile() || st.size > maxBytes) {
      console.warn(`[telegram-gateway] MEDIA file rejected (missing/too large): ${basename(path)}`)
      return false
    }
    const bytes = readFileSync(path)
    const ext = extname(path).toLowerCase()
    const { method, field } = uploadPlan(ext)
    const blob = new Blob([new Uint8Array(bytes)])
    const fields: Record<string, string> = { chat_id: chatId }
    if (directive.caption) fields.caption = directive.caption.slice(0, 1024)
    await api.upload(method, fields, blob, field, basename(path))
    return true
  } catch (e) {
    console.warn(`[telegram-gateway] MEDIA upload failed: ${safeError(e, token)}`)
    return false
  }
}
