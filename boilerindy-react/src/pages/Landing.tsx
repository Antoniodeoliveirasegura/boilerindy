import { Link } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import Icon from '../components/Icons'
import './marketing.css'

// BoilerIndy public landing / marketing page (route: /, the front page).
// Self-contained and data-free — it never touches the backend, so it renders
// identically in any environment. Editorial / bento direction on the
// Purdue-gold design system.

const bentoTiles = [
  {
    span: 'sm:col-span-2 lg:col-span-2 lg:row-span-2',
    icon: 'grid',
    tag: 'New',
    title: 'A dashboard that bends to you',
    desc: 'Drag, hide, and reorder every widget. Your campus — class, dining, buses, board — arranged exactly how your day actually runs. Synced across devices.',
    tone: 'gold',
    feature: true,
  },
  {
    span: '',
    icon: 'sparkles',
    title: 'Ask anything',
    desc: '“When’s my next bus?” Gemini answers in plain language.',
    tone: 'accent',
  },
  {
    span: '',
    icon: 'dining',
    title: 'Live dining',
    desc: 'Menus, hours, and what’s open right now.',
    tone: 'dining',
  },
  {
    span: 'lg:col-span-2',
    icon: 'bus',
    title: 'Buses, in human terms',
    desc: '“3 stops from you — about 6 minutes.” Real-time ETAs from your location, not a raw map dump.',
    tone: 'bus',
  },
  {
    span: '',
    icon: 'schedule',
    title: 'Free-time radar',
    desc: 'Gaps between classes turn into smart suggestions.',
    tone: 'cls',
  },
  {
    span: '',
    icon: 'document',
    title: 'Deadline triage',
    desc: 'Every assignment, ranked by what’s actually urgent.',
    tone: 'plain',
  },
  {
    span: '',
    icon: 'calendar',
    title: 'Events that fit',
    desc: 'Campus happenings matched to your open windows.',
    tone: 'events',
  },
  {
    span: '',
    icon: 'message',
    title: 'Campus board',
    desc: 'Ask, answer, upvote. The hallway, online.',
    tone: 'accent',
  },
  {
    span: '',
    icon: 'coffee',
    title: 'Free food radar',
    desc: 'Never miss leftover pizza on campus again.',
    tone: 'gold',
  },
  {
    span: '',
    icon: 'mapPin',
    title: 'Find anything',
    desc: 'Buildings, parking, resources — one tap away.',
    tone: 'map',
  },
]

const dayTimeline = [
  { time: '8:05 AM', icon: 'schedule', title: 'Heads up: CS 30200 in 25 min', body: 'Your dashboard greets you with the next class, the room, and the walk time.' },
  { time: '11:15 AM', icon: 'sparkles', title: '“You’ve got 90 free minutes”', body: 'BoilerIndy suggests a study block — and tells you Tower Dining is open until 2.' },
  { time: '12:30 PM', icon: 'dining', title: 'Lunch, sorted', body: 'Live menu shows what’s actually being served. Ask AI for the high-protein pick.' },
  { time: '2:00 PM', icon: 'bus', title: 'Catch the shuttle', body: '“Gold route is 2 stops away, ~4 minutes.” You leave at exactly the right time.' },
  { time: '4:30 PM', icon: 'coffee', title: 'Free pizza in ET', body: 'A free-food alert pings before it’s gone. You detour for a slice.' },
  { time: '9:00 PM', icon: 'message', title: 'Wind down on the board', body: 'Someone answered your “best quiet study spot?” thread. You upvote and bookmark.' },
]

const integrations = [
  ['schedule', 'Brightspace LMS'],
  ['dining', 'Campus Dining'],
  ['bus', 'IndyGo Transit'],
  ['calendar', 'Events Feed'],
  ['mapPin', 'Campus Map'],
  ['sparkles', 'Google Gemini'],
  ['book', 'University Library'],
  ['document', 'Assignment Tracker'],
  ['message', 'Community Board'],
  ['bell', 'Smart Alerts'],
]

