import { describe, expect, test } from "bun:test"
import { redact } from "../src/redact.js"
import { splitByUtf16 } from "../src/telegram.js"
import { loadConfig } from "../src/config.js"
import { extractDelta } from "../src/streaming.js"
import { extractAssistantText } from "../src/sessions.js"
import { loadSecretsFile } from "../src/secrets.js"
import { acquirePollerLock } from "../src/single-instance.js"
import { parseCommand, commandAllowed, runCommand } from "../src/commands.js"
import { sanitizeName, clampNames, normalizeDescription, buildMenuRows, menuFingerprint } from "../src/command_menu.js"
import { filterCatalog, buildInlinePage, rank } from "../src/inline_picker.js"
import { safeFilePath, sniffExt, classify, messageMedia } from "../src/media_inbound.js"
import { parseMediaDirectives, uploadPlan } from "../src/media_outbound.js"
import { toMarkdownV2, escapeMdv2, isParseError } from "../src/markdown.js"
import { FloodGuard } from "../src/flood.js"
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const TOKEN = "123456789:AAExampleSecretToken_abcdefghijklmnopqrstuvwxyz"

describe("redaction", () => {
  test("masks the exact token everywhere", () => {
    const text = `failed GET https://api.telegram.org/bot${TOKEN}/getUpdates`
    const out = redact(text, TOKEN)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(TOKEN.split(":")[1])
    expect(out).toContain("<redacted-token>")
  })

  test("masks token-shaped strings even without the exact token", () => {
    const out = redact("bot987654321:ZZAnotherSecretToken_abcdefghijklmnop", "")
    expect(out).not.toContain("ZZAnotherSecretToken")
    expect(out).toContain("bot<id>:<redacted>")
  })

  test("strips URL query strings", () => {
    expect(redact("https://x.test/a?token=secret", TOKEN)).not.toContain("token=secret")
  })
})

describe("UTF-16 chunking", () => {
  test("splits without breaking surrogate pairs", () => {
    const text = "a".repeat(3999) + "😀" + "b".repeat(10)
    const chunks = splitByUtf16(text, 4000)
    expect(chunks.length).toBe(2)
    for (const c of chunks) {
      // No lone surrogates.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c)).toBe(false)
    }
    expect(chunks.join("")).toBe(text)
  })

  test("empty text yields no chunks", () => {
    expect(splitByUtf16("", 4000)).toEqual([])
  })
})

describe("OpenCode event/message shapes", () => {
  test("extracts a V2 text delta from event.data", () => {
    const ev = {
      type: "session.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "hello" },
    }
    expect(extractDelta(ev)).toEqual({ sessionID: "ses_1", delta: "hello" })
  })

  test("ignores unrelated events", () => {
    expect(extractDelta({ type: "session.idle", data: { sessionID: "ses_1" } })).toBeNull()
  })

  test("reads final text from V2 assistant content array", () => {
    const messages = [
      { type: "user", content: [{ type: "text", text: "hi" }] },
      { type: "assistant", content: [{ type: "text", text: "final answer" }] },
    ]
    expect(extractAssistantText(messages)).toBe("final answer")
  })

  test("reads final text from legacy role/parts shape", () => {
    const messages = [{ role: "assistant", parts: [{ type: "text", text: "legacy answer" }] }]
    expect(extractAssistantText(messages)).toBe("legacy answer")
  })
})

