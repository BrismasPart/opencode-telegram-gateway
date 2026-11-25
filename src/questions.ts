/**
 * Question bridge: render OpenCode's `question` tool (session forms) as
 * Telegram inline keyboards so a blocked turn can continue.
 *
 * Hermes-style properties:
 * - Only fields with discrete `options` are rendered as buttons; free-text
 *   fields fall back to a typed answer (the next message is captured).
 * - callback_data carries only `qf:<id>:<key>:<valueIndex>` — no secrets and
 *   no raw values; the answer is resolved from the form state.
 * - Tap authorization: allowlist + opener/admin, bound to the exact message.
 * - Answered elsewhere (TUI) or cancelled → drop our state; stale cards fail
 *   closed with an "expired" toast.
 */
export type FormOption = { value: string; label: string; description?: string }
export type FormField = {
  key: string
  type: string
  title?: string
  description?: string
  options?: FormOption[]
  required?: boolean
}
export type FormInfo = {
  id: string
  sessionID: string
  title: string
  fields: FormField[]
}

export type QuestionState = {
  id: string
  sessionID: string
  formID: string
  chatId: string
  ownerId: string
  adminIds: Set<string>
  messageId: number
  form: FormInfo
  location?: { directory?: string; workspaceID?: string }
  answers: Record<string, unknown>
  resolved: boolean
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Build the Telegram text for a form (one field at a time, discrete options). */
export function questionText(state: QuestionState, fieldIndex = 0): string {
  const f = state.form.fields[fieldIndex]
  if (!f) return esc(state.form.title)
  const lines = [`❓ ${esc(state.form.title)}`, ""]
  if (f.title) lines.push(esc(f.title))
  if (f.description) lines.push(esc(f.description))
  lines.push("", `Choose for: ${esc(f.key)}`)
  return lines.join("\n")
}

/** Build an inline keyboard for a single field's options. */
export function questionKeyboard(state: QuestionState, fieldIndex = 0) {
  const f = state.form.fields[fieldIndex]
  const opts = f?.options ?? []
  const rows: Array<Array<{ text: string; callback_data: string }>> = []
  for (const o of opts.slice(0, 20)) {
    rows.push([{ text: o.label.slice(0, 60), callback_data: `qf:${state.id}:${fieldIndex}:${opts.indexOf(o)}` }])
  }
  // "Other" lets the user type a free-form answer for this field.
  if (f && (f.type === "string" || f.type === "multiselect" || f.type === "number" || f.type === "integer")) {
    rows.push([{ text: "✏️ Other (type answer)", callback_data: `qf:${state.id}:${fieldIndex}:other` }])
  }
  rows.push([{ text: "Cancel", callback_data: `qf:${state.id}:cancel` }])
  return { inline_keyboard: rows }
}

/** Resolve a button tap to a field + option value. */
export function optionAt(state: QuestionState, fieldIndex: number, optionIndex: number): FormOption | null {
  return state.form.fields[fieldIndex]?.options?.[optionIndex] ?? null
}

/** Apply a typed free-form answer to a field. */
export function applyTyped(state: QuestionState, fieldIndex: number, value: string): boolean {
  const f = state.form.fields[fieldIndex]
  if (!f) return false
  state.answers[f.key] = value
  return true
}
