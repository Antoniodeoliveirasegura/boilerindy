import type { ReactNode } from 'react'

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
}

// Something that starts like a tag: `<` then a letter, `/`, `!` or `?`. A bare
// `<` in prose ("under $5 &lt; $8") is not one and is kept.
const TAG_RE = /<\/?[a-z!?][^>]*>/gi

/**
 * Strip HTML tags and decode common entities, returning plain text (issue #295).
 *
 * Order matters. Entities decode first, in one left-to-right pass, so doubly
 * escaped input unescapes exactly once (`&amp;lt;` stays `&lt;`) and markup a
 * feed escaped (`&lt;b&gt;Free pizza&lt;/b&gt;`) is removed with the real tags
 * instead of showing up as brackets. Tags are then stripped until nothing
 * changes, so a nested fragment like `<scr<b>ipt>` cannot reassemble into a tag.
 * The result is plain text for React to render; it is not an HTML sanitizer.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  let s = html
    .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
  let previous: string
  do {
    previous = s
    s = s.replace(TAG_RE, '')
  } while (s !== previous)
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Clean AI-generated text: strip markdown formatting the model sometimes adds.
 */
export function cleanAiText(text: unknown): string {
  if (text == null || text === '') return ''
  const s = typeof text === 'string' ? text : String(text)
  return s
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[\s]*[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Turn raw text with http(s) URLs into React nodes with clickable, wrapping links.
 */
export function linkifyText(
  text: string | null | undefined,
  { maxDisplayLength = 80 }: { maxDisplayLength?: number } = {},
): ReactNode {
  if (text == null || text === '') return null

  const urlRegex = /(https?:\/\/[^\s<]+)/gi
  const parts = text.split(urlRegex)

  return parts.map((part, i) => {
    const isUrl = /^https?:\/\//i.test(part)
    if (!isUrl) {
      return (
        <span key={i} className="whitespace-pre-wrap break-words">
          {part}
        </span>
      )
    }
    const display =
      maxDisplayLength > 0 && part.length > maxDisplayLength
        ? `${part.slice(0, maxDisplayLength)}…`
        : part
    return (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-accent)] hover:underline break-all [overflow-wrap:anywhere] align-baseline"
      >
        {display}
      </a>
    )
  })
}
