// "Skip to main content" link (issue #221): the first focusable element on a
// page, invisible until it receives keyboard focus, so a keyboard or screen
// reader user can jump past the navbar and rails to <main id="main">, which
// carries tabIndex={-1} so the browser can move focus into it.
export default function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[3000] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-[var(--color-surface)] focus:text-[var(--color-txt-0)] focus:text-[13px] focus:font-semibold focus:shadow-[var(--shadow-xl)] focus:border focus:border-[var(--color-border)] no-underline"
    >
      Skip to main content
    </a>
  )
}
