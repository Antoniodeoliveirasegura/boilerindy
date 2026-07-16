import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget } from '../lib/privacyNav'
import SiteDisclaimer from '../components/SiteDisclaimer'

// Privacy policy page (issues #51 / #113). Covers ALL data BoilerIndy handles
// (account, imported schedule, grades, posts, AI features, analytics, the
// calendar feed). Contact runs through the GitHub repository; if a dedicated
// privacy email is set up later, add it here and in the "Contact" section.

const SECTIONS = [
  {
    title: 'Who we are',
    body: `BoilerIndy is an independent, student-built app for Purdue University Indianapolis
students. It is not an official Purdue product and is not affiliated with, endorsed by, or
sponsored by Purdue University.`,
  },
  {
    title: 'Account information',
    body: `When you create an account we store your email address, the name you provide, and - if
you sign in with Google, Apple, GitHub, or Discord - the avatar and provider that service
returns. Authentication is handled by Supabase. We never see or store your Google/Apple/etc.
password.`,
  },
  {
    title: 'Linking your Purdue account',
    body: `If you link Purdue, we store only your Purdue email and username. You sign in on
Purdue's own CAS login - BoilerIndy never asks for, receives, or stores your Purdue password.`,
  },
  {
    title: 'Your schedule and calendar',
    body: `When you connect a calendar, you paste your own iCalendar (.ics) feed URL exported
from Purdue or Brightspace. We fetch that feed and store the events it contains - class titles,
times, locations, and assignment/exam titles - so we can show your schedule and power features
like the dashboard and reminders. You can disconnect a source at any time in setup, which
removes its events.`,
  },
  {
    title: 'Grades you enter',
    body: `Grades you choose to enter in Grade Tracker are stored in your account so the tool can
calculate your standing. They are visible only to you and are removed if your account is
deleted.`,
  },
  {
    title: 'Things you post',
    body: `Content you create - board posts, marketplace listings, lost & found reports, guide
posts, study groups, and your friend profile - is stored and shown to other signed-in students.
Marketplace listings display your name and Purdue email to signed-in users so buyers can reach
you, so only share what you're comfortable making visible on campus.`,
  },
  {
    title: 'AI assistant',
    body: `When you use the Campus Assistant, your message and relevant context from your own
calendar (event titles, times, and locations) are sent to Google's Gemini API to generate a
reply. We do not send your email, password, or device location to the AI. If you don't use the
assistant, nothing is sent to it.`,
  },
  {
    title: 'Location',
    body: `Some features, like the campus map and nearby places, may ask your device for your
location. It is used on your device to show what's near you and cached locally - we do not keep
a history of your location on our servers.`,
  },
  {
    title: 'Usage analytics',
    body: `When you are signed in, we record basic product usage events from a fixed allowlist -
things like "viewed the dining page" or "created a board post" - with the in-app page path and
the time. We never record free-form text, your messages, your schedule contents, or your grades
as analytics, and there are no advertising trackers or cross-site tracking (no Google Analytics,
no Meta pixel). You can opt out anytime in Settings → Privacy, and raw events are kept at most
12 months.`,
  },
  {
    title: 'Who we share data with',
    body: `We don't sell your data or share it with advertisers - advertisers see only aggregate
impression and tap counts for their own campaigns. We rely on a few service providers to run the
app: Supabase (database and authentication), Google Gemini (only the AI-assistant requests
described above), Sentry (crash and error reports, with emails, tokens, and cookies stripped out
before they are sent), Vercel (hosting and anonymous page-performance metrics), and Resend (email
delivery for advertiser accounts only). Public info shown in the app - transit, dining menus, and
map buildings - is fetched from public sources without sending them anything about you.`,
  },
  {
    title: 'Your calendar feed link',
    body: `If you enable the calendar feed, BoilerIndy generates a private link ending in .ics
that you can add to Google or Apple Calendar. Anyone who has that link can see your upcoming
events (titles, times, locations) without signing in, so treat it like a password. You can
regenerate the link at any time, which immediately disables the old one.`,
  },
  {
    title: 'Cookies',
    body: `We use a single sign-in cookie to keep you logged in, plus Supabase's authentication
storage. We do not use cookies for advertising or cross-site tracking.`,
  },
  {
    title: 'Keeping and deleting your data',
    body: `Content you delete is hidden from the app immediately. You can request deletion of your
account and the data tied to it at any time (see Contact); deleting your account removes your
analytics events along with it.`,
  },
  {
    title: 'Contact',
    body: `Questions about this policy, or want your data removed? Reach the BoilerIndy maintainer
by opening an issue on the BoilerIndy GitHub repository, and we will respond there.`,
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
          Last updated July 16, 2026. The short version: your data stays in our own database, we
          use no advertising trackers, we never store your Purdue password, and you can opt out of
          analytics or delete your account anytime.
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
