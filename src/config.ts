/**
 * Configuration for the OpenCode Telegram gateway.
 *
 * SECURITY MODEL (carried over from the Hermes gateway analysis):
 * - Secrets come only from the environment, never from config files or prompts.
 * - Default-deny: an empty allowlist means nobody is authorized. There is no
 *   `ALLOW_ALL` switch in this implementation by design.
 * - Webhook mode fails closed: a URL without a secret is a startup error, not
 *   a warning (GHSA-3vpc-7q5r-276h class of bug).
 */
import { loadSecretsFile } from "./secrets.js"

export interface GatewayConfig {
  token: string;
  /** Telegram user IDs (numeric strings) allowed to drive the agent. */
  allowedUsers: Set<string>;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookHost: string;
  webhookPort: number;
  /** Streaming: send a placeholder, then edit it as text deltas arrive. */
  streaming: boolean;
  editIntervalMs: number;
  /** Optional agent name to switch Telegram sessions to. */
  agent?: string;
  /** Optional working directory for Telegram sessions (defaults to plugin location). */
  workdir?: string;
  /** Tools denied for Telegram-driven sessions. Approval is via the OpenCode TUI. */
  deniedTools: string[];
  /** Admin users for control slash commands. Empty = gating OFF (all authorized users may run all commands). */
  adminUsers: Set<string>;
  /** Non-admin users may run these commands (plus help/whoami) when gating is on. */
  userCommands: Set<string>;
  /** What an unknown sender gets: a pairing code, or silence. Default: pair. */
  unauthorizedBehavior: "pair" | "ignore";
  /** Max entries in the Telegram `/` command menu (clamped 1..100). */
  commandMenuMax: number;
  /** Enable the media pipeline. */
  mediaEnabled: boolean;
  /** Hard per-file download/upload cap in bytes. */
  maxMediaBytes: number;
  /** Groups where the bot responds. Empty = all groups (still require authorization). */
  allowedChats: Set<string>;
  /** Forum topic ids where the bot responds. Empty = all topics. */
  allowedTopics: Set<string>;
  /** Thread ids to always ignore. */
  ignoredThreads: Set<string>;
  /** Groups: isolate sessions per sender (true) or share per chat (false). */
  groupSessionsPerUser: boolean;
  /** Forum topics: isolate sessions per sender (true) or share per topic (false). */
  threadSessionsPerUser: boolean;
  /** DM threads: "per_thread" (default) or "shared" (collapse into one session). */
  dmThreads: "per_thread" | "shared";
  /** In groups, require an @mention or reply-to-bot to trigger. */
  requireMention: boolean;
  /** Outside allowed chats, respond only to explicit @mention. */
  guestMode: boolean;
  /** Chats/topics exempt from require_mention. */
  freeResponseChats: Set<string>;
  /** Multi-bot groups: a leading @mention of another bot silences this one. */
  exclusiveBotMentions: boolean;
  /** Merge client-split text within this window (ms). 0 disables. */
  textBatchMs: number;
  /** Merge photo bursts/albums within this window (ms). 0 disables. */
  mediaBatchMs: number;
  /** Render agent replies as MarkdownV2 (plain fallback on parse error). */
  markdown: boolean;
  /** Use Bot API 10.1 native Rich Messages (raw GFM markdown) for replies. */
  richMessages: boolean;
  /** Path to the persisted per-chat flood-window file. */
  floodFile?: string;
  /** Max characters per outbound message (Telegram wire cap is 4096). */
  maxTextChars: number;
  /** Fail closed on unknown options? (reserved for future strict mode) */
  strict: boolean;
}

