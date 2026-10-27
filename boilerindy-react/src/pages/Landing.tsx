import { Link } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import BrandMark from '../components/BrandMark'
import FlapDigit from '../components/FlapDigit'
import Icon from '../components/Icons'
import SiteDisclaimer from '../components/SiteDisclaimer'
import SkipLink from '../components/SkipLink'
import { PREVIEW_SIGN_UP_HREF as SIGN_UP_HREF } from '../lib/publicPreview'
import './marketing.css'

// BoilerIndy public landing / marketing page (route: /, the front page).
// Self-contained and data-free - it never touches the backend, so it renders
// identically in any environment. Transit wayfinding: campus is a transit
// system, every feature is a line with its own colour (one per card), the
// next class is a departures board and amber is kept for "now", the primary
// action and the closing sign panel.

// The app's own 1200px column (.page), on the nav's edges, minus its top
// and bottom padding: each landing section sets its own vertical rhythm.
const wrap = 'page py-0'

// The preview board's small tiles. Their padding goes in --flap-pad, which
// the rolling digit's strip uses too (index.css .flap-roll).
const LANDING_FLAP = 'min-w-[26px] [--flap-pad:6px_4px_5px] text-[28px] sm:text-[30px]'

const bentoTiles = [
  {
    span: 'sm:col-span-2 lg:col-span-2 lg:row-span-2',
    icon: 'grid',
    tag: 'New',
    title: 'A dashboard that bends to you',
    desc: 'Drag, hide, and reorder every widget. Your campus - class, dining, buses, board - arranged exactly how your day actually runs. Synced across devices.',
    route: 'r-ink',
    feature: true,
  },
  {
    span: '',
    icon: 'sparkles',
    title: 'Ask anything',
    desc: '“What should I work on tonight?” the assistant answers from your classes, deadlines, and dining.',
    route: 'r-ai',
  },
  {
    span: '',
    icon: 'dining',
    title: 'Live dining',
    desc: 'Today’s menus and dish details for every dining hall.',
    route: 'r-din',
  },
  {
    span: 'sm:col-span-2',
    wide: true,
    icon: 'bus',
    title: 'Buses, live',
    desc: 'Live bus positions on the map, and a chime when yours pulls up to your stop.',
    route: 'r-bus',
  },
  {
    span: '',
    icon: 'schedule',
    title: 'Free-time radar',
    desc: 'Gaps between classes turn into smart suggestions.',
    route: 'r-cls',
  },
  {
    span: '',
    icon: 'document',
    title: 'Deadline triage',
    desc: 'Every assignment, ranked by what’s actually urgent.',
    route: 'r-tsk',
  },
  {
    span: '',
    icon: 'calendar',
    title: 'Events that fit',
    desc: 'Campus happenings matched to your open windows.',
    route: 'r-evt',
  },
  {
    span: '',
    icon: 'message',
    title: 'Campus board',
    desc: 'Ask, answer, upvote. The hallway, online.',
    route: 'r-ink',
  },
  {
    span: 'lg:col-span-2',
    wide: true,
    icon: 'coffee',
    title: 'Free food radar',
    desc: 'Never miss leftover pizza on campus again.',
    route: 'r-din',
  },
  {
    span: 'lg:col-span-2',
    wide: true,
    icon: 'mapPin',
    title: 'Find anything',
    desc: 'Buildings, parking, resources - one tap away.',
    route: 'r-map',
  },
]

const dayTimeline = [
  { time: '8:05 AM', icon: 'schedule', route: 'r-cls', title: 'Heads up: CS 30200 in 25 min', body: 'Your dashboard greets you with the next class, the room, and the walk time.' },
  { time: '11:15 AM', icon: 'sparkles', route: 'r-ai', title: '“You’ve got 90 free minutes”', body: 'BoilerIndy suggests a study block - and what’s on the menu at Tower Dining.' },
  { time: '12:30 PM', icon: 'dining', route: 'r-din', title: 'Lunch, sorted', body: 'Live menu shows what’s actually being served. Ask AI for the high-protein pick.' },
  { time: '2:00 PM', icon: 'bus', route: 'r-bus', title: 'Catch the shuttle', body: 'Your bus moves live on the map, and a chime tells you when it reaches your stop.' },
  { time: '4:30 PM', icon: 'coffee', route: 'r-din', title: 'Free pizza in ET', body: 'Campus events that mention free food, in one feed. You detour for a slice.' },
  { time: '9:00 PM', icon: 'message', route: 'r-ink', title: 'Wind down on the board', body: 'Someone answered your “best quiet study spot?” thread. You upvote and bookmark.' },
]

