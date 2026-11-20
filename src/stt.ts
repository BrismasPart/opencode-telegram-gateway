/**
 * Optional voice transcription via an OpenAI-compatible /audio/transcriptions
 * endpoint. Disabled unless OPENCODE_TELEGRAM_STT_URL is set, so the base
 * plugin needs no external service. Shared secret via env only, never logged.
 */
import { readFileSync } from "node:fs"
import { safeError } from "./redact.js"

export function sttConfig(): { url: string; key: string; model: string } | null {
  const url = process.env.OPENCODE_TELEGRAM_STT_URL?.trim()
  if (!url) return null
  return {
    url: url.replace(/\/+$/, ""),
    key: (process.env.OPENCODE_TELEGRAM_STT_KEY ?? "").trim(),
    model: (process.env.OPENCODE_TELEGRAM_STT_MODEL ?? "whisper-1").trim(),
  }
}

/** Transcribe a local audio file. Returns null on any failure (non-fatal). */
export async function transcribe(path: string, token: string): Promise<string | null> {
  const cfg = sttConfig()
  if (!cfg) return null
  try {
    const form = new FormData()
    form.append("model", cfg.model)
    form.append("file", new Blob([new Uint8Array(readFileSync(path))]), "voice.ogg")
    const headers: Record<string, string> = {}
    if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`
    const res = await fetch(`${cfg.url}/audio/transcriptions`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.text === "string" && data.text.trim() ? data.text.trim() : null
  } catch (e) {
    console.warn(`[telegram-gateway] transcription failed: ${safeError(e, token)}`)
    return null
  }
}