function parseCsv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`)
  }
  return n
}

export function loadConfig(options: { secretsFile?: string | false } = {}): GatewayConfig {
  // Load the owner-only secrets file first; real env vars still win.
  loadSecretsFile(options.secretsFile)

  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim()
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required. Create a bot with @BotFather and set the token in the environment.",
    )
  }
  // Token shape sanity check: <numeric bot id>:<35 char secret>. Reject obvious junk early.
  if (!/^\d{8,}:[-\w]{30,}$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN does not look like a Bot API token (<id>:<secret>).")
  }

  const allowedUsers = parseCsv(process.env.TELEGRAM_ALLOWED_USERS)
  const webhookUrl = (process.env.TELEGRAM_WEBHOOK_URL ?? "").trim() || undefined
  const webhookSecret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim() || undefined

  if (webhookUrl && !webhookSecret) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_WEBHOOK_URL is set. " +
        "Without it the endpoint accepts forged updates (GHSA-3vpc-7q5r-276h).",
    )
  }
  if (webhookSecret && webhookSecret.length < 32) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET should be at least 32 characters (e.g. `openssl rand -hex 32`).")
  }
  if (webhookUrl) {
    try {
      const u = new URL(webhookUrl)
      if (u.protocol !== "https:") throw new Error("not https")
    } catch {
      throw new Error("TELEGRAM_WEBHOOK_URL must be an absolute https:// URL (TLS terminates at your reverse proxy).")
    }
  }

  const rawDenied = (process.env.OPENCODE_TELEGRAM_DENIED_TOOLS ?? "bash,edit,write,patch").trim()
  const deniedTools = parseCsv(rawDenied)
  const rawBehavior = (process.env.OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR ?? "pair").trim().toLowerCase()
  if (rawBehavior !== "pair" && rawBehavior !== "ignore") {
    throw new Error("OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR must be 'pair' or 'ignore'.")
  }
  const unauthorizedBehavior = rawBehavior

  const adminUsers = parseCsv(process.env.OPENCODE_TELEGRAM_ADMIN_USERS)
  const userCommands = parseCsv(process.env.OPENCODE_TELEGRAM_USER_COMMANDS ?? "help,whoami,status,model,models")
  const boolEnv = (name: string, fallback: boolean) => {
    const v = process.env[name]?.trim().toLowerCase()
    return v === undefined ? fallback : v !== "false" && v !== "0" && v !== "no"
  }

  return {
    token,
    allowedUsers,
    webhookUrl,
    webhookSecret,
    webhookHost: (process.env.TELEGRAM_WEBHOOK_HOST ?? "127.0.0.1").trim(),
    webhookPort: intEnv("TELEGRAM_WEBHOOK_PORT", 8443, 1, 65535),
    streaming: (process.env.OPENCODE_TELEGRAM_STREAM ?? "true").toLowerCase() !== "false",
    editIntervalMs: intEnv("OPENCODE_TELEGRAM_EDIT_INTERVAL_MS", 800, 100, 10_000),
    agent: (process.env.OPENCODE_TELEGRAM_AGENT ?? "").trim() || undefined,
    workdir: (process.env.OPENCODE_TELEGRAM_WORKDIR ?? "").trim() || undefined,
    deniedTools: [...deniedTools],
    adminUsers,
    userCommands,
    unauthorizedBehavior,
    commandMenuMax: intEnv("OPENCODE_TELEGRAM_COMMAND_MENU_MAX", 60, 1, 100),
    mediaEnabled: (process.env.OPENCODE_TELEGRAM_MEDIA ?? "true").toLowerCase() !== "false",
    maxMediaBytes: intEnv("OPENCODE_TELEGRAM_MAX_MEDIA_BYTES", 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    allowedChats: parseCsv(process.env.TELEGRAM_ALLOWED_CHATS),
    allowedTopics: parseCsv(process.env.TELEGRAM_ALLOWED_TOPICS),
    ignoredThreads: parseCsv(process.env.TELEGRAM_IGNORED_THREADS),
    groupSessionsPerUser: boolEnv("OPENCODE_TELEGRAM_GROUP_SESSIONS_PER_USER", true),
    threadSessionsPerUser: boolEnv("OPENCODE_TELEGRAM_THREAD_SESSIONS_PER_USER", false),
    dmThreads: (() => {
      const v = (process.env.OPENCODE_TELEGRAM_DM_THREADS ?? "per_thread").trim().toLowerCase()
      if (v !== "per_thread" && v !== "shared") throw new Error("OPENCODE_TELEGRAM_DM_THREADS must be 'per_thread' or 'shared'.")
      return v
    })(),
    requireMention: boolEnv("TELEGRAM_REQUIRE_MENTION", false),
    guestMode: boolEnv("TELEGRAM_GUEST_MODE", false),
    freeResponseChats: parseCsv(process.env.TELEGRAM_FREE_RESPONSE_CHATS),
    exclusiveBotMentions: boolEnv("TELEGRAM_EXCLUSIVE_BOT_MENTIONS", true),
    textBatchMs: intEnv("OPENCODE_TELEGRAM_TEXT_BATCH_MS", 1200, 0, 5000),
    mediaBatchMs: intEnv("OPENCODE_TELEGRAM_MEDIA_BATCH_MS", 800, 0, 5000),
    markdown: (process.env.OPENCODE_TELEGRAM_MARKDOWN ?? "true").toLowerCase() !== "false",
    richMessages: boolEnv("OPENCODE_TELEGRAM_RICH_MESSAGES", true),
    floodFile: (process.env.OPENCODE_TELEGRAM_FLOOD_FILE ?? "").trim() || undefined,
    maxTextChars: intEnv("OPENCODE_TELEGRAM_MAX_CHARS", 4000, 100, 4096),
    strict: (process.env.OPENCODE_TELEGRAM_STRICT ?? "true").toLowerCase() !== "false",
  }
}
