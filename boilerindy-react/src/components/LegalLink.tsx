import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { withFrom } from '../lib/privacyNav'

// An in-prose link from one legal page to another (Support and Delete account
// keep their sections as static JSX, outside the page's render). It passes the
// page's incoming ?from= on, so Settings → Privacy → Delete account still
// offers "Back to Settings" instead of the default back target.
export default function LegalLink({ to, children }: { to: string; children: ReactNode }) {
  const [searchParams] = useSearchParams()
  return (
    <Link to={withFrom(to, searchParams.get('from'))} className="prose-link">
      {children}
    </Link>
  )
}
