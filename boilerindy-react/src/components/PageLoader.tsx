import Spinner from './Spinner'

// Suspense fallback shown while a lazily-loaded route chunk downloads.
// Kept intentionally tiny so it ships in the initial bundle.
export default function PageLoader() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center" role="status" aria-label="Loading">
      <Spinner />
      <span className="sr-only">Loading…</span>
    </div>
  )
}
