/**
 * Native Rich Messages lane (Bot API 10.1).
 *
 * Rich messages accept RAW GFM-style markdown (headings, tables, task lists,
 * code fences, LaTeX) up to 32768 UTF-8 characters. When the text contains a
 * construct MarkdownV2 degrades badly, we send it via `sendRichMessage` so
 * Telegram renders it natively. Otherwise we fall back to MarkdownV2.
 *
 * Capability errors (method not found) latch the lane off for the whole run;
 * per-message parse errors fall back to MarkdownV2 just for that reply.
 */
const RICH_MAX_UTF8 = 32_768

/** Constructs that benefit from native rich rendering over MarkdownV2. */
export function needsRich(text: string): boolean {
  return /^\s*#{1,6}\s/m.test(text)               // headings
    || /^\s*\|.*\|/m.test(text)                   // pipe tables
    || /^\s*[-*+]\s+\[[ xX]\]/m.test(text)        // task lists
    || /\$\$[\s\S]+?\$\$/.test(text)              // block math
    || /<details[\s>]/i.test(text)                // collapsible blocks
    || /^\s*```/m.test(text)                      // fenced code
}

/** UTF-8 byte length (rich limit is in UTF-8 chars, not UTF-16). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function richFits(text: string): boolean {
  return utf8Bytes(text) <= RICH_MAX_UTF8
}

/** Decide whether to use the rich lane for a reply. */
export function shouldUseRich(text: string, enabled: boolean, disabled: boolean): boolean {
  return enabled && !disabled && richFits(text) && needsRich(text)
}
