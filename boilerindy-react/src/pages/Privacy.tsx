import { Link, useSearchParams } from 'react-router-dom'
import { getBackTarget, withFrom } from '../lib/privacyNav'
import { useAuth } from '../context/AuthContext'
import SiteDisclaimer from '../components/SiteDisclaimer'
import BrandMark from '../components/BrandMark'
import PageTitle from '../components/PageTitle'
import SkipLink from '../components/SkipLink'

// Privacy policy page (issues #51 / #113). Covers ALL data BoilerIndy handles
// (account, imported schedule, grades, followed clubs, posts, AI features,
// analytics, the sign-up link tag, the calendar feed). Contact is
// privacy@boilerindy.app (Cloudflare email routing).
// The Contact section links to /delete-account (issue #193).
// Issue #526 added push notifications, the native app, every service provider,
// the cookies and device storage, retention, security, children, your choices
// and changes: the parts Apple's guideline 5.1.1(i) and Play's Data safety
// review look for.

// Reading column type: Jakarta section heads over 15px/1.6 prose.
const SECTION_TITLE = 'text-[18px] leading-[1.3] text-[var(--color-txt-0)]'
const SECTION_BODY = 'mt-2 text-[15px] leading-[1.6] text-[var(--color-txt-1)]'

const SECTIONS = [
  {
    title: 'Who we are',
    body: `BoilerIndy is an independent student project based in Indianapolis, Indiana, built for
Purdue University Indianapolis students. It is not an official Purdue product and is not
affiliated with, endorsed by, or sponsored by Purdue University. This policy covers the website at
boilerindy.app and the BoilerIndy app for iPhone and Android, which share one account and one
database.`,
  },
  {
    title: 'Account information',
    body: `When you create an account we store your email address, the name you provide, and - if
you sign in with a sign-in provider such as Google - the avatar and provider that service
returns. Authentication is handled by Supabase. We never see or store the password for that
provider. When you create an account with a password, or sign in with it on a device you have not
chosen to trust, we email you a one-time code that expires after 10 minutes.`,
  },
  {
    title: 'Linking your Purdue account',
    body: `If you link Purdue, we store only your Purdue email and username. You link it either on
Purdue's own CAS login or by typing a code we email to your Purdue address - BoilerIndy never
asks for, receives, or stores your Purdue password.`,
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
    title: 'Clubs you follow',
    body: `The clubs you follow on the Clubs page are stored with your account, so they show on every
device you sign in on, and they are deleted with your account.`,
  },
  {
    title: 'Things you post',
    body: `Content you create - board posts, marketplace listings, lost & found reports, guide
posts, study groups, and your friend profile - is stored and shown to other signed-in students.
Marketplace listings display your name and email (your Purdue email, if you linked one) to
signed-in users so buyers can reach you, so only share what you're comfortable making visible on
campus. Photos you add to a
marketplace listing are reviewed by an admin before other students see them. Listing photos are
stored at a direct link, so anyone who is given a photo's link can open it.`,
  },
  {
    title: 'AI assistant',
    body: `When you use the Campus Assistant, your message is sent to Groq's inference API along
with context from your own account: your class schedule (including classes you have edited,
hidden, or added yourself), upcoming assignments and deadlines, the to-do list you keep in the
app and which items you have checked off, campus events on your calendar, and the public dining
menu for the day. We do not send your email, password, grades or GPA, device location, or
anything you post on the campus board. If you don't use the assistant, nothing is sent to it.`,
  },
  {
    title: 'Location',
    body: `Some features on the website, like the campus map, transit and nearby places, may ask your
device for your location. It is used on your device to show what's near you, and a rounded copy
is cached in your browser - we do not keep a history of your location on our servers. The app
does not ask for your location.`,
  },
  {
    title: 'Push notifications',
    body: `If you turn on notifications on a device, we store what that browser or phone needs to
receive them: a Web Push subscription on the website or an Expo push token in the app, with a
short device label (your browser's user agent or your phone's model) and the reminder settings
you pick. Notifications travel through your browser's push service (run by Google, Apple or
Mozilla) or, in the app, through Expo and Apple's or Google's push service; they get the
notification to deliver it, not your account. Turning notifications off on a device deletes its
subscription.`,
  },
  {
    title: 'Usage analytics',
    body: `When you are signed in, we record basic product usage events from a fixed allowlist -
things like "viewed the dining page" or "created a board post" - with the in-app page path and
the time. We never record free-form text, your messages, your schedule contents, or your grades
as analytics, and there are no advertising trackers or cross-site tracking (no Google Analytics,
no Meta pixel). You can opt out anytime in Settings → Privacy on the website or Profile →
Privacy in the app (one switch covers both), and raw events are kept at most 12 months.`,
  },
  {
    title: 'Sign-up links',
    body: `Some of our posters, posts and student ambassadors share links that end in a short tag,
like ?ref=flyer-a. If you open one, this browser tab keeps the tag until you close the tab. If you
then create an account in that tab, we save the tag with your new account, once, so we can count
how many sign-ups each poster, post or ambassador brought in; signing in to an account you already
have saves nothing. The tag names the link, not you. It is not a cookie, it stays in our own
database, it is never shared or used for advertising, and it is deleted with your account.`,
  },
  {
    title: 'Your calendar feed link',
    body: `If you enable the calendar feed, BoilerIndy generates a private link ending in .ics
that you can add to Google or Apple Calendar. Anyone who has that link can see your upcoming
events (titles, times, locations) without signing in, so treat it like a password. You can
regenerate the link at any time, which immediately disables the old one.`,
  },
  {
    title: 'The BoilerIndy app',
    body: `The iPhone and Android app uses the same account, database and service providers as the
website, and everything in this policy applies to it. It asks for one thing the website does
not: the photo you pick when you add one to a listing (never the camera, the microphone or your
location). It keeps your session and settings in the phone's secure storage. Expo delivers app
updates and push notifications, and sees an anonymous id for your install when the app checks for
an update. Expo's EAS Observe also receives, with that same id and never your account, how long the
app takes to start and to open each screen, the phone's model and system version, its battery,
network and memory state, and reports of crashes; we use them to find what makes the app slow or
crash. Turning off usage analytics does not stop it. Maps are drawn by Apple Maps on iPhone and by
the Google Maps SDK on Android, which collects some device and usage data under Google's own
privacy policy. In the app you can also sign in with Apple; deleting your account revokes that
sign-in.`,
  },
  {
    title: 'Who we share data with',
    body: `We don't sell your data or share it with advertisers - advertisers see only aggregate
impression and tap counts for their own campaigns. We rely on a few service providers to run the
app: Supabase (database and authentication), Render (runs the BoilerIndy server), Vercel (hosting
and anonymous page-performance metrics), Groq (only the AI-assistant requests described above),
Sentry (crash and error reports, with emails, tokens, and cookies stripped out before they are
sent), Resend (email delivery: the one-time sign-in code, the code that verifies a Purdue email,
and advertiser account mail), Cloudflare (routes the mail you send to our @boilerindy.app
addresses), Expo (app updates, push delivery, and app performance and crash reports, described
above), and TypeSafe (which reads the public campus event listings to sort them, for example whether one offers free food;
nothing about you is sent to it). Each provider gets only what its job needs, and we only use
providers that protect your data at least as well as this policy does. Public info shown in the
app - transit, dining menus, campus events, and map buildings - is fetched by our server from
public sources without sending them anything about you. A few things load straight into your
browser from the services that publish them: map tiles and campus building outlines from Esri,
and some pictures (dish photos, club logos and sponsor images). Those services see your IP
address and browser, as any website does, but nothing about your account.`,
  },
  {
    title: 'Cookies and storage on your device',
    body: `We set two cookies, and both are needed to sign you in: pih.sid keeps you signed in, and
pih.td remembers a device you chose to trust for 30 days so you are not asked for an email code
every time. The website also keeps a few things in your browser's storage: Supabase's sign-in
data, the public campus data it last loaded so pages open quickly, your theme, short AI summaries
made for you, a rounded last location if you allowed it, and the sign-up link tag described
above. Signing out clears the summaries and the location. The app keeps your session and
settings in the phone's secure storage. None of this is used for advertising or to follow you
across other sites, which is why there is no cookie banner.`,
  },
  {
    title: 'How long we keep data',
    body: `Your account and what you post stay until you delete them or your account. Content you
delete is hidden from the app immediately and is removed for good when an admin clears it or when
your account is deleted. Raw usage analytics events are kept at most 12 months. Sign-in and
Purdue verification codes expire within minutes. Server logs and database backups roll over
within 30 days, and crash reports expire on Sentry's retention schedule. Expo deletes the app's
performance data and crash reports after 90 days, in monthly batches; they are not tied to your
account. You can request deletion of your account and the data tied to it at any time (see Contact); deleting your account removes
your analytics events along with it.`,
  },
  {
    title: 'Security',
    body: `Everything travels over HTTPS, passwords are never stored in plain text, a password on a
new device also needs a code from your email, and the database refuses direct requests from
browsers and phones, so only our server can read or change it. No service is perfectly secure,
so we cannot promise your data will never be exposed. If we learn of a breach that affects your
data, we will tell you by email.`,
  },
  {
    title: 'Children',
    body: `BoilerIndy is for university students and is not directed to children. You must be 13 or
older to use it. We do not knowingly collect information from children under 13; if you think a
child under 13 has made an account, email privacy@boilerindy.app and we will delete it.`,
  },
  {
    title: 'Your choices',
    body: `You can change your display name in Settings, turn usage analytics off, turn
notifications off for each device, disconnect calendar sources, regenerate your calendar feed
link, delete anything you posted, and delete your account. If you want a copy of your data, or
something corrected that you cannot change yourself, email privacy@boilerindy.app and we will
answer within 30 days.`,
  },
  {
    title: 'Changes to this policy',
    body: `When this policy changes, we update the date at the top of this page. If a change affects
how we use information you have already given us, we will tell you in the app or by email before
it takes effect.`,
  },
  {
    title: 'Contact',
    body: `Questions about this policy, or want your data removed? Email privacy@boilerindy.app and
we will respond there. You can also open an issue on the BoilerIndy GitHub repository.`,
    link: { to: '/delete-account', label: 'How to delete your account' },
  },
]

export default function Privacy() {
  const [searchParams] = useSearchParams()
  const { user } = useAuth()
  const from = searchParams.get('from')
  const back = getBackTarget(from, Boolean(user))

  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-bg-1)]">
      {/* This page renders outside AppLayout and PublicLayout, so it
          carries its own skip link and main landmark (issue #221). */}
      <SkipLink />
      <PageTitle>Privacy policy</PageTitle>
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
              <h1 className="page-title">Privacy policy</h1>
              <p className="page-sub">
                Last updated October 28, 2026. The short version: your data stays in our own database, we
                use no advertising trackers, we never store your Purdue password, and you can opt out of
                analytics or delete your account anytime.
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
