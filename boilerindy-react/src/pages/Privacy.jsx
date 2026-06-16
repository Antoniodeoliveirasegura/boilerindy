import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'

// Privacy policy page (issue #51). DRAFT — the wording below is the agent
// draft for the owner to review before analytics ships to production (the
// issue's human checkpoint). Update "Last updated" when the text is approved.

const SECTIONS = [
  {
    title: 'What we collect',
    body: `When you are signed in, BoilerIndy records basic product usage events — things like
"viewed the dining page", "completed a task", or "created a board post" — together with the
in-app page path and the time. Events come from a fixed allowlist; we never record free-form
text, your messages, your schedule contents, your grades, or your location.`,
  },
  {
    title: 'Where it goes',
    body: `Events are stored in BoilerIndy's own database (Supabase). We use no third-party
analytics or advertising trackers — no Google Analytics, no Meta pixel, nothing. Your usage
data is never sold or shared with advertisers; advertisers on BoilerIndy only ever see
aggregate impression and tap counts for their own campaigns.`,
  },
  {
    title: 'Why we collect it',
    body: `Usage analytics tell us which features students actually use so we can prioritize
what to build and fix. That's it.`,
  },
  {
    title: 'Your choices',
    body: `You can opt out at any time in Settings → Privacy. Opting out takes effect
immediately — your device stops sending events. If you delete your account, all of your
analytics events are deleted with it.`,
  },
  {
    title: 'Retention',
    body: `Raw analytics events are kept for at most 12 months and then deleted.`,
  },
  {
    title: 'Authentication & cookies',
    body: `BoilerIndy uses a session cookie to keep you signed in and Supabase for
authentication. We do not use cookies for advertising or cross-site tracking.`,
  },
  {
    title: 'Contact',
    body: `Questions about this policy? Reach out via the campus board or the contact listed
on the BoilerIndy GitHub repository.`,
  },
]

export default function Privacy() {
  const [searchParams] = useSearchParams()
  const back = getBackTarget(searchParams.get('from'))

  return (
    <div className="min-h-screen bg-[var(--color-bg-1)] px-6 py-12">
      <div className="max-w-[720px] mx-auto">
        <Link to={back.to} className="text-[13px] text-[var(--color-accent)] hover:underline">
          {back.label}
        </Link>
        <h1 className="text-3xl font-bold text-[var(--color-txt-0)] mt-4 mb-2">Privacy policy</h1>
        <p className="text-[13px] text-[var(--color-txt-2)] mb-8">
          Draft — last updated June 12, 2026. The short version: your usage data stays in our own
          database, there are no third-party trackers, and you can opt out anytime.
        </p>

        <div className="space-y-7">
          {SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="text-[17px] font-semibold text-[var(--color-txt-0)] mb-1.5">{section.title}</h2>
              <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)] whitespace-pre-line">{section.body}</p>
            </section>
          ))}
        </div>

        <p className="text-[12px] text-[var(--color-txt-3)] mt-10">
          BoilerIndy is a student project and is not an official Purdue product.
        </p>
      </div>
    </div>
  )
}
