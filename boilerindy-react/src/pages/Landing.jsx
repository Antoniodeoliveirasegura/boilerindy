import { Link } from 'react-router-dom'
import { useAuth, useSignOutAndRedirect } from '../context/AuthContext'
import Icon from '../components/Icons'

const featCards = [
  {
    icon: 'schedule',
    title: 'Smart Schedule',
    desc: 'See your classes, track free time, and get AI suggestions on what to do between lectures.',
    wrap: 'bg-[var(--color-cls-bg)] text-[var(--color-map-color)]',
  },
  {
    icon: 'dining',
    title: 'Live Dining + AI Picks',
    desc: 'Browse live menus, check hours, and ask AI "What should I eat?" for a personalized recommendation.',
    wrap: 'bg-[var(--color-dining-bg)] text-[var(--color-dining-color)]',
  },
  {
    icon: 'bus',
    title: 'Transit & Bus ETA',
    desc: 'Live bus tracking with plain-language ETA: "3 stops from you, about 6 minutes." Uses your location.',
    wrap: 'bg-[var(--color-bus-bg)] text-[var(--color-bus-title)]',
  },
  {
    icon: 'calendar',
    title: 'Events + AI Picks',
    desc: 'Discover campus events and let AI recommend which ones fit your schedule and free time.',
    wrap: 'bg-[var(--color-events-bg)] text-[var(--color-events-color)]',
  },
  {
    icon: 'document',
    title: 'Assignments & Study Planner',
    desc: 'Track every deadline from Brightspace. AI ranks them by urgency and builds a study plan around your free time.',
    wrap: 'bg-blue-100 dark:bg-blue-900/25 text-blue-600 dark:text-blue-400',
  },
  {
    icon: 'message',
    title: 'Campus Board',
    desc: 'Ask questions, share tips, and upvote answers. AI auto-tags posts and summarizes long threads.',
    wrap: 'bg-purple-100 dark:bg-purple-900/25 text-purple-600 dark:text-purple-400',
  },
  {
    icon: 'mapPin',
    title: 'Interactive Map',
    desc: 'Find any building, parking lot, or campus resource instantly with an interactive campus map.',
    wrap: 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]',
  },
  {
    icon: 'sparkles',
    title: 'IndyAssist',
    desc: 'Ask anything in natural language — classes, menus, bus times, deadlines. Instant answers powered by Gemini.',
    wrap: 'bg-[var(--color-gold)]/25 text-[var(--color-gold-dark)]',
  },
  {
    icon: 'bell',
    title: 'Smart Alerts & Weekly Digest',
    desc: 'Get a Monday briefing of your week ahead and real-time heads-up when deadlines, classes, or dining are close.',
    wrap: 'bg-orange-100 dark:bg-orange-900/25 text-orange-600 dark:text-orange-400',
  },
]

const integrations = [
  ['schedule', 'Brightspace LMS'],
  ['dining', 'Campus Dining API'],
  ['bus', 'IndyGo Transit'],
  ['calendar', 'Campus Events Feed'],
  ['mapPin', 'Campus Map Data'],
  ['sparkles', 'Google Gemini AI'],
  ['book', 'University Library'],
  ['home', 'Student Portal'],
  ['document', 'Assignment Tracker'],
  ['message', 'Community Board'],
]

