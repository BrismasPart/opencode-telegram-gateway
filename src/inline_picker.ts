/**
 * Inline options picker: `@botname <query>` → searchable command list.
 *
 * Prerequisite: the bot owner must enable inline mode via BotFather /setinline.
 * Security: inline queries can come from any chat and carry no chat context.
 * We authorize on user identity alone against the SAME allowlist used for
 * normal messages, and fail closed with an empty (but answered) result list —
 * the command catalog is never leaked to strangers.
 *
 * Behavior mirrors the Hermes inline picker: uncapped catalog, first token
 * filters, remainder becomes the command argument, 50 results/page, prefix >
 * name-substring > description ranking, cache_time=10, is_personal=true.
 */
import { COMMAND_CATALOG, type CommandDef } from "./commands.js"
import type { InlineResult } from "./telegram.js"

export const PAGE_SIZE = 50
export const CACHE_TIME_SECONDS = 10

/** Compare with hyphens and underscores treated as equivalent. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[-_]/g, "")
}

/** Rank: prefix (0) > name substring (1) > description (2) > no match (-1). */
export function rank(def: CommandDef, needle: string): number {
  if (!needle) return 0
  const n = norm(needle)
  const name = norm(def.name)
  const desc = norm(def.description)
  if (name.startsWith(n)) return 0
  if (name.includes(n)) return 1
  if (desc.includes(n)) return 2
  return -1
}

export function filterCatalog(query: string, catalog: CommandDef[] = COMMAND_CATALOG): CommandDef[] {
  const needle = query.trim()
  if (!needle) return [...catalog]
  return catalog
    .map((def) => ({ def, r: rank(def, needle) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.def)
}

export type InlinePage = {
  results: InlineResult[]
  nextOffset?: string
}

/**
 * Build a page. The first whitespace token filters; the rest is the argument
 * sent with the command when a result is tapped. Tapping produces a normal
 * `/cmd args` message, so it flows through the standard auth + ACL path.
 */
export function buildInlinePage(
  query: string,
  offset: string,
  pageSize: number = PAGE_SIZE,
  catalog: CommandDef[] = COMMAND_CATALOG,
): InlinePage {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  const filterToken = tokens[0] ?? ""
  const args = tokens.slice(1).join(" ")
  const matched = filterCatalog(filterToken, catalog)

  const start = Math.max(0, Number.parseInt(offset, 10) || 0)
  const page = matched.slice(start, start + pageSize)
  const results: InlineResult[] = page.map((def) => ({
    type: "article",
    id: `cmd_${def.name}`,
    title: `/${def.name}`,
    description: def.description,
    input_message_content: { message_text: args ? `/${def.name} ${args}` : `/${def.name}` },
  }))
  const next = start + pageSize < matched.length ? String(start + pageSize) : undefined
  return { results, nextOffset: next }
}

/** Empty but answered — the fail-closed response for unauthorized callers. */
export function emptyResults(): InlineResult[] {
  return []
}
