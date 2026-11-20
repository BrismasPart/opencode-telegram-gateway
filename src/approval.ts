/**
 * Exec approval bridge: surface OpenCode's native permission requests in
 * Telegram as inline-keyboard cards, and resolve them via ctx.permission.reply.
 *
 * Hermes-style security properties:
 * - Born Deny-only: Approve is offered only when the whole (redacted) command
 *   is provably visible — in the card or in a document sent ahead of it.
 * - callback_data carries only `ea:<choice>:<id>` (no command, no secret).
 * - Tap authorization: allowlist + opener/admin, bound to the exact message,
 *   single-claim (a second tap gets "already resolved").
 * - Fail closed: timeout / interrupt / any error → reject (command does not run).
 * - Typed /approve, /deny and bare yes/no work ONLY while a request is pending.
 */
import { redact } from "./redact.js"

export type ApprovalChoice = "once" | "always" | "deny"

export type ApprovalState = {
  id: string
  sessionID: string
  requestID: string
  chatId: string
  ownerId: string
  adminIds: Set<string>
  messageId: number
  /** False until the whole command is proven delivered → Deny-only card. */
  canApprove: boolean
  action: string
  command: string
  /** Location from the permission.asked event — reply must be scoped to it. */
  location?: { directory?: string; workspaceID?: string }
  resolved: boolean
  timer?: ReturnType<typeof setTimeout>
}

export type PendingApproval = {
  sessionID: string
  requestID: string
  ownerId: string
  chatId: string
}

let counter = 0
export function newApprovalId(): string {
  return String(++counter)
}

/** Choices for a card. Deny always; approve only when whole command is shown. */
export function approvalChoices(canApprove: boolean): ApprovalChoice[] {
  return canApprove ? ["once", "always", "deny"] : ["deny"]
}

export function approvalText(state: ApprovalState, context?: string): string {
  const head = `🔒 Approval required\nAction: ${state.action}`
  // The agent's explanation belongs in the card, so the human decides with
  // full context — not in a separate message that arrives afterwards.
  const why = context ? `\n\n${escapeHtml(redact(context, ""))}` : ""
  const cmdBlock = state.command
    ? `\n\n<pre>${escapeHtml(redact(state.command, ""))}</pre>`
    : ""
  const note = state.canApprove
    ? "\n\nApprove only if you understand this command."
    : "\n\n⚠️ Command too long to show here — full command attached above. Deny only until confirmed."
  return head + why + cmdBlock + note
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Bare approval words, only honored while a request is pending. */
export function approvalWord(text: string): ApprovalChoice | null {
  const t = text.trim().toLowerCase()
  if (["yes", "y", "approve", "👍", "once"].includes(t)) return "once"
  if (["always"].includes(t)) return "always"
  if (["no", "n", "deny", "reject", "👎"].includes(t)) return "deny"
  return null
}

export function decisionFor(choice: ApprovalChoice): "once" | "always" | "reject" {
  return choice === "deny" ? "reject" : choice
}
