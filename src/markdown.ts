/**
 * Markdown → Telegram MarkdownV2 conversion.
 *
 * Telegram requires backslash-escaping of every special char outside code.
 * We stash code spans/fences and links behind NUL-delimited placeholders so
 * later passes cannot re-process them, then escape the rest, then restore.
 *
 * A plain-text fallback is always available: on an entity-parse refusal the
 * caller resends the unformatted text (never on transport/5xx errors).
 */
const SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g

const ESCAPES: Record<string, string> = {
  "—": "-", "–": "-", "−": "-",
}

export function escapeMdv2(text: string): string {
  return text.replace(SPECIAL, (c) => `\\${c}`)
}

/** Convert standard markdown to MarkdownV2. Best-effort; safe for any input. */
export function toMarkdownV2(input: string): string {
  const stash = new Map<string, string>()
  let counter = 0
  const hold = (value: string): string => {
    const key = `\u0000M${counter++}\u0000`
    stash.set(key, value)
    return key
  }

  let text = String(input ?? "").replace(/[\u2010-\u2015\u2212]/g, (c) => ESCAPES[c] ?? "-")

  // Fenced code blocks: inside, only \ and ` are escaped per spec.
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const escaped = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`")
    return hold(`\`\`\`${escapeMdv2(lang)}\n${escaped}\`\`\``)
  })

  // Inline code spans (single backticks).
  text = text.replace(/`([^`\n]+)`/g, (_m, body: string) => {
    return hold(`\`${body.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``)
  })

  // Links [label](url): escape label, escape ) and \ in URL, degrade empty.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    if (!/^https?:\/\//i.test(url) && !url.startsWith("www.")) return escapeMdv2(label)
    return hold(`[${escapeMdv2(label)}](${url.replace(/[\\\)]/g, (c) => `\\${c}`)})`)
  })

  // Headers → bold line.
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_m, _hashes: string, title: string) => `*${escapeMdv2(title.replace(/\*\*/g, ""))}*`)

  // Bold / italic / strike / spoiler (processed before escaping).
  // Bold is stashed so the italic pass cannot re-process its `*...*` output.
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => hold(`*${escapeMdv2(body)}*`))
  text = text.replace(/__([^_\n]+)__/g, (_m, body: string) => hold(`*${escapeMdv2(body)}*`))
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_m, body: string) => hold(`_${escapeMdv2(body)}_`))
  text = text.replace(/~~([^~\n]+)~~/g, (_m, body: string) => hold(`~${escapeMdv2(body)}~`))
  text = text.replace(/\|\|([^|\n]+)\|\|/g, (_m, body: string) => hold(`||${escapeMdv2(body)}||`))

  // Blockquote lines keep the '>' marker unescaped.
  text = text.replace(/^(&gt;|&gt;&gt;|&gt;&gt;&gt;|>)(.*)$/gm, (_m, prefix: string, rest: string) => `${prefix} ${escapeMdv2(rest.trim())}`)

  // Everything else: escape all special chars, but leave our placeholders intact.
  text = escapeMdv2(text)

  // Restore stashed segments (insertion order = nesting-safe).
  for (const [key, value] of stash) text = text.split(key).join(value)

  // cleanup placeholder escapes: the NUL itself is not escapable so keys survive.
  return text
}

/** True when Telegram refused because of entities/markup (safe to retry plain). */
export function isParseError(error: unknown): boolean {
  const any = error as any
  if (any?.kind && any.kind !== "refused" && any.kind !== "local") return false
  const msg = String(any?.message ?? error ?? "").toLowerCase()
  return /can't parse entities|can't find end of|entity|markdown|unsupported start tag|invalid entity/i.test(msg)
}

/** MarkdownV2 char length (UTF-16) — used for chunking after formatting. */
export function mdv2Len(text: string): number {
  let n = 0
  for (const ch of text) n += ch.codePointAt(0)! > 0xffff ? 2 : 1
  return n
}
