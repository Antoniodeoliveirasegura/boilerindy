import type { ReactNode } from 'react'

/**
 * Strip HTML tags and decode common entities, returning plain text.
 */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// cleanAiText() lived here and stripped the markdown Gemini returns - including
// the bullet markers - which is what flattened structured answers into a wall of
// text. AI replies now render through components/AiMarkdown.tsx instead.

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