describe("secrets file", () => {
  const keys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_GATEWAY_ENV_FILE"]

  test("loads an owner-only file and ignores comments/quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-secrets-"))
    const path = join(dir, "gateway.env")
    writeFileSync(path, "# comment\nTELEGRAM_BOT_TOKEN=\"123456789:secret\"\n\nTELEGRAM_ALLOWED_USERS='42'\n")
    chmodSync(path, 0o600)
    for (const k of keys) delete process.env[k]
    try {
      expect(loadSecretsFile(path)).toBe(2)
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe("123456789:secret")
      expect(process.env.TELEGRAM_ALLOWED_USERS).toBe("42")
    } finally {
      for (const k of keys) delete process.env[k]
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("refuses group/world-readable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-secrets-"))
    const path = join(dir, "gateway.env")
    writeFileSync(path, "TELEGRAM_BOT_TOKEN=x")
    chmodSync(path, 0o644)
    try {
      expect(() => loadSecretsFile(path)).toThrow(/chmod 600/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("real environment wins over the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-secrets-"))
    const path = join(dir, "gateway.env")
    writeFileSync(path, "TELEGRAM_BOT_TOKEN=from-file\n")
    chmodSync(path, 0o600)
    process.env.TELEGRAM_BOT_TOKEN = "from-env"
    try {
      loadSecretsFile(path)
      expect(process.env.TELEGRAM_BOT_TOKEN).toBe("from-env")
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects keys outside the gateway prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-secrets-"))
    const path = join(dir, "gateway.env")
    writeFileSync(path, "PATH=/evil\n")
    chmodSync(path, 0o600)
    try {
      expect(() => loadSecretsFile(path)).toThrow(/Unsupported key/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("missing file is a no-op; false disables loading", () => {
    expect(loadSecretsFile(join(tmpdir(), "does-not-exist-xyz.env"))).toBe(0)
    expect(loadSecretsFile(false)).toBe(0)
  })
})

describe("slash commands", () => {
  const clear = () => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "OPENCODE_TELEGRAM_ADMIN_USERS", "OPENCODE_TELEGRAM_USER_COMMANDS"]) {
      delete process.env[k]
    }
  }

  test("parses /cmd, /cmd@bot, and arguments", () => {
    expect(parseCommand("/new")).toEqual({ name: "new", arg: "" })
    expect(parseCommand("/model@MyBot anthropic/claude")).toEqual({ name: "model", arg: "anthropic/claude" })
    expect(parseCommand("just text")).toBeNull()
  })

  test("gating off: every authorized user may run every command", () => {
    clear()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    const cfg = loadConfig({ secretsFile: false })
    expect(commandAllowed("new", "anyone", cfg)).toBe(true)
  })

  test("runCommand reads models from an API envelope { data: [...] }", async () => {
    clear()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    const config = loadConfig({ secretsFile: false })
    const ctx = {
      model: {
        list: async () => ({ data: [{ providerID: "anthropic", modelID: "claude", name: "Claude" }] }),
        default: async () => ({ data: { providerID: "anthropic", modelID: "claude" } }),
      },
    }
    const reply = await runCommand({ name: "models", arg: "" }, { ctx, config } as any)
    expect(reply).toContain("anthropic/claude")
    const show = await runCommand({ name: "model", arg: "" }, { ctx, config } as any)
    expect(show).toContain("anthropic/claude")
  })

  test("runCommand context uses session tokens and model limit, excluding cache reads", async () => {
    clear()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    const config = loadConfig({ secretsFile: false })
    const ctx = {
      session: {
        current: async () => "ses_test",
        get: async () => ({ data: {
          model: { id: "m", providerID: "p" },
          tokens: { input: 500, output: 100, reasoning: 50, cache: { read: 99999, write: 0 } },
          cost: 0.01,
        } }),
      },
      model: {
        list: async () => ({ data: [{ providerID: "p", modelID: "m", limit: { context: 1000 } }] }),
        default: async () => ({ data: { providerID: "p", modelID: "m" } }),
      },
    }
    const sessions = { current: async () => "ses_test" }
    const reply = await runCommand({ name: "context", arg: "" }, { ctx, config, sessions } as any)
    expect(reply).toContain("Context limit: 1.0k tokens")
    expect(reply).toContain("~650")
    expect(reply).toContain("65%")
    expect(reply).toContain("cache read 100.0k")
  })

  test("runCommand effort shows and switches variants", async () => {
    clear()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    const config = loadConfig({ secretsFile: false })
    const switched: any[] = []
    const ctx = {
      session: {
        get: async () => ({ data: { model: { id: "m", providerID: "p", variant: "default" } } }),
        switchModel: async (input: any) => { switched.push(input) },
      },
      model: {
        list: async () => ({ data: [{ providerID: "p", modelID: "m", variants: [{ id: "none" }, { id: "high" }] }] }),
        default: async () => ({ data: { providerID: "p", modelID: "m" } }),
      },
    }
    const sessions = { current: async () => "ses_test" }
    const show = await runCommand({ name: "effort", arg: "" }, { ctx, config, sessions } as any)
    expect(show).toContain("Effort: default")
    expect(show).toContain("none, high, default")
    const set = await runCommand({ name: "effort", arg: "high" }, { ctx, config, sessions } as any)
    expect(set).toContain("Effort set to high")
    expect(switched[0].model.variant).toBe("high")
    const bad = await runCommand({ name: "effort", arg: "ultra" }, { ctx, config, sessions } as any)
    expect(bad).toContain("Unknown effort")
    expect(switched.length).toBe(1)
  })

  test("gating on: admins get all, users get help/whoami/status/model, not new/stop", () => {
    clear()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.OPENCODE_TELEGRAM_ADMIN_USERS = "111"
    const cfg = loadConfig({ secretsFile: false })
    expect(commandAllowed("new", "111", cfg)).toBe(true)
    expect(commandAllowed("stop", "111", cfg)).toBe(true)
    expect(commandAllowed("help", "222", cfg)).toBe(true)
    expect(commandAllowed("whoami", "222", cfg)).toBe(true)
    expect(commandAllowed("status", "222", cfg)).toBe(true)
    expect(commandAllowed("model", "222", cfg)).toBe(true)
    expect(commandAllowed("new", "222", cfg)).toBe(false)
    expect(commandAllowed("stop", "222", cfg)).toBe(false)
    expect(commandAllowed("setagent", "222", cfg)).toBe(false)
    expect(commandAllowed("sessions", "111", cfg)).toBe(true)
    expect(commandAllowed("sessions", "222", cfg)).toBe(false)
    expect(commandAllowed("resume", "111", cfg)).toBe(true)
    expect(commandAllowed("resume", "222", cfg)).toBe(false)
  })

  test("sessions all and search produce indexed rows for /resume", async () => {
    clear()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    const config = loadConfig({ secretsFile: false })
    const stored: Record<string, any> = {}
    const all = [
      { id: "ses_aaa", title: "Alpha", model: { providerID: "p", id: "m" }, tokens: { input: 1200 } },
      { id: "ses_bbb", title: "Beta", tokens: {} },
    ]
    const ctx = {
      storage: {
        get: async (k: string) => stored[k],
        set: async (k: string, v: any) => { stored[k] = v },
        scan: async () => ({ entries: [] }),
      },
      session: {
        list: async (o: any) => ({ data: o.search ? all.filter((s) => s.title.toLowerCase().includes(o.search.toLowerCase())) : all, cursor: { next: null } }),
        get: async ({ sessionID }: any) => ({ data: all.find((s) => s.id === sessionID) ?? all[0] }),
        switchModel: async () => {},
      },
    }
    const sessions = {
      current: async () => "ses_aaa",
      list: async (o: any) => (o.search ? all.filter((s) => s.title.toLowerCase().includes(o.search.toLowerCase())) : all),
      bind: async (chat: string, id: string) => { stored[`tg:session:${chat}`] = id; return true },
    } as any
    const env = { ctx, config, sessions, userId: "111", chatId: "chat1", botId: 1, title: "t" }

    const listing = await runCommand({ name: "sessions", arg: "all" }, env)
    expect(listing).toContain("1. ses_aaa | Alpha")
    expect(listing).toContain("2. ses_bbb | Beta")
    expect(listing).toContain("← current")
    expect(stored["tg:sessions:index:chat1"]).toEqual(["ses_aaa", "ses_bbb"])

    // Resume by index uses the index from the most recent listing.
    const resumed = await runCommand({ name: "resume", arg: "2" }, env)
    expect(resumed).toContain("Resumed session ses_bbb")
    expect(stored["tg:session:chat1"]).toBe("ses_bbb")

    // Resume by explicit id also works.
    const resumedById = await runCommand({ name: "resume", arg: "ses_aaa" }, env)
    expect(resumedById).toContain("Resumed session ses_aaa")

    const search = await runCommand({ name: "sessions", arg: "search beta" }, env)
    expect(search).toContain("ses_bbb")
    expect(search).not.toContain("ses_aaa")
  })
})

