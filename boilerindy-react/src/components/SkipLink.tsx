// "Skip to main content" link (issue #221): the first focusable element on a
// page, invisible until it receives keyboard focus, so a keyboard or screen
// reader user can jump past the navbar and rails to <main id="main">, which
// carries tabIndex={-1} so the browser can move focus into it.
export default function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[3000] focus:px-4 focus:py-2.5 focus:rounded-[var(--radius-lg)] focus:bg-[var(--color-gold)] focus:text-[var(--color-gold-dark)] focus:font-display focus:text-[14px] focus:font-bold focus:shadow-[var(--shadow-xl)] focus:border-[1.5px] focus:border-[rgba(23,18,10,0.25)] no-underline"
    >
      Skip to main content
    </a>
  )
}
