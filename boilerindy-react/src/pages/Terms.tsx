import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'
import SiteDisclaimer from '../components/SiteDisclaimer'

// Terms of Service page (issue #115). Plain-language, grounded in what the app
// actually does. Contact is support@boilerindy.app. Have counsel review the
// wording before a public launch if possible.

const SECTIONS = [
  {
    title: 'Agreement to these terms',
    body: `By creating an account or using BoilerIndy, you agree to these Terms of Service and to
our Privacy Policy. If you do not agree, please do not use the app.`,
  },
  {
    title: 'Who can use BoilerIndy',
    body: `BoilerIndy is built for Purdue University Indianapolis students. You must be at least 13
years old to use it. You are responsible for keeping your account information accurate and your
login secure, and for everything that happens under your account.`,
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
security or access other users' data. Keep posts civil - an automated filter and human moderation
apply, and we may remove content or accounts that violate these rules. Report abuse to
abuse@boilerindy.app.`,
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
    body: `We may update these terms as the app evolves. We will update the date below, and
continued use after a change means you accept the updated terms.`,
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
  },
]

export default function Terms() {
  const [searchParams] = useSearchParams()
  const back = getBackTarget(searchParams.get('from'))

  return (
    <div className="min-h-screen bg-[var(--color-bg-1)] px-6 py-12">
      <div className="max-w-[720px] mx-auto">
        <Link to={back.to} className="text-[13px] text-[var(--color-accent)] hover:underline">
          {back.label}
        </Link>
        <h1 className="text-3xl font-bold text-[var(--color-txt-0)] mt-4 mb-2">Terms of Service</h1>
        <p className="text-[13px] text-[var(--color-txt-2)] mb-8">
          Last updated July 16, 2026. The short version: BoilerIndy is a free, independent student
          app for Purdue Indianapolis - be respectful, don't misuse it, campus data may be
          imperfect, and it's provided as-is.
        </p>

        <div className="space-y-7">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="text-[17px] font-semibold text-[var(--color-txt-0)] mb-1.5">{section.title}</h2>
              <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)] whitespace-pre-line">{section.body}</p>
            </section>
          ))}
        </div>

        <SiteDisclaimer className="mt-8" />
      </div>
    </div>
  )
}