describe("command menu", () => {
  test("sanitizes names to [a-z0-9_] and drops nameless ones", () => {
    expect(sanitizeName("My-Command")).toBe("my_command")
    expect(sanitizeName("中文helper")).toBe("helper")
    expect(sanitizeName("中文")).toBeNull()
  })

  test("clamps long names and handles collisions", () => {
    const rows = clampNames([
      { command: "a".repeat(40), description: "x" },
      { command: "a".repeat(40), description: "y" },
    ])
    expect(rows.length).toBe(2)
    expect(rows[0].command).toHaveLength(32)
    expect(rows[1].command).toHaveLength(32)
    expect(rows[0].command).not.toBe(rows[1].command)
  })

  test("folds unicode dashes in descriptions", () => {
    expect(normalizeDescription("a—b")).toBe("a-b")
  })

  test("applies priority before the cap; hidden counts the rest", () => {
    const { rows, hidden } = buildMenuRows([
      { name: "zzz", description: "last" },
      { name: "help", description: "first", priority: 0 },
      { name: "new", description: "second", priority: 1 },
    ], 2)
    expect(rows.map((r) => r.command)).toEqual(["help", "new"])
    expect(hidden).toBe(1)
  })

  test("fingerprint changes when rows change", () => {
    const a = menuFingerprint([{ command: "help", description: "x" }])
    const b = menuFingerprint([{ command: "help", description: "y" }])
    expect(a).not.toBe(b)
  })
})