const toneClasses: Record<string, string> = {
  gold: 'bg-[var(--color-gold)]/15 text-[var(--color-gold-dark)] dark:text-[var(--color-gold)]',
  accent: 'bg-[var(--color-accent-bg)] text-[var(--color-accent)]',
  dining: 'bg-[var(--color-dining-bg)] text-[var(--color-dining-color)]',
  bus: 'bg-[var(--color-bus-bg)] text-[var(--color-bus-title)]',
  cls: 'bg-[var(--color-cls-bg)] text-[var(--color-cls-sub)]',
  events: 'bg-[var(--color-events-bg)] text-[var(--color-events-color)]',
  map: 'bg-[var(--color-map-bg)] text-[var(--color-map-color)]',
  plain: 'bg-[var(--color-stat)] text-[var(--color-txt-1)]',
}

function Stat({ value, label }: { value: React.ReactNode; label: React.ReactNode }) {
  return (
    <div>
      <div className="text-[clamp(1.6rem,3.5vw,2.4rem)] font-bold tracking-tight text-[var(--color-txt-0)] leading-none">
        {value}
      </div>
      <div className="text-[12px] text-[var(--color-txt-2)] mt-1.5">{label}</div>
    </div>
  )
}

export default function Landing() {
  const { dark, toggleTheme } = useTheme()

  return (
    <div className="mkt min-h-screen bg-[var(--color-bg-0)] text-[var(--color-txt-0)] overflow-x-hidden">
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 h-14 px-5 sm:px-8 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)]/80 backdrop-blur-md">
        <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold no-underline text-[var(--color-txt-0)]">
          <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md tracking-wide">BI</span>
          BoilerIndy
        </Link>
        <div className="hidden md:flex items-center gap-0.5 absolute left-1/2 -translate-x-1/2">
          <a href="#features" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] no-underline">Features</a>
          <a href="#day" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] no-underline">A day on campus</a>
          <a href="#stack" className="text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] no-underline">Connected to</a>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-[var(--color-txt-1)] hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] transition-colors"
          >
            <Icon name={dark ? 'sun' : 'moon'} size={16} />
          </button>
          <Link to="/advertise" className="hidden sm:inline-flex text-[13px] text-[var(--color-txt-1)] px-3.5 py-1.5 rounded-lg hover:bg-[var(--color-bg-2)] hover:text-[var(--color-txt-0)] no-underline items-center gap-1.5">
            <Icon name="briefcase" size={13} />
            Advertise
          </Link>
          <Link to="/login" className="text-[13px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-4 py-1.5 rounded-lg no-underline inline-flex items-center gap-1.5 hover:brightness-105">
            <Icon name="sparkles" size={14} />
            Get started
          </Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative px-6 pt-16 pb-10 sm:pt-24 sm:pb-16 overflow-hidden">
        <div className="hero-bg" aria-hidden="true">
          <div className="hero-bg__grid" />
          <div className="hero-bg__aurora hero-bg__aurora--gold" />
          <div className="hero-bg__aurora hero-bg__aurora--accent" />
          <div className="hero-bg__aurora hero-bg__aurora--gold2" />
        </div>

        <div className="relative max-w-[var(--mkt-max)] mx-auto grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-8 items-center">
          {/* Left: copy */}
          <div>
            <div className="mkt-reveal inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-gold)] bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/35 rounded-full px-3.5 py-1.5 mb-6 tracking-wide">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-gold)] animate-pulse" />
              Built for Purdue Indianapolis
            </div>
            <h1 className="mkt-reveal text-[clamp(2.4rem,6vw,4.4rem)] font-bold tracking-[-0.03em] leading-[0.98] mb-6" style={{ '--mkt-delay': '80ms' } as React.CSSProperties}>
              The whole campus,
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-br from-[var(--color-gold)] via-[var(--color-gold-muted)] to-[var(--color-accent)]">
                one quiet screen.
              </span>
            </h1>
            <p className="mkt-reveal text-[1.06rem] sm:text-[1.15rem] text-[var(--color-txt-1)] max-w-[480px] leading-relaxed mb-8" style={{ '--mkt-delay': '160ms' } as React.CSSProperties}>
              Classes, dining, live buses, deadlines, events and a campus board —
              stitched together and quietly organized by AI. Stop juggling ten apps.
            </p>
            <div className="mkt-reveal flex flex-wrap gap-3 mb-10" style={{ '--mkt-delay': '240ms' } as React.CSSProperties}>
              <Link to="/login" className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] bg-[var(--color-gold)] px-6 py-3 rounded-xl no-underline shadow-lg shadow-[var(--color-gold)]/25 hover:brightness-105 hover:-translate-y-0.5 transition-all">
                <Icon name="sparkles" size={16} />
                Get started — it’s free
              </Link>
              <a href="#features" className="inline-flex items-center gap-2 text-[14px] text-[var(--color-txt-0)] px-6 py-3 rounded-xl border border-[var(--color-border-2)] hover:bg-[var(--color-bg-2)] no-underline hover:-translate-y-0.5 transition-all">
                <Icon name="arrowUpRight" size={16} />
                Take the tour
              </a>
            </div>
            <div className="mkt-reveal grid grid-cols-4 gap-5 max-w-[440px]" style={{ '--mkt-delay': '320ms' } as React.CSSProperties}>
              <Stat value="12+" label="Campus features" />
              <Stat value="Live" label="Bus & dining" />
              <Stat value="AI" label="by Gemini" />
              <Stat value="$0" label="For students" />
            </div>
          </div>

          {/* Right: layered product mock with floating chips */}
          <div className="mkt-reveal relative" style={{ '--mkt-delay': '200ms' } as React.CSSProperties}>
            <div className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] p-4">
              <div className="flex items-center gap-2 mb-3.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
                <div className="flex-1 bg-[var(--color-bg-2)] rounded-md py-1.5 px-3 text-[11px] text-[var(--color-txt-2)] font-mono">boilerindy.app/dashboard</div>
              </div>

              <div className="text-[15px] font-semibold mb-3">Good afternoon, Alex</div>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {[
                  ['mapPin', 'Map', 'bg-[var(--color-map-bg)] text-[var(--color-map-color)]'],
                  ['dining', 'Dining', 'bg-[var(--color-dining-bg)] text-[var(--color-dining-color)]'],
                  ['bus', 'Transit', 'bg-[var(--color-bus-bg)] text-[var(--color-bus-title)]'],
                ].map(([ic, t, c]) => (
                  <div key={t} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-1.5 ${c}`}>
                      <Icon name={ic} size={15} />
                    </div>
                    <div className="text-[11px] font-medium">{t}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-cls-bg)] p-3 mb-2">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-cls-sub)]">Next class</div>
                <div className="text-[13px] font-semibold text-[var(--color-cls-title)] mt-0.5">CS 30200 · Software Engineering</div>
                <div className="text-[11px] text-[var(--color-cls-sub)] mt-0.5">ET 215 · 1:30 PM · in 25 min</div>
              </div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-txt-3)]">Free time</div>
                <div className="text-[22px] font-bold leading-none mt-1">1h 30m</div>
                <div className="text-[11px] text-[var(--color-txt-2)] mt-1">Free before your next class</div>
              </div>
            </div>

            {/* Floating chips */}
            <div className="mkt-float absolute -left-4 sm:-left-7 top-24 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)] px-3 py-2.5 flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-[var(--color-bus-bg)] text-[var(--color-bus-title)] flex items-center justify-center">
                <Icon name="bus" size={15} />
              </div>
              <div>
                <div className="text-[11px] font-semibold leading-tight">Gold route</div>
                <div className="text-[10px] text-[var(--color-txt-2)]">2 stops · ~4 min</div>
              </div>
            </div>
            <div className="mkt-float mkt-float--slow absolute -right-3 sm:-right-6 bottom-16 rounded-xl border border-[var(--color-gold)]/30 bg-[var(--color-gold)]/10 backdrop-blur-sm shadow-[var(--shadow-lg)] px-3 py-2.5 flex items-center gap-2.5 max-w-[200px]">
              <div className="w-8 h-8 rounded-lg bg-[var(--color-gold)]/25 text-[var(--color-gold-dark)] dark:text-[var(--color-gold)] flex items-center justify-center shrink-0">
                <Icon name="sparkles" size={15} />
              </div>
              <div className="text-[11px] font-medium leading-snug text-[var(--color-txt-1)]">
                “Good window for a study block before SWE.”
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features bento ──────────────────────────────────────────────── */}
      <section id="features" className="px-5 sm:px-8 py-16 sm:py-24">
        <div className="max-w-[var(--mkt-max)] mx-auto">
          <div className="max-w-[600px] mb-10 sm:mb-14">
            <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--color-gold)] mb-3">Everything, in its place</div>
            <h2 className="text-[clamp(1.8rem,4vw,2.8rem)] font-bold tracking-[-0.02em] leading-tight">
              Not a folder of apps. <span className="text-[var(--color-txt-2)]">A single, opinionated home.</span>
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 auto-rows-[minmax(150px,auto)] gap-3.5">
            {bentoTiles.map((tile) => (
              <article
                key={tile.title}
                className={`mkt-tile rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 flex flex-col ${tile.span} ${
                  tile.feature ? 'justify-between bg-gradient-to-br from-[var(--color-gold)]/12 to-transparent' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${toneClasses[tile.tone]}`}>
                    <Icon name={tile.icon} size={tile.feature ? 24 : 20} />
                  </div>
                  {tile.tag && (
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-gold-dark)] dark:text-[var(--color-gold)] bg-[var(--color-gold)]/25 rounded-full px-2.5 py-1">
                      {tile.tag}
                    </span>
                  )}
                </div>
                <div className={tile.feature ? 'mt-6' : 'mt-4'}>
                  <h3 className={`font-semibold tracking-tight ${tile.feature ? 'text-[1.35rem] mb-2' : 'text-[15px] mb-1.5'}`}>
                    {tile.title}
                  </h3>
                  <p className={`text-[var(--color-txt-1)] leading-relaxed ${tile.feature ? 'text-[14px] max-w-[420px]' : 'text-[13px]'}`}>
                    {tile.desc}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── A day on campus ─────────────────────────────────────────────── */}
      <section id="day" className="relative mkt-grain px-5 sm:px-8 py-16 sm:py-24 overflow-hidden bg-gradient-to-br from-[var(--color-gold-dark)] via-[#4a3209] to-[#1e1606] dark:from-[#1a1206] dark:via-[#241a08] dark:to-[#100b04]">
        <div className="relative max-w-[var(--mkt-max)] mx-auto">
          <div className="max-w-[560px] mb-12">
            <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--color-gold)] mb-3">A Tuesday, narrated</div>
            <h2 className="text-[clamp(1.8rem,4vw,2.8rem)] font-bold tracking-[-0.02em] leading-tight text-[var(--color-gold-light)]">
              One app, from your first class to the last slice of pizza.
            </h2>
          </div>

          <ol className="list-none m-0 p-0 grid sm:grid-cols-2 gap-x-10 gap-y-2">
            {dayTimeline.map((step, i) => (
              <li key={step.time} className="relative flex gap-4 py-4 border-b border-[var(--color-gold)]/15">
                <div className="flex flex-col items-center shrink-0">
                  <div className="w-10 h-10 rounded-xl bg-[var(--color-gold)]/15 border border-[var(--color-gold)]/30 text-[var(--color-gold-light)] flex items-center justify-center">
                    <Icon name={step.icon} size={18} />
                  </div>
                  {i < dayTimeline.length - 1 && <div className="w-px flex-1 bg-[var(--color-gold)]/15 mt-2 hidden sm:block" />}
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] font-bold tracking-wider text-[var(--color-gold)]/80 tabular-nums">{step.time}</div>
                  <div className="text-[15px] font-semibold text-[var(--color-gold-light)] mt-0.5">{step.title}</div>
                  <p className="text-[13px] text-[var(--color-gold-light)]/60 mt-1 leading-relaxed">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Integrations marquee ────────────────────────────────────────── */}
      <section id="stack" className="px-5 sm:px-8 py-16 sm:py-20">
        <div className="max-w-[var(--mkt-max)] mx-auto">
          <div className="text-center mb-10">
            <div className="text-[11px] font-bold tracking-[0.12em] uppercase text-[var(--color-gold)] mb-3">Real data, real-time</div>
            <h2 className="text-[clamp(1.5rem,3vw,2.2rem)] font-bold tracking-tight">Plugged into the systems you already use</h2>
          </div>
          <div className="mkt-marquee-mask">
            <div className="mkt-marquee gap-3">
              {[...integrations, ...integrations].map(([icon, label], i) => (
                <div
                  key={`${label}-${i}`}
                  className="flex items-center gap-2.5 text-[13px] font-medium text-[var(--color-txt-0)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl px-4 py-2.5 whitespace-nowrap shrink-0"
                >
                  <Icon name={icon} size={17} className="text-[var(--color-txt-2)]" />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section className="px-5 sm:px-8 pb-20">
        <div className="relative max-w-[var(--mkt-max)] mx-auto rounded-3xl overflow-hidden mkt-grain bg-gradient-to-br from-[var(--color-gold)] via-[var(--color-gold-muted)] to-[#9a7832] text-[var(--color-gold-dark)] px-8 py-16 sm:py-20 text-center">
          <div className="relative">
            <h2 className="text-[clamp(1.8rem,4vw,3rem)] font-bold tracking-[-0.02em] leading-tight mb-4 text-[var(--color-gold-dark)]">
              Your campus is ready when you are.
            </h2>
            <p className="text-[15px] sm:text-[16px] text-[var(--color-gold-dark)]/75 max-w-[460px] mx-auto mb-8">
              Free for every Purdue Indianapolis student. Sign in with your university account and your dashboard builds itself.
            </p>
            <div className="flex flex-wrap gap-3 justify-center">
              <Link to="/login" className="inline-flex items-center gap-2 text-[14px] font-bold bg-[var(--color-gold-dark)] text-[var(--color-gold)] px-7 py-3.5 rounded-xl no-underline hover:-translate-y-0.5 transition-transform">
                <Icon name="home" size={16} />
                Get started free
              </Link>
              <Link to="/" className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--color-gold-dark)] px-7 py-3.5 rounded-xl border border-[var(--color-gold-dark)]/30 hover:bg-[var(--color-gold-dark)]/10 no-underline transition-colors">
                Explore the app
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-[var(--color-border)] py-10 px-5 text-center">
        <div className="inline-flex items-center gap-2 text-[14px] font-semibold mb-2">
          <span className="bg-[var(--color-gold)] text-[var(--color-gold-dark)] text-[10px] font-bold px-2.5 py-1 rounded-md">BI</span>
          BoilerIndy
        </div>
        <div className="text-[12px] mb-2.5">
          <Link to="/advertise" className="inline-flex items-center gap-1.5 text-[var(--color-accent)] hover:underline">
            <Icon name="briefcase" size={13} />
            Advertise with us
          </Link>
        </div>
        <div className="text-[12px] text-[var(--color-txt-2)]">
          A student-built campus companion for Purdue University Indianapolis · Not an official Purdue product
        </div>
      </footer>
    </div>
  )
}
