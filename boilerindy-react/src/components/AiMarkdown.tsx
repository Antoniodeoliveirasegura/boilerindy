import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

/**
 * Renders an AI reply as styled markdown.
 *
 * Every AI surface used to dump the model's raw text into a `whitespace-pre-wrap`
 * div, so Gemini's markdown showed up as literal `**asterisks**` and `###`. The
 * page panels ran it through cleanAiText() instead, which deleted the bullet
 * markers outright and flattened structured answers into a wall of lines. Both
 * are replaced by this component.
 *
 * react-markdown does not render raw HTML unless you opt in, so model output
 * cannot inject markup here.
 */

type Props = {
  children: string | null | undefined
  /** Matches the host bubble/panel; AI text is 12-13px across the app. */
  className?: string
}

function Anchor({ href, children }: ComponentPropsWithoutRef<'a'>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--color-accent)] underline underline-offset-2 break-words [overflow-wrap:anywhere]"
    >
      {children}
    </a>
  )
}

// Tight vertical rhythm: these render inside small chat bubbles and dashboard
// cards, where prose-sized margins look broken.
const components = {
  a: Anchor,
  p: ({ children }: { children?: ReactNode }) => <p className="m-0">{children}</p>,
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="m-0 list-disc pl-[1.1em] space-y-1 marker:text-[var(--color-txt-3)]">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="m-0 list-decimal pl-[1.25em] space-y-1 marker:text-[var(--color-txt-3)]">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li className="m-0">{children}</li>,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold text-[var(--color-txt-0)]">{children}</strong>
  ),
  em: ({ children }: { children?: ReactNode }) => <em className="italic">{children}</em>,
  h1: ({ children }: { children?: ReactNode }) => (
    <h3 className="m-0 text-[13px] font-semibold text-[var(--color-txt-0)]">{children}</h3>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h3 className="m-0 text-[13px] font-semibold text-[var(--color-txt-0)]">{children}</h3>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="m-0 text-[13px] font-semibold text-[var(--color-txt-0)]">{children}</h3>
  ),
  hr: () => <hr className="my-1 border-0 border-t border-[var(--color-border)]" />,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="m-0 border-l-2 border-[var(--color-border-2)] pl-3 text-[var(--color-txt-2)]">
      {children}
    </blockquote>
  ),
  code: ({ children }: { children?: ReactNode }) => (
    <code className="rounded bg-[var(--color-stat)] px-1 py-0.5 text-[0.92em]">{children}</code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="m-0 overflow-x-auto rounded-lg bg-[var(--color-stat)] p-2 text-[0.92em]">{children}</pre>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="border-b border-[var(--color-border)] py-1 pr-3 font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="border-b border-[var(--color-border)] py-1 pr-3 align-top">{children}</td>
  ),
}

export default function AiMarkdown({ children, className = '' }: Props) {
  if (!children) return null
  return (
    <div className={`space-y-2 leading-relaxed break-words ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
