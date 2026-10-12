import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'
import SiteDisclaimer from '../components/SiteDisclaimer'
import BrandMark from '../components/BrandMark'
import Icon from '../components/Icons'
import PageTitle from '../components/PageTitle'

// Support and contact page (issue #193). Apple needs a support URL and both
// stores want a published contact for apps with user-generated content. The
// addresses match the ones Terms and Privacy already publish (Cloudflare email
// routing): support@ for help, abuse@ for reports, privacy@ for data requests.

const GITHUB_ISSUES_URL = 'https://github.com/Antoniodeoliveirasegura/boilerindy/issues'

// In-prose links: underlined, since the accent alone is too close to the body
// text colour to mark a link on its own.
const LINK_CLASS =
  'font-semibold text-[var(--color-accent)] underline decoration-[var(--color-accent)]/45 decoration-[1.5px] underline-offset-[3px] hover:decoration-[var(--color-accent)]'

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
        <a href="mailto:support@boilerindy.app" className={LINK_CLASS}>
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
        <a href={GITHUB_ISSUES_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
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
    icon: 'shield',
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
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-1)]">
      <PageTitle>Support</PageTitle>
      <div className="page flex-1 pb-12 md:pb-16">
        <div className="page-measure">
          <div className="mb-8 flex items-center gap-3 md:mb-10">
            <BrandMark size={28} />
            <span aria-hidden="true" className="h-6 w-px bg-[var(--color-border-2)]" />
            <Link
              to={back.to}
              className="-ml-1 inline-flex min-h-11 items-center rounded-[var(--radius-md)] px-2 font-display text-[13px] font-bold text-[var(--color-txt-2)] no-underline hover:text-[var(--color-txt-0)]"
            >
              {back.label}
            </Link>
          </div>
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
                  <span aria-hidden="true" className="absolute bottom-1 left-[11px] top-7 w-0.5 bg-[var(--route)]" />
                ) : null}
                <h2 className={SECTION_TITLE}>{section.title}</h2>
                <p className={SECTION_BODY}>{section.body}</p>
              </section>
            ))}
          </div>
        </div>
      </div>

      <SiteDisclaimer rule />
    </div>
  )
}
