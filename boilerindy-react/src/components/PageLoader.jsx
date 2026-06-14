// Suspense fallback shown while a lazily-loaded route chunk downloads.
// Kept intentionally tiny so it ships in the initial bundle.
export default function PageLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-label="Loading">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-40" />
      <span className="sr-only">Loading…</span>
    </div>
  )
}
