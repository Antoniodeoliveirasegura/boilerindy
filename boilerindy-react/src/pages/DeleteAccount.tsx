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

// Account and data deletion page (issue #193). Google Play's Data Safety form
// needs a public URL where someone can ask for deletion without the app, so
// this covers both the in-app path (Settings -> Delete account, which calls
// POST /api/me/delete-account) and the privacy@boilerindy.app email fallback.
// Every per-user table cascades from public.users, so the "What gets deleted"
// list mirrors the ON DELETE CASCADE foreign keys in db/.

const DELETION_EMAIL = 'privacy@boilerindy.app'
const DELETION_SUBJECT = 'Delete my BoilerIndy account'
const DELETION_MAILTO = `mailto:${DELETION_EMAIL}?subject=${encodeURIComponent(DELETION_SUBJECT)}`

// Reading column type: Jakarta section heads over 15px/1.6 prose.
const SECTION_TITLE = 'text-[18px] leading-[1.3] text-[var(--color-txt-0)]'
const SECTION_BODY = 'mt-2 text-[15px] leading-[1.6] text-[var(--color-txt-1)]'

// Each section's icon is its stop on the route line down the page.
const SECTIONS: { title: string; icon: string; body: ReactNode }[] = [
  {
    title: 'Delete from the app',
    icon: 'settings',
    body: (
      <>
        Sign in, open{' '}
        <Link to="/settings" className="prose-link">
          Settings
        </Link>
        , and use the Delete account card: enter your password, type DELETE, and confirm. Your account
        is deleted right away and you are signed out, and your Purdue link and calendar feed link stop
        working immediately. This cannot be undone. If you signed up with a sign-in provider such as
        Google and never set a password, choose Confirm with Google instead of entering one.
      </>
    ),
  },
  {
    title: 'Delete by email',
    icon: 'mail',
    body: (
      <>
        You do not need the app for this. Email{' '}
        <a href={DELETION_MAILTO} className="prose-link">
          {DELETION_EMAIL}
        </a>{' '}
        from the email address on your BoilerIndy account with the subject &ldquo;{DELETION_SUBJECT}
        &rdquo;. Sending from that address is how we know the request is yours; if you can no longer
        use it, say so in the email and we will find another way to confirm the account. We delete the
        account within 30 days and reply to let you know when it is done.
      </>
    ),
  },
  {
    title: 'What gets deleted',
    icon: 'trash',
    body: (
      <>
        Deleting your account removes your profile (name, email, avatar, and Purdue link), your linked
        calendar sources and the events imported from them, your tasks, the grades you entered, your
        calendar feed link, notification subscriptions, saved preferences, and your usage analytics
        events. Everything you posted is removed too: board posts and replies, marketplace listings,
        lost &amp; found reports, guide posts, study groups, and your friend profile.
      </>
    ),
  },
  {
    title: 'What we keep',
    icon: 'lock',
    body: (
      <>
        Nothing tied to your account stays in our database once it is deleted. A few copies outside it
        take longer to go. Server logs and database backups roll over within 30 days. Photos you
        uploaded to marketplace listings are not removed from storage the moment you delete: they can
        stay reachable at their direct link until we run our storage cleanup, which removes photos no
        listing uses. Crash reports sent to Sentry have emails, tokens, and cookies stripped out before
        they are sent, and expire on Sentry&apos;s retention schedule. If you asked by email, we keep
        that email thread as a record that the request was handled.
      </>
    ),
  },
  {
    title: 'More about your data',
    icon: 'document',
    body: (
      <>
        The{' '}
        <LegalLink to="/privacy">
          Privacy policy
        </LegalLink>{' '}
        explains everything BoilerIndy collects and why. For anything else, visit the{' '}
        <LegalLink to="/support">
          support page
        </LegalLink>
        .
      </>
    ),
  },
]

export default function DeleteAccount() {
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const from = searchParams.get('from')
  const back = getBackTarget(from, Boolean(user))

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-1)]">
      {/* This page renders outside AppLayout and PublicLayout, so it
          carries its own skip link and main landmark (issue #221). */}
      <SkipLink />
      <PageTitle>Delete your account</PageTitle>
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
              <h1 className="page-title">Delete your account</h1>
              <p className="page-sub">
                You can delete your BoilerIndy account and the data tied to it at any time, from the app or by
                email.
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
