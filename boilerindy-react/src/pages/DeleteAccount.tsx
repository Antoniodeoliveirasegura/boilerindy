import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'
import SiteDisclaimer from '../components/SiteDisclaimer'

// Account and data deletion page (issue #193). Google Play's Data Safety form
// needs a public URL where someone can ask for deletion without the app, so
// this covers both the in-app path (Settings -> Delete account, which calls
// POST /api/me/delete-account) and the privacy@boilerindy.app email fallback.
// Every per-user table cascades from public.users, so the "What gets deleted"
// list mirrors the ON DELETE CASCADE foreign keys in db/.

const DELETION_EMAIL = 'privacy@boilerindy.app'
const DELETION_SUBJECT = 'Delete my BoilerIndy account'
const DELETION_MAILTO = `mailto:${DELETION_EMAIL}?subject=${encodeURIComponent(DELETION_SUBJECT)}`

const LINK_CLASS = 'text-[var(--color-accent)] hover:underline'

const SECTIONS: { title: string; body: ReactNode }[] = [
  {
    title: 'Delete from the app',
    body: (
      <>
        Sign in, open{' '}
        <Link to="/settings" className={LINK_CLASS}>
          Settings
        </Link>
        , and use the Delete account card: enter your password, type DELETE, and confirm. Your account
        is deleted right away and you are signed out, and your Purdue link and calendar feed link stop
        working immediately. This cannot be undone. If you signed up with Google, Apple, GitHub, or
        Discord and never set a password, use the email option below instead.
      </>
    ),
  },
  {
    title: 'Delete by email',
    body: (
      <>
        You do not need the app for this. Email{' '}
        <a href={DELETION_MAILTO} className={LINK_CLASS}>
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
    body: (
      <>
        Nothing tied to your account stays in our database once it is deleted. Copies outside it age out
        on their own: server logs and database backups roll over within 30 days, and photos from your
        marketplace listings are cleared from storage by a later cleanup. Crash reports sent to Sentry
        have emails, tokens, and cookies stripped out before they are sent, and expire on Sentry&apos;s
        retention schedule. If you asked by email, we keep that email thread as a record that the
        request was handled.
      </>
    ),
  },
  {
    title: 'More about your data',
    body: (
      <>
        The{' '}
        <Link to="/privacy" className={LINK_CLASS}>
          Privacy policy
        </Link>{' '}
        explains everything BoilerIndy collects and why. For anything else, visit the{' '}
        <Link to="/support" className={LINK_CLASS}>
          support page
        </Link>
        .
      </>
    ),
  },
]

export default function DeleteAccount() {
  const [searchParams] = useSearchParams()
  const back = getBackTarget(searchParams.get('from'))

  return (
    <div className="min-h-screen bg-[var(--color-bg-1)] px-6 py-12">
      <div className="max-w-[720px] mx-auto">
        <Link to={back.to} className="text-[13px] text-[var(--color-accent)] hover:underline">
          {back.label}
        </Link>
        <h1 className="text-3xl font-bold text-[var(--color-txt-0)] mt-4 mb-2">Delete your account</h1>
        <p className="text-[13px] text-[var(--color-txt-2)] mb-8">
          You can delete your BoilerIndy account and the data tied to it at any time, from the app or by
          email.
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