export default function Landing() {
  const { user, loading } = useAuth()
  const signOutAndRedirect = useSignOutAndRedirect()

  return (
    <div className="min-h-screen bg-[var(--color-bg-0)] text-[var(--color-txt-0)]">
      <nav className="sticky top-0 z-50 h-14 px-5 sm:px-8 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)]/85 backdrop-blur-md">
        <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold text-[var(--color-txt-0)] no-underline">
          <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md tracking-wide">
            IA
</span>
          IndyAssist
        </Link>
        <div className="hidden sm:flex items-center gap-0.5">
          <a href="#features" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] flex items-center gap-1.5 no-underline">
            <Icon name="grid" size={13} />
            Features
          </a>
          <a href="#integrations" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] flex items-center gap-1.5 no-underline">
            <Icon name="sparkles" size={13} />
            Integrations
          </a>
          <Link to="/dashboard" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] flex items-center gap-1.5 no-underline">
            <Icon name="home" size={13} />
            Dashboard
          </Link>
        </div>
        <div className="flex items-center gap-2">
          {!loading && user ? (
            <>
              <Link
                to="/dashboard"
                className="hidden sm:inline-flex text-[13px] text-[var(--color-txt-1)] px-4 py-1.5 rounded-lg border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] no-underline items-center gap-1.5"
              >
                Dashboard
              </Link>
              <button
                type="button"
                onClick={() => signOutAndRedirect()}
                className="text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-4 py-1.5 rounded-lg border-0 hover:brightness-105"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="hidden sm:inline-flex text-[13px] text-[var(--color-txt-1)] px-4 py-1.5 rounded-lg border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] no-underline items-center gap-1.5"
              >
                Sign in
              </Link>
              <Link
                to="/login"
                className="text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-4 py-1.5 rounded-lg no-underline inline-flex items-center gap-1.5 hover:brightness-105"
              >
                <Icon name="sparkles" size={14} />
                Get started
              </Link>
            </>
          )}
        </div>
      </nav>

      <section className="relative min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center px-6 py-16 text-center overflow-hidden">
        <div
          className="pointer-events-none absolute -top-[10%] left-1/2 -translate-x-1/2 w-[800px] h-[800px] rounded-full opacity-100"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(212,168,75,0.12) 0%, transparent 70%)',
          }}
        />
        <div className="relative inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)]/20 border border-[var(--color-gold)]/40 rounded-full px-3.5 py-1.5 mb-6 tracking-wide">
          <Icon name="sparkles" size={13} />
          Built for Purdue Indianapolis
        </div>
        <h1 className="relative text-[clamp(2.2rem,5vw,3.8rem)] font-bold tracking-tight leading-tight max-w-[720px] mb-5">
          Your campus,
          <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-br from-[var(--color-gold)] to-[var(--color-gold-muted)]">
            all in one place.
          </span>
        </h1>
        <p className="relative text-[1.05rem] text-[var(--color-txt-1)] max-w-[520px] leading-relaxed mb-9">
          Schedules, dining, transit, events, assignments, a campus board, and AI-powered insights — everything you need to navigate student life at Purdue Indy.
        </p>
        <div className="relative flex flex-wrap gap-3 justify-center mb-12">
          {!loading && user ? (
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-7 py-3 rounded-[10px] no-underline hover:brightness-105 hover:-translate-y-0.5 shadow-lg shadow-[var(--color-gold)]/25"
            >
              <Icon name="home" size={16} />
              Open dashboard
            </Link>
          ) : (
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-7 py-3 rounded-[10px] no-underline hover:brightness-105 hover:-translate-y-0.5 shadow-lg shadow-[var(--color-gold)]/25"
            >
              <Icon name="home" size={16} />
              Get started free
            </Link>
          )}
          <a
            href="#features"
            className="inline-flex items-center gap-2 text-[14px] text-[var(--color-txt-0)] px-7 py-3 rounded-[10px] border border-[var(--color-border-2)] bg-transparent hover:bg-[var(--color-bg-2)] no-underline transition-transform hover:-translate-y-0.5"
          >
            <Icon name="arrowUpRight" size={16} />
            See features
          </a>
        </div>
        <div className="relative flex flex-wrap gap-8 sm:gap-10 justify-center">
          {[
            ['12+', 'Campus features'],
            ['Live', 'Bus & dining data'],
            ['AI', 'Powered by Gemini'],
            ['Free', 'For all students'],
          ].map(([n, l]) => (
            <div key={l} className="text-center">
              <div className="text-[22px] font-bold text-[var(--color-txt-0)]">{n}</div>
              <div className="text-[12px] text-[var(--color-txt-2)] mt-0.5">{l}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="px-5 sm:px-8 pb-20 max-w-[1000px] mx-auto">
        <div className="bg-[var(--color-bg-1)] border border-[var(--color-border)] rounded-2xl p-6 relative overflow-hidden">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <div className="flex-1 bg-[var(--color-bg-2)] rounded-md py-1.5 px-3 text-[11px] text-[var(--color-txt-2)] font-mono">
              purdueindyhub.edu
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-3.5">
            {[
              ['mapPin', 'Campus Map', 'Find any building', 'bg-[var(--color-map-bg)] text-[var(--color-map-color)]'],
              ['dining', 'Dining', 'Open now', 'bg-[var(--color-dining-bg)] text-[var(--color-dining-color)]'],
              ['bus', 'Transit', 'Next in 8 min', 'bg-[var(--color-bus-bg)] text-[var(--color-bus-title)]'],
              ['calendar', 'Events', '3 today', 'bg-[var(--color-events-bg)] text-[var(--color-events-color)]'],
            ].map(([ic, t, s, c]) => (
              <div key={t} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[10px] p-3">
                <div className={`w-[34px] h-[34px] rounded-lg flex items-center justify-center mb-2 ${c}`}>
                  <Icon name={ic} size={17} />
                </div>
                <div className="text-[13px] font-medium text-[var(--color-txt-0)]">{t}</div>
                <div className="text-[11px] text-[var(--color-txt-2)] mt-0.5">{s}</div>
              </div>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 gap-2.5">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[10px] p-3">
              <div className="text-[10px] font-semibold text-[var(--color-txt-2)] uppercase tracking-wider mb-2">
                Next class
              </div>
              <div className="bg-[var(--color-cls-bg)] rounded-lg p-2.5">
                <div className="text-[10px] font-semibold text-[var(--color-cls-sub)] tracking-wide">CS 30200</div>
                <div className="text-[13px] font-medium text-[var(--color-cls-title)] my-0.5">Software Engineering</div>
                <div className="text-[11px] text-[var(--color-cls-sub)]">ET 215 · 1:30 PM · Prof. Nguyen</div>
              </div>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[10px] p-3">
              <div className="text-[10px] font-semibold text-[var(--color-txt-2)] uppercase tracking-wider mb-2">
                Events today
              </div>
              {[
                ['#2D5A87', 'Hackathon Kickoff', '10 AM'],
                ['#2E8B40', 'Spring Career Fair', '12 PM'],
                ['#7A3055', 'Student Org Showcase', '3 PM'],
              ].map(([color, title, time]) => (
                <div
                  key={title}
                  className="flex items-center gap-2 py-1.5 border-b border-[var(--color-border)] last:border-0"
                >
                  <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ background: color }} />
                  <span className="text-[11px] font-medium text-[var(--color-txt-0)] flex-1">{title}</span>
                  <span className="text-[10px] text-[var(--color-txt-2)]">{time}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <section id="features" className="py-20 px-5 sm:px-8 bg-[var(--color-bg-1)]">
        <div className="max-w-[1100px] mx-auto">
          <div className="text-center mb-12">
            <div className="text-[11px] font-bold tracking-[0.1em] uppercase text-[var(--color-gold)] mb-3">
              Everything you need
            </div>
            <h2 className="text-[clamp(1.6rem,3vw,2.4rem)] font-bold tracking-tight text-[var(--color-txt-0)] mb-3">
              One hub for campus life
            </h2>
            <p className="text-[15px] text-[var(--color-txt-1)] max-w-[540px] mx-auto leading-relaxed">
              No more juggling a dozen different apps. IndyAssist brings it all together in a clean, fast interface.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {featCards.map(({ icon, title, desc, wrap }) => (
              <div
                key={title}
                className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[14px] p-5 transition-all hover:border-[var(--color-border-2)] hover:-translate-y-0.5 hover:shadow-lg"
              >
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center mb-4 ${wrap}`}>
                  <Icon name={icon} size={22} />
                </div>
                <div className="text-[15px] font-semibold text-[var(--color-txt-0)] mb-1.5">{title}</div>
                <p className="text-[13px] text-[var(--color-txt-1)] leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="integrations" className="py-20 px-5 sm:px-8 max-w-[1100px] mx-auto">
        <div className="text-center mb-4">
          <div className="text-[11px] font-bold tracking-[0.1em] uppercase text-[var(--color-gold)] mb-3">
            Integrations
          </div>
          <h2 className="text-[clamp(1.6rem,3vw,2.4rem)] font-bold tracking-tight text-[var(--color-txt-0)] mb-3">
            Plugged into campus systems
          </h2>
          <p className="text-[15px] text-[var(--color-txt-1)] max-w-[540px] mx-auto leading-relaxed">
            IndyAssist connects to the systems you already use, pulling in real data so you&apos;re never out of the loop.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 justify-center mt-8">
          {integrations.map(([icon, label]) => (
            <div
              key={label}
              className="flex items-center gap-2.5 text-[13px] font-medium text-[var(--color-txt-0)] bg-[var(--color-bg-1)] border border-[var(--color-border)] rounded-[10px] px-4 py-2.5 hover:border-[var(--color-border-2)] hover:-translate-y-px transition-all"
            >
              <Icon name={icon} size={18} className="text-[var(--color-txt-2)]" />
              {label}
            </div>
          ))}
        </div>
      </section>

      <section className="relative py-20 px-5 sm:px-8 text-center overflow-hidden bg-gradient-to-br from-[var(--color-gold-dark)] via-[#5c3a00] to-[#3E2200] dark:from-[#2a1800] dark:via-[#3e2400] dark:to-[#1e1000]">
        <div
          className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse, rgba(207,185,145,0.15) 0%, transparent 70%)',
          }}
        />
        <div className="relative text-[11px] font-bold tracking-[0.1em] uppercase text-[var(--color-gold)]/70 mb-3">
          Ready to get started?
        </div>
        <h2 className="relative text-[clamp(1.6rem,3vw,2.4rem)] font-bold tracking-tight text-[var(--color-gold)] mb-3">
          Join IndyAssist today
        </h2>
        <p className="relative text-[15px] text-[var(--color-gold)]/70 mb-8 max-w-md mx-auto">
          Free for all Purdue Indianapolis students. Sign in with your university account.
        </p>
        <div className="relative flex flex-wrap gap-3 justify-center">
          {!loading && user ? (
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-7 py-3 rounded-[10px] no-underline hover:brightness-105"
            >
              <Icon name="home" size={16} />
              Open dashboard
            </Link>
          ) : (
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-7 py-3 rounded-[10px] no-underline hover:brightness-105"
            >
              <Icon name="home" size={16} />
              Sign up free
            </Link>
          )}
          {!loading && user ? (
            <button
              type="button"
              onClick={() => signOutAndRedirect()}
              className="inline-flex items-center gap-2 text-[14px] text-[var(--color-gold)] px-7 py-3 rounded-[10px] border border-[var(--color-gold)]/30 hover:bg-[var(--color-gold)]/10"
            >
              Sign out
            </button>
          ) : (
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-[14px] text-[var(--color-gold)] px-7 py-3 rounded-[10px] border border-[var(--color-gold)]/30 hover:bg-[var(--color-gold)]/10 no-underline"
            >
              Sign in
            </Link>
          )}
        </div>
      </section>

      <footer className="bg-[var(--color-bg-0)] border-t border-[var(--color-border)] py-8 px-5 text-center">
        <div className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-txt-0)] mb-2">
          <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md">
            IA
</span>
          IndyAssist
        </div>
        <div className="text-[12px] text-[var(--color-txt-2)]">
          Built for Purdue University Indianapolis students · Not an official Purdue product
        </div>
      </footer>
    </div>
  )
}
