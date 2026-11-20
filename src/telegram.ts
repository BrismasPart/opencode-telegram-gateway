/**
 * Minimal Telegram Bot API client. Deliberately dependency-free: no PTB, no
 * private APIs, no HTTPX. Uses fetch + AbortSignal for every call.
 *
 * SECURITY: the token is only ever used to build the URL; it is never logged.
 * Ambiguous failures (timeout / network drop after write) are never retried,
 * matching the "LOST sends are never resent" rule from the Hermes analysis.
 */
import { logMethod, redact, safeError } from "./redact.js"
import { diag } from "./diagnostics.js"
import type { FloodGuard } from "./flood.js"
import { isParseError } from "./markdown.js"

const API_BASE = "https://api.telegram.org"

export type Update = {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  inline_query?: InlineQuery
}

export type TelegramMessage = {
  message_id: number
  date: number
  chat: { id: number; type: string; title?: string; is_forum?: boolean }
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string }
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id: string; mime_type?: string; file_size?: number }
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  video_note?: { file_id: string; file_size?: number }
  animation?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  sticker?: { file_id: string; file_unique_id?: string; is_animated?: boolean; is_video?: boolean; file_size?: number }
  media_group_id?: string
}

export type InlineQuery = {
  id: string
  from: { id: number; is_bot?: boolean; first_name?: string; username?: string }
  query: string
  offset: string
}

export type BotCommand = { command: string; description: string }

/** Telegram File object from getFile. */
export type TelegramFile = {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}

export type InlineResult = {
  type: "article"
  id: string
  title: string
  description?: string
  input_message_content: { message_text: string }
}

/** Allowed updates used for both polling and webhook registration. */
export const ALLOWED_UPDATES = '["message","edited_message","channel_post","inline_query"]'

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfter: number | undefined,
    readonly kind: "refused" | "flood" | "lost" | "server" | "local" | "conflict",
  ) {
    super(message)
  }
}

function classify(res: Response | undefined, data: any, error: unknown): TelegramError {
  if (data?.parameters?.retry_after !== undefined) {
    return new TelegramError(`flood: retry after ${data.parameters.retry_after}s`, res?.status, Number(data.parameters.retry_after), "flood")
  }
  const status = res?.status
  const description = data?.description ?? (error instanceof Error ? error.message : String(error))
  if (status === 409 || /conflict|terminated by other getupdates/i.test(String(description))) {
    return new TelegramError(redact(String(description), ""), status, undefined, "conflict")
  }
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return new TelegramError(redact(String(description), ""), status, undefined, "refused")
  }
  if (status && status >= 500) {
    return new TelegramError(redact(String(description), ""), status, undefined, "server")
  }
  // No readable answer: request may have left. Treat as LOST, never resend.
  return new TelegramError("ambiguous network failure (no readable answer)", status, undefined, "lost")
}

export class TelegramApi {
  private flood: FloodGuard | undefined

  constructor(private readonly token: string, flood?: FloodGuard) {
    this.flood = flood
  }

  /** Fail closed when a chat is inside a persisted flood window. */
  private floodCheck(chatId: string): void {
    const remaining = this.flood?.remaining(chatId) ?? 0
    if (remaining > 0) throw new TelegramError(`flood_control:${remaining}`, 429, remaining, "refused")
  }

  private noteFlood(chatId: string, error: unknown): void {
    const err = error as TelegramError
    if (err?.kind === "flood" && err.retryAfter) {
      this.flood?.note(chatId, err.retryAfter)
    }
  }

  private url(method: string, params: Record<string, string> = {}): URL {
    const u = new URL(`${API_BASE}/bot${this.token}/${method}`)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u
  }

  async call<T>(method: string, params: Record<string, string> = {}, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    return this.request(method, params, undefined, signal, timeoutMs)
  }

