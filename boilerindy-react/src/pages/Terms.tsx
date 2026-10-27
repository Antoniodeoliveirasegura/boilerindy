import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget, withFrom } from '../lib/privacyNav'
import { useAuth } from '../context/AuthContext'
import SiteDisclaimer from '../components/SiteDisclaimer'
import BrandMark from '../components/BrandMark'
import PageTitle from '../components/PageTitle'
import SkipLink from '../components/SkipLink'

// Terms of Service page (issue #115). Plain-language, grounded in what the app
// actually does. Contact is support@boilerindy.app. Have counsel review the
// wording before a public launch if possible.
// Issue #526 added the under-18 line, the zero-tolerance rule Apple asks apps
// with user posts to state (guideline 1.2) and the copyright complaint path.

// Reading column type: Jakarta section heads over 15px/1.6 prose.
const SECTION_TITLE = 'text-[18px] leading-[1.3] text-[var(--color-txt-0)]'
const SECTION_BODY = 'mt-2 text-[15px] leading-[1.6] text-[var(--color-txt-1)]'

const SECTIONS = [
  {
    title: 'Agreement to these terms',
    body: `By creating an account or using BoilerIndy, you agree to these Terms of Service and to
our Privacy Policy. If you do not agree, please do not use the app.`,
  },
  {
    title: 'Who can use BoilerIndy',
    body: `BoilerIndy is built for Purdue University Indianapolis students. You must be at least 13
years old to use it, and if you are under 18 you need a parent or guardian's permission. You are
responsible for keeping your account information accurate and your login secure, and for
everything that happens under your account.`,
  },
  {
    title: 'Not affiliated with Purdue',
    body: `BoilerIndy is an independent, student-built project. It is not affiliated with, endorsed
by, or sponsored by Purdue University. "Purdue" and "Boilermaker" are trademarks of Purdue
University; we use them only to describe the campus this app serves.`,
  },
  {
    title: 'Acceptable use',
    body: `Do not use BoilerIndy to break the law, harass or threaten others, post someone else's
private information, spam, upload malware, scrape or overload the service, or try to bypass its
security or access other users' data. There is zero tolerance for objectionable content and
abusive users: an automated filter and human moderation apply, and we remove content that breaks
these rules and suspend or remove the accounts behind it. You can report posts, listings and
people, and block anyone you no longer want to see. Report abuse to abuse@boilerindy.app.`,
  },
  {
    title: 'Your content',
    body: `You keep ownership of what you post - board posts, listings, recommendations, and your
profile. By posting, you grant BoilerIndy a non-exclusive license to store and display that
content so the app can show it to other students. You are responsible for what you post and must
have the right to share it. We may hide or remove content at our discretion (for example, for
policy violations); content you delete is hidden immediately.`,
  },
  {
    title: 'Buying, selling, and connecting with others',
    body: `Features like Marketplace, Perks, Lost & Found, and Friend Matching simply connect
students. BoilerIndy is not a party to any transaction or arrangement and does not verify
listings, items, deals, or users. Meet safely, use your judgment, and interact at your own risk.
Contact details you choose to share (such as your Purdue email) become visible to signed-in
students.`,
  },
  {
    title: 'Your schedule and connected sources',
    body: `You connect your own calendar feeds, and you are responsible for the feed URLs you
provide and for having the right to use them. Campus information shown in the app (schedule,
dining, transit, maps, events) may be delayed, incomplete, or inaccurate - do not rely on it as
the sole source for anything important.`,
  },
  {
    title: 'AI features',
    body: `The Campus Assistant and other AI features can be wrong or incomplete. Do not rely on
them for academic, financial, medical, legal, or safety decisions. See the Privacy Policy for
what data is sent to power them.`,
  },
  {
    title: 'Intellectual property',
    body: `The BoilerIndy name, design, and original content belong to us or our licensors.
Purdue's trademarks belong to Purdue. Do not copy, resell, or misuse the app or its branding.
Trademark or other intellectual-property concerns: legal@boilerindy.app.`,
  },
  {
    title: 'Copyright complaints',
    body: `If you believe something on BoilerIndy infringes your copyright, email legal@boilerindy.app
with: the work you believe is infringed; where it appears on BoilerIndy (a link or a
description); your name and contact details; a statement that you believe in good faith the use
is not authorized by you, your agent, or the law; and a statement that your notice is accurate
and, under penalty of perjury, that you own the work or may act for its owner, signed with your
full name. When a notice is complete we remove the content and tell the person who posted it. If
your content was removed and you believe that was a mistake, reply to that email. We remove the
accounts of people who repeatedly post content that infringes others' rights.`,
  },
  {
    title: 'Service provided "as is"',
    body: `BoilerIndy is a free student project provided "as is" and "as available," without
warranties of any kind. We do not guarantee that it will be accurate, secure, uninterrupted, or
error-free.`,
  },
  {
    title: 'Limitation of liability',
    body: `To the fullest extent allowed by law, BoilerIndy and the people who build it are not
liable for any indirect, incidental, or consequential damages, or for any loss arising from your
use of the app, the sources you connect, or interactions and transactions with other students.`,
  },
  {
    title: 'Suspension and termination',
    body: `We may suspend or remove accounts that violate these terms or harm the service or its
users. You can stop using BoilerIndy and delete your account at any time.`,
  },
  {
    title: 'Changes to these terms',
    body: `We may update these terms as the app evolves. We will update the date at the top of this
page, and continued use after a change means you accept the updated terms.`,
  },
  {
    title: 'Governing law',
    body: `These terms are governed by the laws of the State of Indiana, without regard to its
conflict-of-laws rules.`,
  },
  {
    title: 'Contact',
    body: `Questions about these terms? Email support@boilerindy.app, or open an issue on the
BoilerIndy GitHub repository.`,
    link: { to: '/support', label: 'Contact support' },
  },
]

export default function Terms() {
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const from = searchParams.get('from')
  const back = getBackTarget(from, Boolean(user))

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-1)]">
      {/* This page renders outside AppLayout and PublicLayout, so it
          carries its own skip link and main landmark (issue #221). */}
      <SkipLink />
      <PageTitle>Terms of Service</PageTitle>
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
              <h1 className="page-title">Terms of Service</h1>
              <p className="page-sub">
                Last updated October 27, 2026. The short version: BoilerIndy is a free, independent student
                app for Purdue Indianapolis - be respectful, don't misuse it, campus data may be
                imperfect, and it's provided as-is.
              </p>
            </div>
          </div>
          <div className="card card-pad r-ink -mx-4 rounded-none border-x-0 sm:mx-0 sm:rounded-[var(--radius-xl)] sm:border-x sm:p-8">
            {SECTIONS.map((section, index) => (
              <section key={section.title} className="relative pb-8 pl-10 last:pb-0 sm:pl-12">
                <span
                  aria-hidden="true"
                  className="route-badge sm absolute left-0 top-0 font-display text-[11px] font-extrabold tnum"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                {index < SECTIONS.length - 1 ? (
                  <span aria-hidden="true" className="absolute bottom-0 left-[11px] top-6 w-0.5 bg-[var(--route)]" />
                ) : null}
                <h2 className={SECTION_TITLE}>{section.title}</h2>
                <p className={SECTION_BODY}>{section.body}</p>
                {section.link ? (
                  <Link to={withFrom(section.link.to, from)} className="prose-link mt-2 inline-block text-[15px]">
                    {section.link.label}
                  </Link>
                ) : null}
              </section>
            ))}
          </div>
        </div>
      </main>

      <SiteDisclaimer rule from={from} />
    </div>
  )
}