describe("inline picker", () => {
  test("ranks prefix before substring before description", () => {
    const catalog = [
      { name: "listmodels", description: "x" },
      { name: "models", description: "y" },
      { name: "help", description: "show models" },
    ]
    expect(rank(catalog[1], "model")).toBe(0)
    expect(rank(catalog[0], "model")).toBe(1)
    expect(rank(catalog[2], "model")).toBe(2)
    expect(filterCatalog("model", catalog).map((c) => c.name)).toEqual(["models", "listmodels", "help"])
  })

  test("treats hyphens and underscores as equivalent", () => {
    expect(rank({ name: "set-model", description: "" }, "set_model")).toBe(0)
  })

  test("paginates and turns trailing tokens into command args", () => {
    const catalog = Array.from({ length: 60 }, (_, i) => ({ name: `cmd${i}`, description: "" }))
    const page1 = buildInlinePage("cmd 42", "0", 50, catalog)
    expect(page1.results).toHaveLength(50)
    expect(page1.nextOffset).toBe("50")
    expect(page1.results[0].input_message_content.message_text).toContain("42")
    const page2 = buildInlinePage("cmd 42", "50", 50, catalog)
    expect(page2.results).toHaveLength(10)
    expect(page2.nextOffset).toBeUndefined()
  })

  test("empty query returns full catalog in order", () => {
    const catalog = [{ name: "b", description: "" }, { name: "a", description: "" }]
    expect(buildInlinePage("", "0", 50, catalog).results.map((r) => r.title)).toEqual(["/b", "/a"])
  })
})

describe("inbound media", () => {
  test("rejects traversal and absolute file paths", () => {
    expect(safeFilePath("photos/file_1.jpg")).toBe("photos/file_1.jpg")
    expect(safeFilePath("../etc/passwd")).toBeNull()
    expect(safeFilePath("/etc/passwd")).toBeNull()
    expect(safeFilePath("..\\windows\\system32")).toBeNull()
  })

  test("sniffs extensions from magic bytes", () => {
    expect(sniffExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "x.bin")).toBe(".png")
    expect(sniffExt(new Uint8Array([0xff, 0xd8, 0xff]), "x.bin")).toBe(".jpg")
    expect(sniffExt(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "x.bin")).toBe(".pdf")
  })

  test("classifies model-visible vs path-only media", () => {
    expect(classify(".png")).toBe("image")
    expect(classify(".pdf")).toBe("pdf")
    expect(classify(".ogg")).toBe("audio")
    expect(classify(".mp4")).toBe("video")
    expect(classify(".bin")).toBe("binary")
  })

  test("picks largest photo and media items from a message", () => {
    const items = messageMedia({ message_id: 1, date: 0, chat: { id: 1, type: "private" }, photo: [{ file_id: "small" }, { file_id: "big" }], voice: { file_id: "v" } } as any)
    expect(items.map((i) => i.fileId)).toEqual(["big", "v"])
  })
})

describe("outbound media", () => {
  test("parses MEDIA: directives and strips them from text", () => {
    const result = parseMediaDirectives("Here you go.\nMEDIA: /tmp/report.pdf\nDone.")
    expect(result.text).toBe("Here you go.\nDone.")
    expect(result.media).toEqual([{ path: "/tmp/report.pdf", caption: undefined }])
  })

  test("parses inline [[MEDIA:path]] tags", () => {
    const result = parseMediaDirectives("See [[MEDIA:/tmp/a.png]] inline.")
    expect(result.text).toBe("See inline.")
    expect(result.media[0].path).toBe("/tmp/a.png")
  })

  test("maps extensions to native send methods", () => {
    expect(uploadPlan(".png").method).toBe("sendPhoto")
    expect(uploadPlan(".ogg").method).toBe("sendVoice")
    expect(uploadPlan(".mp3").method).toBe("sendAudio")
    expect(uploadPlan(".mp4").method).toBe("sendVideo")
    expect(uploadPlan(".pdf").method).toBe("sendDocument")
  })
})

