# OpenCode Telegram Gateway

A V2 OpenCode server plugin that relays Telegram messages to OpenCode sessions and returns replies. It runs inside `opencode serve --service` — no separate gateway process. All configuration is via environment variables. Inspired by Hermes Gateway.

## Quick start

1. Create a bot with [@BotFather](https://t.me/BotFather) and find your numeric user ID (for example with [@userinfobot](https://t.me/userinfobot)).
2. Load the plugin. Copy this directory to `.opencode/plugins/telegram-gateway/` (auto-loaded), or add it to `opencode.json(c)`:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["~/.config/opencode/plugins/opencode-telegram-gateway"]
   }
   ```

3. Write the token from your own terminal — never paste it into chat:

   ```sh
   scripts/write-secrets.sh
   ```

   The script reads the token with hidden input, writes `~/.config/opencode/telegram-gateway.env` with mode `0600`, and leaves nothing in shell history. Leave the allowlist blank to test default-deny. Real environment variables override the file.

4. Start `opencode serve --service` and message the bot. Plugin config reloads without a restart; after editing the secrets file, run `/reload` in OpenCode.

`scripts/install-service.sh` installs a `systemd --user` unit that runs the host with `Restart=always`. Run `opencode service set disabled true` first so a second server does not clash on port 4096.

Plugin setup throws if the token is missing, so create the secrets file before starting the host.

## What it does

- **Sessions** — one per DM, per group sender, or per forum topic. Isolation is configurable.
- **Media** — photos, documents, and PDFs become prompt attachments; audio and video are cached with path notes; voice notes are optionally transcribed. Outbound `MEDIA: <path>` directives upload native attachments. Paths are traversal-safe; the per-file cap is 20 MiB by default.
- **Rendering** — MarkdownV2 replies with a plain-text fallback on entity parse errors. Native Rich Messages (Bot API 10.1) render headings, tables, task lists, code fences, and math; the lane falls back to MarkdownV2 on parse errors and latches off if the method is unavailable. Streaming previews are disabled while Rich Messages are enabled.
- **Polish** — optional reactions, typing indicator, and Online/Offline bot description.
- **Authorization** — default-deny user allowlist. Unknown senders get a ready-to-run command for adding their ID, or silence with `OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR=ignore`. Control commands use a separate admin ACL.
- **Approvals** — OpenCode permission requests appear as inline-keyboard cards (Allow Once / Always / Deny) and can also be answered in the OpenCode TUI. Cards are deny-only until the full redacted command is shown; taps are bound to the opener/admin and the exact message. Pending cards auto-deny after five minutes.
- **Questions** — the agent's `question` tool renders as Telegram inline buttons (with an "Other" option for typed answers), so a blocked turn can continue from the chat. Taps are authorized and message-bound like approvals.
- **Turn serialization** — only one agent turn runs per session at a time. Two close-together messages cannot both read the same answer (prevents duplicate replies).
- **Groups** — allowed chats/topics, ignored threads, mention requirements, guest mode, and free-response chats decide when to answer. Client-split text and photo bursts merge into one turn; commands are never batched.
- **Reliability** — `update_id` dedup receipts (24h TTL), per-chat 429 cooldowns persisted to a `0600` file, and polling supervision with heartbeat, stall watchdog, and reconnect ladders. A single poller owns each token; ambiguous send failures are never blindly retried.

## Commands

`/help`, `/whoami`, `/status`, `/new`, `/stop`, `/models`, `/agent`, `/agents`, `/commands`, `/compact`, `/context`, `/effort`, `/sessions`, `/resume`. `/start` maps to `/help`; `/setagent` is an unadvertised alias for `/agent`. When an admin list is configured, `/sessions` and `/resume` are admin-only.

- `/models` opens an inline model picker (10 providers/page, 8 models/page). There is no working `/model` switch command; use the picker.
- `/sessions` lists Telegram-bound sessions; `all` lists every OpenCode session, `search <q>` filters by title. `/resume <n>` uses the last listing's index; `/resume <id>` uses a session ID.
- `/approve`, `/deny`, and bare yes/no resolve a pending approval card.

Two client-facing surfaces:

- `/` menu — registered at startup via `setMyCommands` for default, private, and group scopes, plus a lazy per-forum scope. Registration is non-fatal and skipped when the menu is unchanged. Hidden commands still dispatch when typed.
- Inline picker — `@bot <query>` searches commands. Enable inline mode with BotFather `/setinline` first. Results paginate 50/page; unauthorized callers get an empty list. Tapping a result sends `/cmd args` through the normal auth path.

## Configuration

Secrets come from the real environment or the owner-only secrets file; the environment wins. The loader accepts only `TELEGRAM_*` / `OPENCODE_TELEGRAM_*` keys and requires mode `0600` with current-user ownership. Wrong permissions or ownership fail closed.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | BotFather token. Never logged. |
| `TELEGRAM_GATEWAY_ENV_FILE` | no | `~/.config/opencode/telegram-gateway.env` | Owner-only secrets file path. |
| `TELEGRAM_ALLOWED_USERS` | strongly recommended | empty (deny all) | CSV of numeric Telegram user IDs. |
| `TELEGRAM_WEBHOOK_URL` | no | unset (polling) | Public https URL; enables webhook mode. |
| `TELEGRAM_WEBHOOK_SECRET` | with webhook | — | ≥32 chars, e.g. `openssl rand -hex 32`. Required at startup. |
| `TELEGRAM_WEBHOOK_HOST` | no | `127.0.0.1` | Bind host. Keep loopback behind a reverse proxy. |
| `TELEGRAM_WEBHOOK_PORT` | no | `8443` | Bind port. |
| `OPENCODE_TELEGRAM_STREAM` | no | `true` | Streaming previews via message edits. |
| `OPENCODE_TELEGRAM_EDIT_INTERVAL_MS` | no | `800` | Preview edit throttle. |
| `OPENCODE_TELEGRAM_AGENT` | no | — | Agent name for Telegram sessions. |
| `OPENCODE_TELEGRAM_WORKDIR` | no | plugin location | Working directory for Telegram sessions. |
| `OPENCODE_TELEGRAM_DENIED_TOOLS` | no | `bash,edit,write,patch` | Actions set to `ask` for Telegram sessions. |
| `OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR` | no | `pair` | `pair`: send approval instructions; `ignore`: stay silent. |
| `OPENCODE_TELEGRAM_ADMIN_USERS` | no | empty | Admin IDs for control commands. Empty disables gating. |
| `OPENCODE_TELEGRAM_USER_COMMANDS` | no | `help,whoami,status,models` | Commands non-admins may run when gating is on. |
| `OPENCODE_TELEGRAM_COMMAND_MENU_MAX` | no | `60` | `/` menu entries (clamped 1..100). |
| `OPENCODE_TELEGRAM_MEDIA` | no | `true` | Enable the media pipeline. |
| `OPENCODE_TELEGRAM_MAX_MEDIA_BYTES` | no | `20971520` | Per-file download/upload cap (1 KiB..100 MiB). |
| `OPENCODE_TELEGRAM_STT_URL` | no | — | OpenAI-compatible transcription URL; enables voice STT. |
| `OPENCODE_TELEGRAM_STT_KEY` / `_MODEL` | no | — / `whisper-1` | STT credentials/model. |
| `OPENCODE_TELEGRAM_CACHE_DIR` | no | system temp | Inbound media cache root. |
| `OPENCODE_TELEGRAM_MARKDOWN` | no | `true` | Render replies as MarkdownV2 with plain fallback. |
| `OPENCODE_TELEGRAM_RICH_MESSAGES` | no | `true` | Native Rich Messages for GFM constructs. |
| `OPENCODE_TELEGRAM_APPROVALS` | no | `true` | Surface permission requests as Telegram cards. |
| `OPENCODE_TELEGRAM_APPROVAL_TIMEOUT` | no | `300` | Seconds before a pending approval auto-denies (5..3600). |
| `TELEGRAM_REACTIONS` | no | `false` | 👀 while working, 👍/👎 on completion. |
| `OPENCODE_TELEGRAM_TYPING` | no | `true` | Typing indicator while the agent works. |
| `OPENCODE_TELEGRAM_STATUS_INDICATOR` | no | `false` | Flip bot short description to Online/Offline. |
| `OPENCODE_TELEGRAM_FLOOD_FILE` | no | data dir | Persisted per-chat flood-window file. |
| `OPENCODE_TELEGRAM_VISION_URL` | no | — | OpenAI-compatible vision endpoint; enables image/sticker descriptions. |
| `OPENCODE_TELEGRAM_VISION_KEY` / `_MODEL` / `_PROMPT` | no | — / `gpt-4o-mini` / `Describe this image or sticker in one short sentence.` | Vision credentials/model/prompt. |
| `OPENCODE_TELEGRAM_VISION_IMAGES` | no | `false` | Also describe ordinary images. |
| `OPENCODE_TELEGRAM_VISION_CACHE` | no | data dir | Sticker vision cache file. |
| `TELEGRAM_ALLOWED_CHATS` / `_ALLOWED_TOPICS` / `_IGNORED_THREADS` | no | empty | Group/topic trigger gates (CSV ids). |
| `TELEGRAM_REQUIRE_MENTION` / `_GUEST_MODE` / `_EXCLUSIVE_BOT_MENTIONS` | no | false / false / true | Group mention behavior. |
| `TELEGRAM_FREE_RESPONSE_CHATS` | no | empty | Chats exempt from `require_mention`. |
| `OPENCODE_TELEGRAM_TEXT_BATCH_MS` / `_MEDIA_BATCH_MS` | no | 1200 / 800 | Text/photo batch windows (0 disables). |
| `OPENCODE_TELEGRAM_GROUP_SESSIONS_PER_USER` | no | `true` | Isolate group sessions per sender. |
| `OPENCODE_TELEGRAM_THREAD_SESSIONS_PER_USER` | no | `false` | Isolate forum topic sessions per sender. |
| `OPENCODE_TELEGRAM_DM_THREADS` | no | `per_thread` | `per_thread` or `shared` (collapse DM threads). |
| `OPENCODE_TELEGRAM_MAX_CHARS` | no | `4000` | Outbound UTF-16 chunk size (≤4096). |

The shipped `.env.example` documents every setting:

```sh
cp .env.example ~/.config/opencode/telegram-gateway.env
chmod 600 ~/.config/opencode/telegram-gateway.env
```

## Security

1. **Default-deny** — an empty allowlist authorizes nobody. There is no allow-all switch, and authorization runs before any message reaches a session.
2. **Separate ACL** — being allowed to talk does not grant control commands. Set `OPENCODE_TELEGRAM_ADMIN_USERS` to enable gating; with no admin list, every authorized user may run every command. Commands never reach the agent as a prompt.
3. **Fail-closed config** — a missing or malformed token, a webhook URL without a secret, a short secret, or a non-https URL throws at plugin setup.
4. **Token hygiene** — the token is used only to build API URLs and is never logged. Error strings pass through `redact()` and query strings are stripped.
5. **Least privilege** — dangerous tools are set to `ask` for Telegram sessions. This is the main prompt-injection mitigation, since message bodies are untrusted; approval failures and timeouts deny.
6. **Webhook hardening** — constant-time secret comparison, POST+JSON only, a 1 MiB body cap enforced while reading, malformed payloads rejected without content logging, and an immediate 200 so agent turns do not hold the request open.

## Verification

```sh
bun test test/          # 89 tests: redaction, chunking, config, secrets, commands, media, rendering, gating, approvals, questions, turn queue, reliability
```

For a live smoke test: set the env vars, start OpenCode, send a message from an allowlisted user and from a stranger (by default the stranger gets only an approval notice, never a session), then re-deliver the same `update_id` to confirm dedup.

## Limitations

- Adding a user is a secrets-file edit plus `/reload` (`scripts/allow-user.sh`), not an in-chat approval flow. Set `OPENCODE_TELEGRAM_UNAUTHORIZED_BEHAVIOR=ignore` to keep strangers fully silent.
- Media: images, text, and PDFs are model-visible; audio and video are cached with path notes (enable STT for voice). No media tags/cover art, forced JPEG precompression, or TTS output.
- Rich Messages require Bot API 10.1 support. If the method is unavailable, the plugin latches back to MarkdownV2.
- One process per bot token; Telegram forbids concurrent pollers.
- The webhook listener is plain HTTP; TLS must terminate at a reverse proxy.

## License

MIT. See [LICENSE](LICENSE).
