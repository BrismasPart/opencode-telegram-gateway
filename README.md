# OpenCode Telegram Gateway (plugin)

A dependency-free V2 OpenCode server plugin that bridges Telegram messages to
OpenCode sessions. 
Based on Hermes Gateway.

## Scope

- Long polling (default) or webhook with a mandatory secret.
- Text messages only (captions are forwarded as `[Image/media] …`).
- One OpenCode session per Telegram chat (persisted in plugin storage).
- Optional streaming previews via `session.text.delta` events, finalized by a
  normal send/edit.
- Default-deny authorization with an optional pairing-style reply: unknown
  senders get a ready-to-run command to add their ID to the allowlist.
- Slash commands with a **separate admin ACL**: `/help`, `/whoami`, `/status`,
  `/new`, `/stop`, `/model`, `/models`, `/agent`, `/agents`, `/commands`,
  `/compact`, `/context`, `/effort`, `/sessions`, `/resume` (last two admin only).
- **Client-facing command surfaces**: the `/` menu via `setMyCommands` (three
  scopes + lazy forum scope, 60-entry cap, priority ordering, fingerprint-based
  re-registration) and an inline picker (`@bot <query>`) with authorization,
  filtering, pagination, and uncapped catalog.
- **Media pipeline**: inbound photos/documents/PDFs become OpenCode prompt
  attachments (`file://` URIs), audio/video are cached with path notes, voice
  is optionally transcribed; outbound `MEDIA: <path>` directives upload as
  native photos/voice/audio/video/documents. Traversal-safe paths and hard
  20 MiB caps throughout.
- **MarkdownV2 rendering**: agent replies are converted to Telegram MarkdownV2
  (bold/italic/code/links/quotes) with UTF-16 chunking and a plain-text
  fallback on entity-parse errors — never on transport errors.
- **Persisted flood windows**: per-chat 429 cooldowns clamped to 1–300 s and
  written to a 0600 file; surviving restarts, checked before every send.
- **Sessions (admin only)**: `/sessions` lists Telegram-bound sessions,
  `/sessions all` lists every OpenCode session, `/sessions search <q>` filters
  by title. Each row is numbered; `/resume <number>` resumes by the last
  listing's index, `/resume <session_id>` resumes by id.
- Dedup receipts, token redaction, least-privilege session permissions, and no
  blind resends of ambiguous failures.

## Load the plugin

