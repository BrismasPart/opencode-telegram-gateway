/**
 * Model picker UI: provider page → model page → switch, via inline keyboards.
 *
 * Modeled on the Hermes Telegram model picker:
 * - 10 providers/page (2 buttons/row), 8 models/page (1 button/row)
 * - 44-char label budget, shared-namespace prefix stripping, middle-elision
 * - callback_data ≤ 64 bytes; no model ids in callbacks (index into state)
 * - per-chat in-memory state; stale cards fail closed with an "expired" toast
 *
 * SECURITY: the opener is recorded at creation; only that user (or an admin)
 * may tap the picker, and taps are bound to the exact sent message id.
 */
import type { InlineKeyboardMarkup, InlineKeyboardButton } from "./telegram.js"

export const PROVIDER_PAGE_SIZE = 10
export const MODEL_PAGE_SIZE = 8
export const LABEL_BUDGET = 44
const MAX_CALLBACK_BYTES = 64

export type PickerModel = { id: string; name?: string; providerID: string }
export type PickerProvider = { slug: string; name: string; models: PickerModel[] }

export type PickerState = {
  msgId: number
  chatId: string
  sessionKey: string
  /** Resolved OpenCode session id (ses_...) for switchModel. */
  sessionID: string
  ownerId: string
  adminIds: Set<string>
  level: "providers" | "models"
  providerPage: number
  modelPage: number
  provider?: PickerProvider
  providers: PickerProvider[]
}

/** Group raw models by provider into pages of providers. */
export function groupProviders(models: PickerModel[]): PickerProvider[] {
  const groups = new Map<string, PickerModel[]>()
  for (const m of models) {
    const p = m.providerID || "unknown"
    if (!groups.has(p)) groups.set(p, [])
    groups.get(p)!.push(m)
  }
  return [...groups.entries()].map(([id, list]) => ({
    slug: id.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 12) || "p",
    name: id,
    models: list,
  })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Shorten a label to the budget, keeping the distinguishing tail. */
export function fitLabel(text: string, budget = LABEL_BUDGET): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= budget) return clean
  const head = Math.ceil((budget - 1) / 2)
  const tail = Math.floor((budget - 1) / 2)
  return `${clean.slice(0, head)}…${clean.slice(-tail)}`
}

/** Strip a shared namespace prefix across a set of model ids. */
export function stripCommonPrefix(models: PickerModel[]): string[] {
  const ids = models.map((m) => m.id)
  if (ids.length < 2) return ids
  let prefix = ids[0]
  for (const id of ids.slice(1)) {
    let i = 0
    while (i < prefix.length && i < id.length && prefix[i] === id[i]) i++
    prefix = prefix.slice(0, i)
  }
  // Cut at the last namespace separator (. or /) so labels stay short.
  const dot = prefix.lastIndexOf(".")
  const slash = prefix.lastIndexOf("/")
  const cut = Math.max(dot, slash) + 1
  return cut > 0 ? ids.map((id) => id.slice(cut)) : ids
}

function cb(data: string): string {
  // Telegram allows at most 64 bytes in callback_data.
  const bytes = new TextEncoder().encode(data)
  return bytes.length <= MAX_CALLBACK_BYTES ? data : data.slice(0, 20)
}

/** Provider page keyboard: 2 buttons/row + nav. */
export function providerKeyboard(state: PickerState): InlineKeyboardMarkup {
  const providers = state.providers
  const totalPages = Math.max(1, Math.ceil(providers.length / PROVIDER_PAGE_SIZE))
  state.providerPage = Math.min(Math.max(0, state.providerPage), totalPages - 1)
  const slice = providers.slice(state.providerPage * PROVIDER_PAGE_SIZE, (state.providerPage + 1) * PROVIDER_PAGE_SIZE)
  const rows: InlineKeyboardButton[][] = []
  for (let i = 0; i < slice.length; i += 2) {
    const row = slice.slice(i, i + 2).map((p) => ({
      text: `${p.name} (${p.models.length})`.slice(0, LABEL_BUDGET),
      callback_data: cb(`mp:${p.slug}`),
    }))
    rows.push(row)
  }
  // Only show the page row when there is more than one page.
  if (totalPages > 1) {
    const nav: InlineKeyboardButton[] = []
    if (state.providerPage > 0) nav.push({ text: "◀ Prev", callback_data: cb(`mpv:${state.providerPage - 1}`) })
    nav.push({ text: `${state.providerPage + 1}/${totalPages}`, callback_data: cb("mx:noop") })
    if (state.providerPage < totalPages - 1) nav.push({ text: "Next ▶", callback_data: cb(`mpv:${state.providerPage + 1}`) })
    rows.push(nav)
  }
  rows.push([{ text: "Cancel", callback_data: cb("mx") }])
  return { inline_keyboard: rows }
}

/** Model page keyboard: 1 button/row + nav + back/cancel. */
export function modelKeyboard(state: PickerState): InlineKeyboardMarkup {
  const provider = state.provider!
  const labels = stripCommonPrefix(provider.models)
  const totalPages = Math.max(1, Math.ceil(provider.models.length / MODEL_PAGE_SIZE))
  state.modelPage = Math.min(Math.max(0, state.modelPage), totalPages - 1)
  const start = state.modelPage * MODEL_PAGE_SIZE
  const rows: InlineKeyboardButton[][] = []
  for (let i = start; i < Math.min(start + MODEL_PAGE_SIZE, provider.models.length); i++) {
    rows.push([{ text: fitLabel(labels[i]), callback_data: cb(`mm:${i}`) }])
  }
  // Only show the page row when there is more than one page.
  if (totalPages > 1) {
    const nav: InlineKeyboardButton[] = []
    if (state.modelPage > 0) nav.push({ text: "◀ Prev", callback_data: cb(`mg:${state.modelPage - 1}`) })
    nav.push({ text: `${state.modelPage + 1}/${totalPages}`, callback_data: cb("mx:noop") })
    if (state.modelPage < totalPages - 1) nav.push({ text: "Next ▶", callback_data: cb(`mg:${state.modelPage + 1}`) })
    rows.push(nav)
  }
  rows.push([{ text: "Back", callback_data: cb("mb") }, { text: "Cancel", callback_data: cb("mx") }])
  return { inline_keyboard: rows }
}

export function providerText(state: PickerState, current: string): string {
  return `Current model: ${current}\nSelect a provider (${state.providers.length}):`
}

export function modelText(state: PickerState): string {
  const provider = state.provider!
  return `Models for ${provider.name} (${provider.models.length}):`
}

/** Resolve a model index against state, or null if out of bounds. */
export function modelAt(state: PickerState, index: number): PickerModel | null {
  return state.provider?.models[index] ?? null
}
