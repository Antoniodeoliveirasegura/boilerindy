import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'
import { useAuth } from '../context/AuthContext'
import SiteDisclaimer from '../components/SiteDisclaimer'
import BrandMark from '../components/BrandMark'
import Icon from '../components/Icons'
import PageTitle from '../components/PageTitle'
import SkipLink from '../components/SkipLink'
import LegalLink from '../components/LegalLink'

// Support and contact page (issue #193). Apple needs a support URL and both
// stores want a published contact for apps with user-generated content. The
// addresses match the ones Terms and Privacy already publish (Cloudflare email
// routing): support@ for help, abuse@ for reports, privacy@ for data requests.

const GITHUB_ISSUES_URL = 'https://github.com/Antoniodeoliveirasegura/boilerindy/issues'

// Reading column type: Jakarta section heads over 15px/1.6 prose.
const SECTION_TITLE = 'text-[18px] leading-[1.3] text-[var(--color-txt-0)]'
const SECTION_BODY = 'mt-2 text-[15px] leading-[1.6] text-[var(--color-txt-1)]'

// Each section's icon is its stop on the route line down the page.
const SECTIONS: { title: string; icon: string; body: ReactNode }[] = [
  {
    title: 'Email us',
    icon: 'mail',
    body: (
      <>
        For help with your account, the app, or anything that looks wrong, email{' '}
        <a href="mailto:support@boilerindy.app" className="prose-link">
          support@boilerindy.app
        </a>
        . BoilerIndy is a small student project, so expect a reply within a few days.
      </>
    ),
  },
  {
    title: 'Report a bug or suggest a feature',
    icon: 'github',
    body: (
      <>
        You can also{' '}
        <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className="prose-link">
          open an issue on GitHub
        </a>
        . Leave out passwords, calendar feed links, and other private details.
      </>
    ),
  },
  {
    title: 'Report abuse',
    icon: 'flag',
    body: (
      <>
        To report a post, listing, or user that breaks the{' '}
        <LegalLink to="/terms">
          Terms of Service
        </LegalLink>
        , email{' '}
        <a href="mailto:abuse@boilerindy.app" className="prose-link">
          abuse@boilerindy.app
        </a>{' '}
        with a link or description of what you saw.
      </>
    ),
  },
  {
    title: 'Your data and your account',
    icon: 'shield',
    body: (
      <>
        The{' '}
        <LegalLink to="/privacy">
          Privacy policy
        </LegalLink>{' '}
        explains what BoilerIndy collects. To remove your account and its data, see{' '}
        <LegalLink to="/delete-account">
          Delete your account
        </LegalLink>
        . Privacy questions can go to{' '}
        <a href="mailto:privacy@boilerindy.app" className="prose-link">
          privacy@boilerindy.app
        </a>
        .
      </>
    ),
  },
]

export default function Support() {
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const from = searchParams.get('from')
  const back = getBackTarget(from, Boolean(user))

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-1)]">
      {/* This page renders outside AppLayout and PublicLayout, so it
          carries its own skip link and main landmark (issue #221). */}
      <SkipLink />
      <PageTitle>Support</PageTitle>
      {/* The signed-out signage band (as on the landing and the preview
          bar): the mark, a divider and the way back, on the app's 1200px
          column at the navbar's height. */}
      <header className="topbar h-14 md:h-16">
        <div className="mx-auto flex h-full max-w-[1200px] items-center px-4 md:px-6">
          <BrandMark size={32} />
          <span aria-hidden="true" className="topbar-divider" />
          <Link
            to={back.to}
            className="inline-flex min-h-11 items-center rounded-[var(--radius-md)] px-2 font-display text-[14px] font-bold text-[var(--color-txt-2)] no-underline hover:text-[var(--color-txt-0)]"
          >
            {back.label}
          </Link>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="page flex-1 pb-12 md:pb-16 focus:outline-none">
        <div className="page-measure">
          <div className="page-head">
            <div>
              <h1 className="page-title">Support</h1>
              <p className="page-sub">
                Need help with BoilerIndy, found a bug, or have a question about your account? Here is how to
                reach us.
              </p>
            </div>
          </div>
          <div className="card card-pad r-ink -mx-4 rounded-none border-x-0 sm:mx-0 sm:rounded-[var(--radius-xl)] sm:border-x sm:p-8">
            {SECTIONS.map((section, index) => (
              <section key={section.title} className="relative pb-8 pl-10 last:pb-0 sm:pl-12">
                <span aria-hidden="true" className="route-badge sm absolute left-0 top-0">
                  <Icon name={section.icon} />
                </span>
                {index < SECTIONS.length - 1 ? (
                  <span aria-hidden="true" className="absolute bottom-0 left-[11px] top-6 w-0.5 bg-[var(--route)]" />
                ) : null}
                <h2 className={SECTION_TITLE}>{section.title}</h2>
                <p className={SECTION_BODY}>{section.body}</p>
              </section>
            ))}
          </div>
        </div>
      </main>

      <SiteDisclaimer rule from={from} />
    </div>
  )
}