Either drop it in `.opencode/plugins/opencode-telegram-gateway/` (auto-loaded), or add
to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["~/.config/opencode/plugins/opencode-telegram-gateway"]
}
```

Config reloads without a restart. Plugins are server-side; the TUI connects to
the background service where this plugin runs.

## Hermes-like setup

No separate gateway server is needed: `opencode serve --service` is the long-running host, and this plugin's polling loop runs inside it. Three pieces give you the Hermes setup experience:

1. **Secrets file** — create `~/.config/opencode/telegram-gateway.env` with mode `0600`. It is loaded by the plugin at `setup` (env vars win). Only `TELEGRAM_*` / `OPENCODE_TELEGRAM_*` keys are accepted; wrong permissions or ownership fail closed. `TELEGRAM_GATEWAY_ENV_FILE` can override the path.
   - **Never paste the token into the agent.** Run `scripts/write-secrets.sh` in your own terminal: it reads with `read -s` (hidden input), writes the 0600 file, and leaves nothing in shell history, prompts, tool calls, or logs. Leave the allowlist prompt blank to test default-deny. Any token typed into chat is recorded in the session log — do not rely on redaction to clean it up.
2. **Wizard** — the `telegram-gateway` skill walks through BotFather token, operator user ID, transport choice, writing the secrets file, and `/reload`. (The QR managed-bot flow depends on an external Nous service and is not reproduced.)
3. **Supervision** — `scripts/install-service.sh` installs a systemd `--user` unit that runs `opencode serve --service` with `Restart=always`. Run `opencode service set disabled true` first so there is only one server on port 4096.

Important: plugin `setup` throws if the token is missing, so write the secrets file before starting the service.

## Configuration (environment variables)

Secrets can come from the real environment or the owner-only secrets file above (real env wins).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | BotFather token. Never logged. |
| `TELEGRAM_GATEWAY_ENV_FILE` | no | `~/.config/opencode/telegram-gateway.env` | Owner-only secrets file path. |
| `TELEGRAM_ALLOWED_USERS` | strongly recommended | empty (deny all) | CSV of numeric Telegram user IDs. |
| `TELEGRAM_WEBHOOK_URL` | no | unset (polling) | Public https URL; enables webhook mode. |
| `TELEGRAM_WEBHOOK_SECRET` | with webhook | — | ≥32 chars, e.g. `openssl rand -hex 32`. Startup refuses without it. |
| `TELEGRAM_WEBHOOK_HOST` | no | `127.0.0.1` | Bind host. Keep loopback behind a reverse proxy. |
| `TELEGRAM_WEBHOOK_PORT` | no | `8443` | Bind port. |
| `OPENCODE_TELEGRAM_STREAM` | no | `true` | Streaming previews via message edits. |
| `OPENCODE_TELEGRAM_EDIT_INTERVAL_MS` | no | `800` | Preview edit throttle. |
| `OPENCODE_TELEGRAM_AGENT` | no | — | Agent name for Telegram sessions. |
| `OPENCODE_TELEGRAM_WORKDIR` | no | plugin location | Working directory for Telegram sessions. |
| `OPENCODE_TELEGRAM_DENIED_TOOLS` | no | `bash,edit,write,patch` | Actions set to `ask` for Telegram sessions. |
| `OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR` | no | `pair` | `pair`: reply to strangers with approval instructions; `ignore`: stay silent. |
| `OPENCODE_TELEGRAM_ADMIN_USERS` | no | empty | Admin IDs for control commands. Empty = gating OFF (all users may run all commands). Set this on shared bots. |
| `OPENCODE_TELEGRAM_USER_COMMANDS` | no | `help,whoami,status,model,models` | Commands non-admins may run when gating is ON. |
| `OPENCODE_TELEGRAM_COMMAND_MENU_MAX` | no | `60` | `/` menu entries (clamped 1..100; hidden commands still dispatch). |
| `OPENCODE_TELEGRAM_MEDIA` | no | `true` | Enable the media pipeline. |
| `OPENCODE_TELEGRAM_MAX_MEDIA_BYTES` | no | `20971520` | Hard per-file download/upload cap (1 KiB..100 MiB). |
| `OPENCODE_TELEGRAM_STT_URL` | no | — | OpenAI-compatible transcription URL; enables voice STT. |
| `OPENCODE_TELEGRAM_STT_KEY` / `_MODEL` | no | — / `whisper-1` | STT credentials/model. |
| `OPENCODE_TELEGRAM_CACHE_DIR` | no | system temp | Inbound media cache root. |
| `OPENCODE_TELEGRAM_MARKDOWN` | no | `true` | Render replies as MarkdownV2 with plain fallback. |
| `OPENCODE_TELEGRAM_FLOOD_FILE` | no | data dir | Persisted per-chat flood-window file. |
| `OPENCODE_TELEGRAM_MAX_CHARS` | no | `4000` | Outbound UTF-16 chunk size (≤4096). |

Generate a secret: `openssl rand -hex 32`.

## Security model

1. **Default-deny.** Empty allowlist authorizes nobody. There is no `allow all`
   switch. Authorization runs before any message reaches a session.
2. **Default-deny with guided approval.** An unknown sender never reaches a
   session. In `pair` mode they get a reply with a ready-to-run command; the
   operator (or the user at the terminal) runs it to add the ID to the 0600
   file, then `/reload`. One notice per sender per 10 minutes prevents spam.
   Set `OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR=ignore` for full silence.
   **Being authorized does not grant control commands** — that is a separate
   ACL (`OPENCODE_TELEGRAM_ADMIN_USERS`). Commands never reach the agent as a
   prompt; they are handled by the plugin.
3. **Fail-closed config.** Missing/malformed token, webhook URL without secret,
   short secret, or non-https URL all throw at plugin setup.
4. **Token hygiene.** Tokens are used only to build API URLs and never logged;
   every error string passes through `redact()`. Query strings are stripped.
5. **Dedup.** `update_id` receipts in durable plugin storage with a 24h TTL and
   periodic pruning prevent duplicate turns across reconnects.
6. **Least privilege.** Telegram sessions get `ask` permissions for dangerous
   actions; approval happens in the OpenCode TUI/desktop. This is the primary
   prompt-injection mitigation, since message bodies are inherently untrusted.
7. **Webhook hardening.** Constant-time secret comparison, POST+JSON only,
   1 MiB body cap enforced while reading, malformed payloads rejected without
   logging their content, and an immediate 200 so agent turns don't hold the
   request open.
8. **No ambiguous resends.** Flood waits ≤5s are awaited inline; larger waits
   and LOST/network failures surface as errors instead of retrying into a
   penalty or duplicating a message.

## Command surfaces

- **`/` menu** — registered at startup via `setMyCommands` to `default`,
  `all_private_chats`, and `all_group_chats` scopes; forum supergroups get a
  lazy per-chat scope on first message. Registration is non-fatal and skipped
  when the menu fingerprint is unchanged. The menu is a shortcut, not a gate:
  hidden commands still work when typed, and aliases resolve when typed but
  are never advertised.
- **Inline picker** — `@bot <query>` returns a searchable command list. Enable
  inline mode with BotFather `/setinline` first; until then Telegram never
  delivers inline queries. The catalog is uncapped, the first token filters,
  the remainder becomes the command argument, results are paginated 50/page,
  and unauthorized callers get an answered empty list (no catalog leak).
  Tapping a result sends `/cmd args` as a normal message, so it goes through
  the standard auth + ACL path.

## Verification (no live bot required)

```sh
bun test test/          # 20 tests: redaction, chunking, config, secrets file, event/message shapes
```

For a live smoke test: set the env vars, start OpenCode, send a message from
an allowlisted user and from a stranger (the stranger must get no reply), then
re-deliver the same `update_id` to confirm dedup.

## Limitations

- Approval is a local file edit + `/reload`, not an in-chat approval flow. To
  keep strangers fully silent, set `OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR=ignore`.
- Media: images/text/PDF are model-visible; audio/video are cached with path
  notes (enable STT for voice). No albums/batching, media tags/cover art,
  forced JPEG precompression, or TTS output. Formatting is still plain text.
- One process per bot token (Telegram forbids concurrent pollers).
- Webhook listener is plain HTTP; TLS must terminate at a reverse proxy.
- Approval prompts appear in the OpenCode TUI, not inline in Telegram.
