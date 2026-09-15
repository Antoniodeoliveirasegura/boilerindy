import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'
import SiteDisclaimer from '../components/SiteDisclaimer'

// Support and contact page (issue #193). Apple needs a support URL and both
// stores want a published contact for apps with user-generated content. The
// addresses match the ones Terms and Privacy already publish (Cloudflare email
// routing): support@ for help, abuse@ for reports, privacy@ for data requests.

const GITHUB_ISSUES_URL = 'https://github.com/Antoniodeoliveirasegura/boilerindy/issues'

const LINK_CLASS = 'text-[var(--color-accent)] hover:underline'

const SECTIONS: { title: string; body: ReactNode }[] = [
  {
    title: 'Email us',
    body: (
      <>
        For help with your account, the app, or anything that looks wrong, email{' '}
        <a href="mailto:support@boilerindy.app" className={LINK_CLASS}>
          support@boilerindy.app
        </a>
        . BoilerIndy is a small student project, so expect a reply within a few days.
      </>
    ),
  },
  {
    title: 'Report a bug or suggest a feature',
    body: (
      <>
        You can also{' '}
        <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          open an issue on GitHub
        </a>
        . Leave out passwords, calendar feed links, and other private details.
      </>
    ),
  },
  {
    title: 'Report abuse',
    body: (
      <>
        To report a post, listing, or user that breaks the{' '}
        <Link to="/terms" className={LINK_CLASS}>
          Terms of Service
        </Link>
        , email{' '}
        <a href="mailto:abuse@boilerindy.app" className={LINK_CLASS}>
          abuse@boilerindy.app
        </a>{' '}
        with a link or description of what you saw.
      </>
    ),
  },
  {
    title: 'Your data and your account',
    body: (
      <>
        The{' '}
        <Link to="/privacy" className={LINK_CLASS}>
          Privacy policy
        </Link>{' '}
        explains what BoilerIndy collects. To remove your account and its data, see{' '}
        <Link to="/delete-account" className={LINK_CLASS}>
          Delete your account
        </Link>
        . Privacy questions can go to{' '}
        <a href="mailto:privacy@boilerindy.app" className={LINK_CLASS}>
          privacy@boilerindy.app
        </a>
        .
      </>
    ),
  },
]

export default function Support() {
  const [searchParams] = useSearchParams()
  const back = getBackTarget(searchParams.get('from'))

  return (
    <div className="min-h-screen bg-[var(--color-bg-1)] px-6 py-12">
      <div className="max-w-[720px] mx-auto">
        <Link to={back.to} className="text-[13px] text-[var(--color-accent)] hover:underline">
          {back.label}
        </Link>
        <h1 className="text-3xl font-bold text-[var(--color-txt-0)] mt-4 mb-2">Support</h1>
        <p className="text-[13px] text-[var(--color-txt-2)] mb-8">
          Need help with BoilerIndy, found a bug, or have a question about your account? Here is how to
          reach us.
        </p>

        <div className="space-y-7">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="text-[17px] font-semibold text-[var(--color-txt-0)] mb-1.5">{section.title}</h2>
              <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)]">{section.body}</p>
            </section>
          ))}
        </div>

        <SiteDisclaimer className="mt-8" />
      </div>
    </div>
  )
}