  /** POST a JSON body (setMyCommands, answerInlineQuery, etc.). */
  async callJson<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    return this.request(method, {}, body, undefined, timeoutMs)
  }

  /** POST multipart/form-data (uploads). `file` is added as a Blob under `field`. */
  async upload<T>(
    method: string,
    fields: Record<string, string>,
    file: Blob,
    field: string,
    filename: string,
    timeoutMs = 300_000,
  ): Promise<T> {
    const chat = fields.chat_id
    if (chat) this.floodCheck(chat)
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    form.append(field, file, filename)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("upload timeout")), timeoutMs)
    let res: Response | undefined
    let data: any
    try {
      res = await fetch(this.url(method), { method: "POST", body: form, signal: controller.signal })
      try { data = await res.json() } catch { data = undefined }
      if (!res.ok || !data?.ok) {
        const description = redact(String(data?.description ?? ""), this.token)
        diag("api_error", this.token, { method, status: res.status, detail: description })
        throw classify(res, data, undefined)
      }
      logMethod(method, true, this.token)
      return data.result as T
    } catch (e) {
      if (chat) this.noteFlood(chat, e)
      if (e instanceof TelegramError) throw e
      diag("fetch_error", this.token, { method, name: (e as Error)?.name ?? "unknown", detail: safeError(e, this.token), status: res?.status ?? 0 })
      throw classify(res, undefined, e)
    } finally {
      clearTimeout(timer)
    }
  }

  private async request<T>(
    method: string,
    params: Record<string, string>,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("request timeout")), timeoutMs)
    const onAbort = () => controller.abort((signal as any)?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    let res: Response | undefined
    let data: any
    try {
      const init: RequestInit = body
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal }
        : { method: "GET", signal: controller.signal }
      res = await fetch(this.url(method, params), init)
      try {
        data = await res.json()
      } catch {
        data = undefined
      }
      if (!res.ok || !data?.ok) {
        const description = redact(String(data?.description ?? ""), this.token)
        // A stream preview edit racing the final edit is a benign no-op.
        if (!/message is not modified/i.test(description)) {
          diag("api_error", this.token, { method, status: res.status, detail: description })
        }
        throw classify(res, data, undefined)
      }
      return data.result as T
    } catch (e) {
      if (e instanceof TelegramError) throw e
      diag("fetch_error", this.token, { method, name: (e as Error)?.name ?? "unknown", detail: safeError(e, this.token), status: res?.status ?? 0 })
      throw classify(res, undefined, e)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  /** getMe under a short deadline — used to verify the token at startup. */
  async verify(): Promise<{ id: number; username?: string }> {
    return this.call("getMe", {}, undefined, 10_000)
  }

  /** Resolve a file_id to a Telegram file_path. */
  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", { file_id: fileId })
  }

  /**
   * Download a Telegram file by file_path with a hard byte cap and timeout.
   * Reads the stream in chunks and rejects if it exceeds maxBytes — never
   * buffer an unbounded body into memory (Hermes W10 finding).
   */
  async downloadFileBytes(filePath: string, maxBytes: number, timeoutMs = 60_000): Promise<Uint8Array> {
    const url = `${API_BASE}/file/bot${this.token}/${filePath}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("download timeout")), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) throw classify(res, undefined, undefined)
      const len = Number(res.headers.get("content-length") ?? 0)
      if (len > maxBytes) throw new Error(`file too large (${len} > ${maxBytes})`)
      const reader = res.body?.getReader()
      if (!reader) throw new Error("no response body")
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) { await reader.cancel(); throw new Error(`file too large (> ${maxBytes})`) }
        chunks.push(value)
      }
      const out = new Uint8Array(total)
      let pos = 0
      for (const c of chunks) { out.set(c, pos); pos += c.byteLength }
      logMethod("downloadFile", true, this.token)
      return out
    } catch (e) {
      logMethod("downloadFile", false, this.token, safeError(e, this.token))
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async getUpdates(offset: number, signal?: AbortSignal): Promise<Update[]> {
    // allowed_updates is JSON-encoded; only messages are needed for this gateway.
    return this.call<Update[]>(
      "getUpdates",
      { offset: String(offset), timeout: "10", allowed_updates: ALLOWED_UPDATES },
      signal,
      15_000,
    )
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES })
    logMethod("setWebhook", true, this.token)
  }

  async deleteWebhook(): Promise<void> {
    try {
      await this.call("deleteWebhook", {})
    } catch (e) {
      // Best effort on shutdown. Never log the error text (may contain a URL).
      console.warn(`[telegram-gateway] deleteWebhook: ${safeError(e, this.token)}`)
    }
  }

  /**
   * Send text, honoring a flood wait up to 5s inline. Longer waits and
   * ambiguous failures are returned as errors so the caller can surface them
   * rather than retrying into the penalty.
   */
  async sendText(chatId: string, text: string, replyToMessageId?: number, parseMode?: string, plainFallback?: string): Promise<number> {
    this.floodCheck(chatId)
    const params: Record<string, string> = { chat_id: chatId, text }
    if (replyToMessageId) params.reply_parameters = JSON.stringify({ message_id: replyToMessageId })
    if (parseMode) params.parse_mode = parseMode
    try {
      const msg = await this.call<{ message_id: number }>("sendMessage", params, undefined, 30_000)
      logMethod("sendMessage", true, this.token)
      return msg.message_id
    } catch (e) {
      const err = e as TelegramError
      // Entity parse error → retry once as plain text (never on transport/5xx).
      if (parseMode && plainFallback !== undefined && isParseError(err)) {
        logMethod("sendMessage.plain-fallback", true, this.token)
        return this.call<{ message_id: number }>(
          "sendMessage",
          { chat_id: chatId, text: plainFallback, ...(replyToMessageId ? { reply_parameters: JSON.stringify({ message_id: replyToMessageId }) } : {}) },
          undefined,
          30_000,
        ).then((m) => m.message_id)
      }
      if (err.kind === "flood" && err.retryAfter && err.retryAfter <= 5) {
        await new Promise((r) => setTimeout(r, (err.retryAfter! + 0.2) * 1000))
        const msg = await this.call<{ message_id: number }>("sendMessage", params, undefined, 30_000)
        logMethod("sendMessage", true, this.token)
        return msg.message_id
      }
      this.noteFlood(chatId, e)
      logMethod("sendMessage", false, this.token, safeError(e, this.token))
      throw err
    }
  }

  async editText(chatId: string, messageId: number, text: string, parseMode?: string, plainFallback?: string): Promise<void> {
    this.floodCheck(chatId)
    const params: Record<string, string> = { chat_id: chatId, message_id: String(messageId), text }
    if (parseMode) params.parse_mode = parseMode
    try {
      await this.call("editMessageText", params, undefined, 30_000)
      logMethod("editMessageText", true, this.token)
    } catch (e) {
      const err = e as TelegramError
      if (err.kind === "refused" && /not modified/i.test(err.message)) return
      if (parseMode && plainFallback !== undefined && isParseError(err)) {
        logMethod("editMessageText.plain-fallback", true, this.token)
        await this.call("editMessageText", { chat_id: chatId, message_id: String(messageId), text: plainFallback }, undefined, 30_000)
        return
      }
      this.noteFlood(chatId, e)
      logMethod("editMessageText", false, this.token, safeError(e, this.token))
      throw err
    }
  }

  /** Register the `/` command menu for a scope. `scope` is a BotCommandScope object. */
  async setMyCommands(commands: BotCommand[], scope?: Record<string, unknown>): Promise<void> {
    const body: Record<string, unknown> = { commands }
    if (scope) body.scope = scope
    await this.callJson("setMyCommands", body)
    logMethod("setMyCommands", true, this.token)
  }

  /**
   * Send a Bot API 10.1 native Rich Message with raw GFM markdown.
   * The rich_message object is passed as JSON (not URL params).
   * Caller handles capability/parse errors by falling back to MarkdownV2.
   */
  async sendRichMessage(chatId: string, markdown: string, replyToMessageId?: number): Promise<number> {
    this.floodCheck(chatId)
    const body: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: { markdown },
    }
    if (replyToMessageId) body.reply_parameters = { message_id: replyToMessageId }
    try {
      const msg = await this.callJson<{ message_id: number }>("sendRichMessage", body, 30_000)
      logMethod("sendRichMessage", true, this.token)
      return msg.message_id
    } catch (e) {
      this.noteFlood(chatId, e)
      logMethod("sendRichMessage", false, this.token, safeError(e, this.token))
      throw e
    }
  }

  /** True when the Bot API doesn't support rich messages (latch off permanently). */
  static richUnavailable(error: unknown): boolean {
    const status = (error as TelegramError)?.status
    const msg = String((error as Error)?.message ?? error ?? "").toLowerCase()
    return status === 404 || /method not found|unknown method/i.test(msg)
  }

  /** True when rich markdown could not be parsed — fall back for THIS reply only. */
  static richParseError(error: unknown): boolean {
    const msg = String((error as Error)?.message ?? error ?? "").toUpperCase()
    return /RICH_MESSAGE_|RICH_TEXT_|CAN'T PARSE/i.test(msg)
  }

  /** Answer an inline query. Empty results with is_personal are the fail-closed response. */
  async answerInlineQuery(
    queryId: string,
    results: InlineResult[],
    opts: { cacheTime?: number; isPersonal?: boolean; nextOffset?: string } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = {
      inline_query_id: queryId,
      results,
      cache_time: opts.cacheTime ?? 10,
      is_personal: opts.isPersonal ?? true,
    }
    if (opts.nextOffset !== undefined) body.next_offset = opts.nextOffset
    await this.callJson("answerInlineQuery", body)
    logMethod("answerInlineQuery", true, this.token)
  }
}

/** Split text on UTF-16 boundaries (Telegram counts UTF-16 code units). */
export function splitByUtf16(text: string, maxUnits: number): string[] {
  const chunks: string[] = []
  let current = ""
  let units = 0
  for (const ch of text) {
    const w = ch.codePointAt(0)! > 0xffff ? 2 : 1
    if (units + w > maxUnits && current) {
      chunks.push(current)
      current = ""
      units = 0
    }
    current += ch
    units += w
  }
  if (current) chunks.push(current)
  return chunks
}

/** Extract text from a message, marking non-text content for the agent. */
export function messageText(msg: TelegramMessage): string {
  if (msg.text) return msg.text
  if (msg.caption) return `[Image/media] ${msg.caption}`
  return "[The user sent a non-text message.]"
}
