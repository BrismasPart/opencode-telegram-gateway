/**
 * Inbound media pipeline: Telegram media → local cache → OpenCode attachment.
 *
 * OpenCode sessions accept `files: [{ uri: "file:///abs/path", name, description }]`
 * on `session.prompt`. Model-visible types: UTF-8 text, PNG/JPEG/GIF/WebP images,
 * and PDFs. Audio/video are NOT model-visible, so they are cached to disk and
 * described by path (voice can optionally be transcribed via STT — see stt.ts).
 *
 * SECURITY:
 * - Hard per-file byte cap enforced while streaming (never unbounded buffers).
 * - file_path is validated: no absolute paths, no "..", no backslashes — this
 *   is the traversal-safe local-server mapping rule from the Hermes analysis.
 * - Extensions derived from magic bytes where possible, not from filenames.
 * - Downloads use the Bot API's own file endpoint (authenticated, no SSRF).
 */
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs"
import { join, extname, basename } from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import type { TelegramApi, TelegramMessage } from "./telegram.js"
import { safeError } from "./redact.js"

export type CachedMedia = {
  path: string
  ext: string
  bytes: number
  kind: "image" | "text" | "pdf" | "audio" | "video" | "sticker" | "binary"
  name: string
}

function cacheDir(): string {
  const dir = join(process.env.OPENCODE_TELEGRAM_CACHE_DIR?.trim() || join(tmpdir(), "opencode-telegram-media"), "inbound")
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Validate a Telegram file_path against traversal/absolute path attacks. */
export function safeFilePath(raw: string | undefined): string | null {
  if (!raw) return null
  const path = raw.replace(/\\/g, "/")
  if (path.startsWith("/") || path.includes("..")) return null
  return path.replace(/^\/+/, "")
}

/** Detect extension from magic bytes (images/pdf/audio/video); fallback to path. */
export function sniffExt(bytes: Uint8Array, path: string): string {
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ".gif"
  if (b.subarray(0, 4) && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") return ".webp"
  if (String.fromCharCode(...b.subarray(0, 4)) === "%PDF") return ".pdf"
  if (String.fromCharCode(...b.subarray(4, 8)) === "ftyp") return ".mp4"
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ".webm"
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return ".ogg"
  return extname(path) || ".bin"
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])
const AUDIO_EXTS = new Set([".ogg", ".oga", ".mp3", ".m4a", ".wav", ".flac", ".opus"])
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"])

export function classify(ext: string, mime?: string): CachedMedia["kind"] {
  if (IMAGE_EXTS.has(ext) || (mime ?? "").startsWith("image/")) return "image"
  if (ext === ".pdf") return "pdf"
  if (AUDIO_EXTS.has(ext) || (mime ?? "").startsWith("audio/")) return "audio"
  if (VIDEO_EXTS.has(ext) || (mime ?? "").startsWith("video/")) return "video"
  if ((mime ?? "").startsWith("text/") || [".txt", ".md", ".json", ".csv", ".log", ".yaml", ".yml", ".py", ".js", ".ts", ".sh"].includes(ext)) return "text"
  return "binary"
}

/** Download and cache one Telegram file. Returns null on any failure (non-fatal). */
export async function cacheTelegramFile(
  api: TelegramApi,
  fileId: string,
  label: string,
  maxBytes: number,
  token: string,
  hintExt?: string,
  mime?: string,
): Promise<CachedMedia | null> {
  try {
    const info = await api.getFile(fileId)
    const path = safeFilePath(info.file_path)
    if (!path) {
      console.warn(`[telegram-gateway] refused unsafe file path for ${label}`)
      return null
    }
    if (info.file_size && info.file_size > maxBytes) return null // reject oversized before download
    const bytes = await api.downloadFileBytes(path, maxBytes)
    if (bytes.byteLength === 0) return null
    const ext = sniffExt(bytes, hintExt ?? path)
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16)
    const filename = `${label}-${hash}${ext}`
    const out = join(cacheDir(), filename)
    if (!existsSync(out)) writeFileSync(out, bytes, { mode: 0o600 })
    return { path: out, ext, bytes: bytes.byteLength, kind: classify(ext, mime), name: basename(path) || filename }
  } catch (e) {
    console.warn(`[telegram-gateway] ${label} download failed: ${safeError(e, token)}`)
    return null
  }
}

/** Convert a cached file into an OpenCode prompt attachment. */
export function attachmentFor(media: CachedMedia, description?: string) {
  return {
    uri: pathToFileURL(media.path).href,
    name: media.name,
    description: description ?? `${media.kind} attachment from Telegram`,
  }
}

/** Pick the media payload from a message (largest photo, or first media item). */
export function messageMedia(msg: TelegramMessage): Array<{ fileId: string; label: string; mime?: string; name?: string }> {
  const items: Array<{ fileId: string; label: string; mime?: string; name?: string }> = []
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]
    items.push({ fileId: largest.file_id, label: "photo" })
  }
  if (msg.document) items.push({ fileId: msg.document.file_id, label: "document", mime: msg.document.mime_type, name: msg.document.file_name })
  if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video) items.push({ fileId: msg.sticker.file_id, label: "sticker" })
  if (msg.audio) items.push({ fileId: msg.audio.file_id, label: "audio", mime: msg.audio.mime_type, name: msg.audio.file_name })
  if (msg.voice) items.push({ fileId: msg.voice.file_id, label: "voice", mime: msg.voice.mime_type })
  if (msg.video) items.push({ fileId: msg.video.file_id, label: "video", mime: msg.video.mime_type, name: msg.video.file_name })
  if (msg.video_note) items.push({ fileId: msg.video_note.file_id, label: "video_note" })
  if (msg.animation) items.push({ fileId: msg.animation.file_id, label: "animation", mime: msg.animation.mime_type, name: msg.animation.file_name })
  return items
}

/** Build the text note for non-model-visible media. */
export function mediaNote(media: CachedMedia): string {
  switch (media.kind) {
    case "image": return `[The user sent an image; see attachment ${media.name}]`
    case "pdf": return `[The user sent a PDF; see attachment ${media.name}]`
    case "text": return `[The user sent a text file ${media.name} at ${media.path}]`
    case "audio": return `[The user sent an audio file ${media.name} (not directly visible to the model) at ${media.path}]`
    case "video": return `[The user sent a video ${media.name} (not directly visible to the model) at ${media.path}]`
    case "sticker": return `[The user sent a sticker; see attachment ${media.name}]`
    default: return `[The user sent a file ${media.name} at ${media.path}]`
  }
}