const integrations = [
  ['schedule', 'Brightspace LMS', 'r-cls'],
  ['dining', 'Campus Dining', 'r-din'],
  ['bus', 'JAGLINE Shuttle', 'r-bus'],
  ['calendar', 'Events Feed', 'r-evt'],
  ['mapPin', 'Campus Map', 'r-map'],
  ['sparkles', 'Groq AI', 'r-ai'],
  ['users', 'BoilerLink Clubs', 'r-evt'],
  ['document', 'Task Tracker', 'r-tsk'],
  ['message', 'Community Board', 'r-ink'],
  ['bell', 'Smart Alerts', 'r-ink'],
]

// The five campus lines that merge into one amber line ("one line: yours").
// Drawn around an interchange at the centre (x=600) so the phone crop keeps it.
const lineMap = [
  ['var(--color-cls-sub)', 'M8 18 H400 C480 18 500 66 578 66'],
  ['var(--color-dining-color)', 'M8 42 H420 C482 42 512 66 578 66'],
  ['var(--color-map-color)', 'M8 66 H578'],
  ['var(--color-bus-title)', 'M8 90 H420 C482 90 512 66 578 66'],
  ['var(--color-events-color)', 'M8 114 H400 C480 114 500 66 578 66'],
]

function Stat({ value, label, className = '' }: { value: React.ReactNode; label: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 pt-3.5 ${className}`}>
      <div className="font-display text-[30px] sm:text-[34px] font-extrabold leading-none tracking-[-0.03em] tnum text-[var(--color-txt-0)]">
        {value}
      </div>
      <div className="text-[13px] text-[var(--color-txt-2)] mt-1.5">{label}</div>
    </div>
  )
}

export default function Landing() {
  const { dark, toggleTheme } = useTheme()

  return (
    // overflow-x-clip, not hidden: hidden made this div a scroll container that
    // never scrolls, so the sticky nav stuck to it instead of the viewport and
    // scrolled away with its section links and "Get started".
    <div className="mkt min-h-screen bg-[var(--color-bg-1)] text-[var(--color-txt-0)] overflow-x-clip">
      <SkipLink />
      {/* ── Nav: the app's signage band (paper with an ink rule in light, ink in dark) ── */}
      <nav className="topbar sticky top-0 z-50">
        <div className={`${wrap} flex flex-wrap items-center lg:h-16 lg:flex-nowrap lg:items-stretch`}>
          <Link to="/" className="topbar-brand h-14 lg:h-auto">
            <BrandMark size={32} />
            BoilerIndy
          </Link>
          <span className="topbar-divider hidden lg:block" aria-hidden="true" />
          <div className="mkt-navrow order-last -mx-4 md:-mx-6 flex basis-[calc(100%+2rem)] md:basis-[calc(100%+3rem)] border-t border-[var(--color-border-2)] lg:order-none lg:mx-0 lg:basis-auto lg:border-t-0">
            <a href="#features" className="topnav-link h-11 flex-1 justify-center px-1.5 text-[13px] lg:h-full lg:flex-none lg:px-3.5 lg:text-[14px] no-underline">Features</a>
            <a href="#day" className="topnav-link h-11 flex-1 justify-center px-1.5 text-[13px] lg:h-full lg:flex-none lg:px-3.5 lg:text-[14px] no-underline">A day on campus</a>
            <a href="#stack" className="topnav-link h-11 flex-1 justify-center px-1.5 text-[13px] lg:h-full lg:flex-none lg:px-3.5 lg:text-[14px] no-underline">Connected to</a>
          </div>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="icon-btn"
            >
              <Icon name={dark ? 'sun' : 'moon'} size={18} />
            </button>
            <Link to="/advertise" className="btn btn-ghost btn-sm hidden sm:inline-flex no-underline">
              <Icon name="briefcase" size={15} />
              Advertise
            </Link>
            {/* "Get started" opens the sign-up tab; returning students get their
                own way in instead of landing on sign-up. */}
            <Link to="/login" className="btn btn-ghost btn-sm hidden sm:inline-flex no-underline">
              Sign in
            </Link>
            <Link to={SIGN_UP_HREF} className="btn btn-primary btn-sm no-underline">
              <Icon name="sparkles" size={15} className="max-[359px]:hidden" />
              Get started
            </Link>
          </div>
        </div>
      </nav>

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* ── Hero ────────────────────────────────────────────────────────── */}
        <section className="mkt-reveal pt-9 md:pt-16">
          <div className={wrap}>
            <div className="ink-panel inline-flex items-center overflow-hidden rounded-[4px] font-display text-[13px] font-extrabold tracking-[0.02em]">
              <span className="route-badge size-[34px] rounded-none">
                <Icon name="mapPin" size={18} />
              </span>
              <span className="pl-3 pr-3.5">Built for Purdue Indianapolis</span>
            </div>
            <h1 className="display mt-6 mb-6 md:mt-7 md:mb-10 md:text-[76px] lg:text-[104px]">
              The whole campus,
              <br />
              <span className="mkt-plate">
                one quiet screen.
              </span>
            </h1>
          </div>

          <div className={`${wrap} grid gap-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-16 items-start`}>
            {/* Left: copy */}
            <div className="min-w-0">
              <p className="text-[16.5px] md:text-[19px] text-[var(--color-txt-1)] max-w-[500px] leading-[1.55]">
                Classes, dining, live buses, deadlines, events and a campus board -
                stitched together and quietly organized by AI. Stop juggling ten apps.
              </p>
              <div className="flex flex-wrap gap-3 mt-7 mb-8 md:mb-10">
                <Link to={SIGN_UP_HREF} className="btn btn-primary btn-lg no-underline max-sm:w-full">
                  <Icon name="sparkles" size={18} />
                  Get started - it’s free
                </Link>
                <a href="#features" className="btn btn-secondary btn-lg no-underline max-sm:w-full">
                  <Icon name="arrowUpRight" size={18} />
                  Take the tour
                </a>
              </div>
              {/* Phones have no room for Sign in in the nav band (it wrapped the
                  band onto a third row), so it sits under the sign-up button. */}
              <p className="sm:hidden -mt-5 mb-8 text-[14px] text-[var(--color-txt-2)]">
                Already have an account?{' '}
                <Link to="/login" className="prose-link font-semibold">
                  Sign in
                </Link>
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 max-w-[560px] border-t-4 border-[var(--color-txt-0)]">
                <Stat value="12+" label="Campus features" className="pr-3.5" />
                <Stat value="Live" label="Bus & dining" className="px-3.5 border-l border-[var(--color-border-2)]" />
                <Stat value="AI" label="by Groq" className="pr-3.5 max-sm:pt-4 sm:px-3.5 sm:border-l sm:border-[var(--color-border-2)]" />
                <Stat value="$0" label="For students" className="px-3.5 max-sm:pt-4 border-l border-[var(--color-border-2)]" />
              </div>
            </div>

            {/* Right: a live-looking dashboard preview with two hanging chips */}
            <div className="relative min-w-0 max-w-[620px] lg:max-w-none lg:mt-1">
              <div className="overflow-hidden rounded-2xl border-[1.5px] border-[var(--color-txt-0)] bg-[var(--color-bg-1)] shadow-[6px_6px_0_var(--color-bg-3)] sm:shadow-[10px_10px_0_var(--color-bg-3)] mr-1.5 sm:mr-2.5 lg:mr-0">
                <div className="topbar flex items-center gap-2.5 h-[42px] px-3.5">
                  <BrandMark size={22} />
                  <div className="min-w-0 truncate rounded-[3px] bg-[var(--color-stat)] px-2 py-1 text-[11px] leading-none text-[var(--color-txt-2)] font-mono">boilerindy.app/dashboard</div>
                  <span className="live-dot ml-auto" aria-hidden="true" />
                </div>

                <div className="grid gap-2.5 p-3 sm:p-4">
                  <div className="font-display text-[19px] font-extrabold leading-tight tracking-[-0.02em]">Good afternoon, Alex</div>

                  <div className="ink-panel r-cls px-3 py-3 sm:px-3.5">
                    <div className="board-title text-[10px] tracking-[0.14em]">Next class</div>
                    <div className="mt-2.5 flex items-center gap-3 sm:gap-3.5">
                      {/* The one motion on this page besides the hero's fade:
                          the digits roll in from blank tiles once (FlapDigit). */}
                      <div className="flaps shrink-0" aria-hidden="true">
                        <FlapDigit value="1" index={0} className={LANDING_FLAP} />
                        <span className="flap-sep text-[22px]">:</span>
                        <FlapDigit value="3" index={1} className={LANDING_FLAP} />
                        <FlapDigit value="0" index={2} className={LANDING_FLAP} />
                      </div>
                      <div className="min-w-0">
                        <div className="font-display text-[14px] sm:text-[15px] font-extrabold leading-tight text-[var(--color-ink-txt)]">CS 30200 · Software Engineering</div>
                        <div className="mt-1 text-[11.5px] leading-snug tnum text-[var(--color-ink-dim)]">ET 215 · 1:30 PM · in 25 min</div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {[
                      ['mapPin', 'Map', 'r-map'],
                      ['dining', 'Dining', 'r-din'],
                      ['bus', 'Transit', 'r-bus'],
                    ].map(([ic, t, r]) => (
                      <div key={t} className={`card ${r} flex min-w-0 items-center gap-2 p-2 sm:px-2.5`}>
                        <span className="route-badge sm">
                          <Icon name={ic} size={14} />
                        </span>
                        <div className="truncate font-display text-[12px] font-extrabold">{t}</div>
                      </div>
                    ))}
                  </div>

                  <div className="card r-cls px-3.5 pt-3 pb-3.5">
                    <div className="font-display text-[10px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-txt-2)]">Free time</div>
                    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <div className="font-display text-[24px] font-extrabold leading-none tracking-[-0.03em] tnum">1h 30m</div>
                      <div className="text-[12px] text-[var(--color-txt-2)]">Free before your next class</div>
                    </div>
                    <div className="mkt-pvline" aria-hidden="true">
                      <i />
                      <i style={{ left: '58%' }} />
                      <i />
                    </div>
                  </div>
                </div>
              </div>

              {/* Hanging chips: hung off the preview from 1024px, a row under it below that */}
              <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:contents">
                <div className="card r-bus flex items-center gap-2.5 py-2 pl-2 pr-3 lg:absolute lg:right-7 lg:-bottom-10 lg:border-[1.5px] lg:border-[var(--color-txt-0)] lg:shadow-[var(--shadow-lg)]">
                  <span className="route-badge sm">
                    <Icon name="bus" size={14} />
                  </span>
                  <div>
                    <div className="font-display text-[12px] font-extrabold leading-tight">Your bus</div>
                    <div className="text-[11px] text-[var(--color-txt-2)]">Live on the map</div>
                  </div>
                </div>
                <div className="card r-ai flex items-center gap-2.5 py-2 pl-2 pr-3 lg:absolute lg:-left-7 lg:-bottom-10 lg:max-w-[240px] lg:border-[1.5px] lg:border-[var(--color-txt-0)] lg:shadow-[var(--shadow-lg)]">
                  <span className="route-badge sm">
                    <Icon name="sparkles" size={14} />
                  </span>
                  <div className="font-display text-[12px] font-bold leading-snug text-[var(--color-txt-0)]">
                    “Good window for a study block before SWE.”
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* One line: yours. Five campus lines merge into one amber line. */}
          <div className={`${wrap} mt-12 lg:mt-[88px]`} aria-hidden="true">
            {/* Full bleed on phones: the cropped lines enter from the screen edge. */}
            <div className="relative -mx-4 md:mx-0">
              <svg className="block h-24 w-full md:h-auto" viewBox="0 0 1200 132" preserveAspectRatio="xMidYMid slice" focusable="false">
                <g fill="none" strokeWidth="8" strokeLinecap="round">
                  {lineMap.map(([stroke, d]) => (
                    <path key={d} d={d} style={{ stroke }} />
                  ))}
                  <path d="M622 66 H1192" strokeWidth="16" style={{ stroke: 'var(--color-gold)' }} />
                </g>
                <circle cx="600" cy="66" r="22" strokeWidth="7" style={{ fill: 'var(--color-surface)', stroke: 'var(--color-txt-0)' }} />
              </svg>
              <span className="absolute right-4 bottom-[calc(50%+14px)] whitespace-nowrap font-display text-[11.5px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-txt-0)] md:right-auto md:left-[calc(50%+40px)] md:text-[13px]">
                One line: yours
              </span>
            </div>
          </div>
        </section>

        {/* ── Features: the route index ───────────────────────────────────── */}
        <section id="features" className="scroll-mt-28 lg:scroll-mt-20 py-16 md:py-[88px]">
          <div className={wrap}>
            <div className="max-w-[720px] mb-8 md:mb-9">
              <div className="eyebrow">Everything, in its place</div>
              <h2 className="section-title">
                Not a folder of apps. <span className="dim">A single, opinionated home.</span>
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-4">
              {bentoTiles.map((tile) => (
                <article
                  key={tile.title}
                  className={`card ${tile.route} flex min-w-0 ${tile.span} ${
                    tile.feature
                      ? 'flex-col p-4 sm:p-6'
                      : `flex-row gap-3.5 p-4 sm:flex-col sm:gap-0 sm:p-5 ${tile.wide ? '' : 'sm:min-h-[168px]'}`
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={`route-badge ${tile.feature ? 'lg' : ''}`}>
                      <Icon name={tile.icon} size={tile.feature ? 22 : 18} />
                    </span>
                    {tile.tag && <span className="badge badge-signal">{tile.tag}</span>}
                  </div>
                  {tile.feature && (
                    <div className="mkt-stack my-5" aria-hidden="true">
                      <span>Up next<Icon name="menu" size={16} /></span>
                      <span className="is-lifted">Shuttles<Icon name="menu" size={16} /></span>
                      <span>Menus<Icon name="menu" size={16} /></span>
                    </div>
                  )}
                  <div className={tile.feature ? 'mt-auto' : 'min-w-0 sm:mt-auto sm:pt-5'}>
                    <h3
                      className={
                        tile.feature
                          ? 'text-[22px] md:text-[26px] tracking-[-0.025em] leading-[1.1] mb-2'
                          : 'text-[16px] sm:text-[17px] leading-tight mb-1 sm:mb-1.5'
                      }
                    >
                      {tile.title}
                    </h3>
                    <p className={`text-[var(--color-txt-2)] leading-[1.5] ${tile.feature ? 'text-[15px] max-w-[440px]' : 'text-[13.5px] sm:text-[14px]'}`}>
                      {tile.desc}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ── A day on campus: an ink band with the day as a route line ────── */}
        <section id="day" className="ink-panel rounded-none border-x-0 scroll-mt-28 lg:scroll-mt-20 py-16 md:py-[88px]">
          <div className={wrap}>
            <div className="max-w-[720px]">
              <div className="eyebrow">A Tuesday, narrated</div>
              <h2 className="section-title text-[var(--color-ink-txt)]">
                One app, from your first class to the last slice of pizza.
              </h2>
            </div>

            <ol className="mkt-tl list-none m-0 p-0 mt-10 lg:mt-12">
              {dayTimeline.map((step) => (
                <li key={step.time} className={step.route}>
                  <div className="mkt-time font-display text-[14px] font-extrabold tracking-[0.02em] tnum text-[var(--color-ink-signal)]">{step.time}</div>
                  <span className="mkt-stop" aria-hidden="true" />
                  <span className="route-badge lg:mb-3">
                    <Icon name={step.icon} size={18} />
                  </span>
                  <div className="mkt-ttl font-display text-[16px] font-bold leading-snug text-[var(--color-ink-txt)]">{step.title}</div>
                  <p className="mt-1.5 text-[13.5px] leading-[1.5] text-[var(--color-ink-dim)]">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Plugged into: connection plates ─────────────────────────────── */}
        <section id="stack" className="scroll-mt-28 lg:scroll-mt-20 py-16 md:py-[88px]">
          <div className={wrap}>
            <div className="max-w-[720px] mb-8 md:mb-9">
              {/* Only sources that are live on the site (issue #527): the library
                  events source waits behind CAMPUS_EVENTS_LIBRARY, and dining is
                  a daily menu, not a real-time feed. */}
              <div className="eyebrow">Real campus data</div>
              <h2 className="section-title">Plugged into the systems you already use</h2>
            </div>
            <ul className="list-none m-0 p-0 grid grid-cols-2 lg:grid-cols-5 gap-2.5">
              {integrations.map(([icon, label, route]) => (
                <li
                  key={label}
                  className={`card ${route} flex min-w-0 items-center gap-2.5 min-h-[52px] py-2 pl-2 pr-3 font-display text-[13px] sm:text-[14px] font-bold leading-tight text-[var(--color-txt-0)]`}
                >
                  <span className="route-badge">
                    <Icon name={icon} size={18} />
                  </span>
                  <span className="min-w-0">{label}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── CTA: the amber sign panel ───────────────────────────────────── */}
        <section className="pb-16 md:pb-[72px]">
          <div className={wrap}>
            <div className="mkt-cta overflow-hidden rounded-2xl md:rounded-3xl border-[1.5px] border-[var(--color-gold-dark)]/25 bg-[var(--color-gold)] text-[var(--color-gold-dark)] px-[22px] pt-10 md:px-14 md:pt-16">
              <h2 className="section-title md:text-[56px] leading-none max-w-[720px] text-[var(--color-gold-dark)]">
                Your campus is ready when you are.
              </h2>
              <p className="mt-4 mb-7 max-w-[520px] text-[16px] md:text-[17px] leading-[1.55] text-[var(--color-gold-dark)]/85">
                Free for every Purdue Indianapolis student. Create an account with Google or your email, link Purdue in setup, and your dashboard builds itself.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link to={SIGN_UP_HREF} className="btn btn-lg no-underline max-sm:w-full bg-[var(--color-gold-dark)] border-[var(--color-gold-dark)] text-[var(--color-gold-light)] hover:bg-[var(--color-gold-dark)]/85">
                  <Icon name="home" size={18} />
                  Get started free
                </Link>
                {/* The live pages a signed-out visitor can open (issue #366). */}
                <Link to="/dining" className="btn btn-lg no-underline max-sm:w-full bg-transparent border-[var(--color-gold-dark)]/40 text-[var(--color-gold-dark)] hover:bg-[var(--color-gold-dark)]/10">
                  <Icon name="dining" size={18} />
                  See live dining and buses
                </Link>
              </div>
              <ol className="mkt-cta-route list-none m-0 p-0" aria-hidden="true">
                <li>
                  <span className="mkt-cdot" />
                  <b>Sign up</b>
                  <small>Google or email</small>
                </li>
                <li>
                  <span className="mkt-cdot" />
                  <b>Connect Purdue</b>
                  <small>Classes and deadlines</small>
                </li>
                <li>
                  <span className="mkt-cdot" />
                  <b>Arrive</b>
                  <small>Start your day</small>
                </li>
              </ol>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--color-border-2)] pt-10 text-center">
        <div className="inline-flex items-center gap-2.5 font-display text-[17px] font-extrabold tracking-[-0.02em]">
          <BrandMark size={30} />
          BoilerIndy
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-x-1.5 gap-y-0.5 px-4">
          <Link to="/install" className="inline-flex min-h-11 items-center gap-1.5 rounded-[3px] px-2.5 font-display text-[13.5px] font-bold text-[var(--color-accent)] no-underline hover:underline underline-offset-[3px] decoration-2">
            <Icon name="plus" size={15} />
            Add the app to your phone
          </Link>
          <Link to="/advertise" className="inline-flex min-h-11 items-center gap-1.5 rounded-[3px] px-2.5 font-display text-[13.5px] font-bold text-[var(--color-accent)] no-underline hover:underline underline-offset-[3px] decoration-2">
            <Icon name="briefcase" size={15} />
            Advertise with us
          </Link>
          <a href="mailto:hello@boilerindy.app" className="inline-flex min-h-11 items-center gap-1.5 rounded-[3px] px-2.5 font-display text-[13.5px] font-bold text-[var(--color-accent)] no-underline hover:underline underline-offset-[3px] decoration-2">
            <Icon name="mail" size={15} />
            hello@boilerindy.app
          </a>
        </div>
        <SiteDisclaimer note="A student-built campus companion for Purdue University Indianapolis" />
      </footer>
    </div>
  )
}