describe("MarkdownV2", () => {
  test("escapes special characters", () => {
    expect(escapeMdv2("a.b-c!")).toBe("a\\.b\\-c\\!")
  })

  test("renders bold, italic, code, and links", () => {
    const out = toMarkdownV2("**bold** and *italic* and `x_y` and [site](https://example.com)")
    expect(out).toContain("*bold*")
    expect(out).toContain("_italic_")
    expect(out).toContain("`x_y`")
    expect(out).toContain("[site](https://example.com)")
  })

  test("fenced code keeps contents unescaped except backslash/backtick", () => {
    const out = toMarkdownV2("```js\nfoo_bar.baz\n```")
    expect(out).toContain("foo_bar.baz")
    expect(out).not.toContain("foo\\_bar")
  })

  test("detects entity parse errors, not transport errors", () => {
    expect(isParseError({ kind: "refused", message: "Bad Request: can't parse entities" })).toBe(true)
    expect(isParseError({ kind: "flood", message: "retry after 5" })).toBe(false)
    expect(isParseError({ name: "TimedOut", message: "timed out" })).toBe(false)
  })
})

describe("flood windows", () => {
  test("clamps waits to [1,300] and persists across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-flood-"))
    const file = join(dir, "flood.json")
    try {
      const g1 = new FloodGuard(file, TOKEN)
      g1.note("chat1", 9999)
      expect(g1.remaining("chat1")).toBeLessThanOrEqual(300)
      expect(g1.remaining("chat1")).toBeGreaterThan(290)
      const g2 = new FloodGuard(file, TOKEN)
      expect(g2.remaining("chat1")).toBeGreaterThan(285)
      g2.clear("chat1")
      expect(new FloodGuard(file, TOKEN).remaining("chat1")).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not create a file for a fresh guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-flood-"))
    const file = join(dir, "flood.json")
    try {
      expect(new FloodGuard(file, TOKEN).remaining("c")).toBe(0)
      expect(existsSync(file)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("single poller lock", () => {
  test("only one instance owns a token at a time", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-lock-"))
    try {
      const first = acquirePollerLock("123456789:secret", dir)
      expect(first).not.toBeNull()
      expect(acquirePollerLock("123456789:secret", dir)).toBeNull()
      expect(acquirePollerLock("987654321:other", dir)).not.toBeNull()
      first!.release()
      expect(acquirePollerLock("123456789:secret", dir)).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("config fails closed", () => {
  const original = { ...process.env }
  const reset = () => {
    for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS", "TELEGRAM_WEBHOOK_URL", "TELEGRAM_WEBHOOK_SECRET"]) {
      delete process.env[k]
    }
  }

  test("missing token throws", () => {
    reset()
    expect(() => loadConfig({ secretsFile: false })).toThrow(/TELEGRAM_BOT_TOKEN is required/)
  })

  test("webhook URL without secret throws", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.test/hook"
    expect(() => loadConfig({ secretsFile: false })).toThrow(/TELEGRAM_WEBHOOK_SECRET is required/)
  })

  test("short webhook secret throws", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.test/hook"
    process.env.TELEGRAM_WEBHOOK_SECRET = "short"
    expect(() => loadConfig({ secretsFile: false })).toThrow(/at least 32 characters/)
  })

  test("non-https webhook URL throws", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.TELEGRAM_WEBHOOK_URL = "http://example.test/hook"
    process.env.TELEGRAM_WEBHOOK_SECRET = "x".repeat(40)
    expect(() => loadConfig({ secretsFile: false })).toThrow(/https/)
  })

  test("empty allowlist is accepted but authorizes nobody", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    const cfg = loadConfig({ secretsFile: false })
    expect(cfg.allowedUsers.size).toBe(0)
    expect(cfg.unauthorizedBehavior).toBe("pair")
  })

  test("unauthorized behavior can be set to ignore", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR = "ignore"
    expect(loadConfig({ secretsFile: false }).unauthorizedBehavior).toBe("ignore")
  })

  test("invalid unauthorized behavior throws", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = TOKEN
    process.env.OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR = "allow-everyone"
    expect(() => loadConfig({ secretsFile: false })).toThrow(/must be 'pair' or 'ignore'/)
  })

  test("malformed token is rejected", () => {
    reset()
    process.env.TELEGRAM_BOT_TOKEN = "not-a-token"
    expect(() => loadConfig({ secretsFile: false })).toThrow(/does not look like/)
  })
})
