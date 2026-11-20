/**
 * Optional image/sticker descriptions via an OpenAI-compatible vision endpoint.
 *
 * Disabled unless OPENCODE_TELEGRAM_VISION_URL is set. When enabled, a static
 * sticker is downloaded, cached, and described once; the description is cached
 * by file_unique_id in an owner-only JSON file so the same sticker is never
 * analyzed twice. Images can optionally be described too
 * (OPENCODE_TELEGRAM_VISION_IMAGES=true) — otherwise images are attached
 * directly to the model and need no description.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { safeError } from "./redact.js"
import { diag } from "./diagnostics.js"

export function visionConfig(): { url: string; key: string; model: string; prompt: string; images: boolean } | null {
  const url = process.env.OPENCODE_TELEGRAM_VISION_URL?.trim()
  if (!url) return null
  return {
    url: url.replace(/\/+$/, ""),
    key: (process.env.OPENCODE_TELEGRAM_VISION_KEY ?? "").trim(),
    model: (process.env.OPENCODE_TELEGRAM_VISION_MODEL ?? "gpt-4o-mini").trim(),
    prompt: (process.env.OPENCODE_TELEGRAM_VISION_PROMPT ?? "Describe this image or sticker in one short sentence.").trim(),
    images: (process.env.OPENCODE_TELEGRAM_VISION_IMAGES ?? "false").toLowerCase() === "true",
  }
}

type Cache = Record<string, { description: string; emoji?: string; ts: number }>

function cachePath(): string {
  return process.env.OPENCODE_TELEGRAM_VISION_CACHE?.trim()
    || join(homedir(), ".local", "state", "opencode", "telegram-sticker-vision.json")
}

export class VisionDescriber {
  private cache: Cache = {}

  constructor(private readonly token: string) {
    try {
      if (existsSync(cachePath())) this.cache = JSON.parse(readFileSync(cachePath(), "utf8")) ?? {}
    } catch {
      this.cache = {}
    }
  }

  private save(): void {
    try {
      const path = cachePath()
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.cache), { mode: 0o600 })
      renameSync(tmp, path)
    } catch {
      // Best effort.
    }
  }

  cached(key: string): string | null {
    return this.cache[key]?.description ?? null
  }

  /** Describe an image file. Returns null on any failure (non-fatal). */
  async describe(path: string, cacheKey?: string, emoji?: string): Promise<string | null> {
    const cfg = visionConfig()
    if (!cfg) return null
    if (cacheKey && this.cache[cacheKey]) return this.cache[cacheKey].description
    try {
      const bytes = readFileSync(path)
      const mime = path.endsWith(".webp") ? "image/webp" : path.endsWith(".png") ? "image/png" : "image/jpeg"
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`
      const res = await fetch(`${cfg.url}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: cfg.model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: cfg.prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          }],
          max_tokens: 120,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) {
        diag("vision_failed", this.token, { status: res.status })
        return null
      }
      const data = await res.json()
      const description: string | undefined = data?.choices?.[0]?.message?.content
      if (typeof description !== "string" || !description.trim()) return null
      const text = description.trim().slice(0, 500)
      if (cacheKey) {
        this.cache[cacheKey] = { description: text, emoji, ts: Date.now() }
        this.save()
      }
      diag("vision_ok", this.token, { cacheKey: cacheKey ? "yes" : "no" })
      return text
    } catch (e) {
      diag("vision_error", this.token, { error: (e as Error)?.name ?? "unknown", detail: safeError(e, this.token) })
      return null
    }
  }
}
