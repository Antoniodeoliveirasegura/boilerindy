// PROTOTYPE — Variant A: Neo-brutalist. Loud, light, hard shadows, thick black
// borders, blocky uppercase type. Self-contained palette (no theme vars) so the
// direction reads honestly. Throwaway — delete with src/pages/prototype/.
import Icon from '../../components/Icons'
import { HERO, STATS, FEATURES, TIMELINE, INTEGRATIONS, CTA, TAGLINE, FOOTER_NOTE } from './playgroundContent'

const INK = '#0A0A0A'
const PAPER = '#FFFDF4'
const GOLD = '#E8B530'
const BLUE = '#3B6CFF'
const PINK = '#FF5C8A'

const hard = (n = 6, color = INK) => ({ boxShadow: `${n}px ${n}px 0 0 ${color}` })
const blockTints = ['#FFFFFF', GOLD, BLUE, PINK, '#B5E48C', '#FFFFFF']

export default function BrutalistVariant() {
  return (
    <div style={{ background: PAPER, color: INK, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen">
      {/* Nav */}
      <nav className="flex items-center justify-between px-5 sm:px-8 py-4" style={{ borderBottom: `4px solid ${INK}` }}>
        <div className="flex items-center gap-3">
          <span className="font-black text-lg px-2 py-1" style={{ background: GOLD, border: `3px solid ${INK}` }}>BI</span>
          <span className="font-black tracking-tight text-lg uppercase">BoilerIndy</span>
        </div>
        <div className="hidden md:flex items-center gap-6 font-bold uppercase text-sm">
          <a href="#features" className="hover:underline decoration-4">Features</a>
          <a href="#day" className="hover:underline decoration-4">A day</a>
          <a href="#stack" className="hover:underline decoration-4">Connected</a>
        </div>
        <button type="button" className="font-black uppercase text-sm px-4 py-2 transition-transform active:translate-x-1 active:translate-y-1" style={{ background: INK, color: GOLD, border: `3px solid ${INK}`, ...hard(4, GOLD) }}>
          Get started
        </button>
      </nav>

      {/* Hero */}
      <section className="px-5 sm:px-8 py-12 sm:py-20 grid lg:grid-cols-[1.1fr_0.9fr] gap-10 items-center max-w-[1180px] mx-auto">
        <div>
          <span className="inline-block font-black uppercase text-xs px-3 py-1.5 mb-6" style={{ background: GOLD, border: `3px solid ${INK}` }}>
            ★ {TAGLINE}
          </span>
          <h1 className="font-black uppercase leading-[0.92] tracking-tight mb-6" style={{ fontSize: 'clamp(2.6rem, 7vw, 5rem)' }}>
            The whole campus,{' '}
            <span className="inline-block px-2" style={{ background: GOLD, boxShadow: `4px 4px 0 ${INK}` }}>one</span>{' '}
            loud screen.
          </h1>
          <p className="text-lg font-medium max-w-[460px] mb-8 leading-snug">{HERO.sub}</p>
          <div className="flex flex-wrap gap-4">
            <button type="button" className="font-black uppercase px-7 py-4 transition-transform active:translate-x-1.5 active:translate-y-1.5 active:shadow-none" style={{ background: GOLD, border: `4px solid ${INK}`, ...hard(7) }}>
              {HERO.primaryCta}
            </button>
            <button type="button" className="font-black uppercase px-7 py-4 transition-transform active:translate-x-1.5 active:translate-y-1.5 active:shadow-none" style={{ background: PAPER, border: `4px solid ${INK}`, ...hard(7) }}>
              {HERO.secondaryCta} →
            </button>
          </div>
        </div>

        {/* Product mock */}
        <div style={{ background: '#fff', border: `4px solid ${INK}`, ...hard(10) }} className="p-3">
          <div className="flex items-center gap-2 mb-3 pb-3" style={{ borderBottom: `3px solid ${INK}` }}>
            <span className="w-3.5 h-3.5 rounded-full" style={{ background: PINK, border: `2px solid ${INK}` }} />
            <span className="w-3.5 h-3.5 rounded-full" style={{ background: GOLD, border: `2px solid ${INK}` }} />
            <span className="w-3.5 h-3.5 rounded-full" style={{ background: '#B5E48C', border: `2px solid ${INK}` }} />
            <span className="ml-2 font-mono text-xs font-bold">boilerindy.app/dashboard</span>
          </div>
          <div className="font-black uppercase mb-3">Good afternoon, Alex</div>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {[['mapPin', 'Map', BLUE], ['dining', 'Dining', '#B5E48C'], ['bus', 'Transit', GOLD]].map(([ic, t, c]) => (
              <div key={t} className="p-2.5" style={{ border: `3px solid ${INK}`, background: c as string }}>
                <Icon name={ic as string} size={18} />
                <div className="font-black text-xs uppercase mt-1">{t}</div>
              </div>
            ))}
          </div>
          <div className="p-3 mb-2" style={{ border: `3px solid ${INK}`, background: GOLD }}>
            <div className="font-mono text-[10px] font-black uppercase">Next class</div>
            <div className="font-black">CS 30200 · SWE</div>
            <div className="font-mono text-xs">ET 215 · 1:30 PM · in 25 min</div>
          </div>
          <div className="p-3" style={{ border: `3px solid ${INK}` }}>
            <div className="font-mono text-[10px] font-black uppercase">Free time</div>
            <div className="font-black text-3xl">1h 30m</div>
          </div>
        </div>
      </section>

      {/* Stats */}
      <section className="max-w-[1180px] mx-auto px-5 sm:px-8 mb-16">
        <div className="grid grid-cols-2 sm:grid-cols-4" style={{ border: `4px solid ${INK}` }}>
          {STATS.map((s, i) => (
            <div key={s.label} className="p-5 text-center" style={{ borderRight: i < STATS.length - 1 ? `4px solid ${INK}` : undefined, background: i % 2 ? GOLD : '#fff' }}>
              <div className="font-black text-3xl">{s.value}</div>
              <div className="font-bold uppercase text-xs mt-1">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-[1180px] mx-auto px-5 sm:px-8 py-12">
        <h2 className="font-black uppercase tracking-tight mb-8" style={{ fontSize: 'clamp(1.8rem, 4vw, 3rem)' }}>
          Not a folder of apps.<br />A single, loud home. ✲
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((f, i) => (
            <article key={f.title} className="p-5 transition-transform hover:-translate-x-1 hover:-translate-y-1" style={{ background: blockTints[i % blockTints.length], border: `4px solid ${INK}`, ...hard(6) }}>
              <div className="inline-flex w-12 h-12 items-center justify-center mb-3" style={{ background: PAPER, border: `3px solid ${INK}` }}>
                <Icon name={f.icon} size={22} />
              </div>
              <h3 className="font-black uppercase text-base mb-1.5">{f.title}</h3>
              <p className="font-medium text-sm leading-snug">{f.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* A day on campus */}
      <section id="day" className="px-5 sm:px-8 py-16" style={{ background: INK, color: PAPER }}>
        <div className="max-w-[1180px] mx-auto">
          <h2 className="font-black uppercase tracking-tight mb-10" style={{ fontSize: 'clamp(1.8rem, 4vw, 3rem)', color: GOLD }}>
            A Tuesday, narrated.
          </h2>
          <ol className="grid sm:grid-cols-2 gap-5">
            {TIMELINE.map((step, i) => (
              <li key={step.time} className="flex gap-4 p-4" style={{ border: `3px solid ${GOLD}` }}>
                <span className="font-black text-2xl shrink-0" style={{ color: GOLD }}>{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="font-mono font-bold text-xs" style={{ color: GOLD }}>{step.time}</div>
                  <div className="font-black uppercase text-sm mt-1">{step.title}</div>
                  <p className="text-sm opacity-80 mt-1">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Integrations */}
      <section id="stack" className="max-w-[1180px] mx-auto px-5 sm:px-8 py-14">
        <h2 className="font-black uppercase text-center mb-8" style={{ fontSize: 'clamp(1.4rem, 3vw, 2rem)' }}>Plugged into your campus</h2>
        <div className="flex flex-wrap justify-center gap-3">
          {INTEGRATIONS.map(([icon, label], i) => (
            <span key={label} className="inline-flex items-center gap-2 font-bold uppercase text-xs px-4 py-2.5" style={{ background: i % 3 === 0 ? GOLD : '#fff', border: `3px solid ${INK}` }}>
              <Icon name={icon} size={15} /> {label}
            </span>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-5 sm:px-8 pb-16">
        <div className="max-w-[1180px] mx-auto p-10 sm:p-16 text-center" style={{ background: GOLD, border: `5px solid ${INK}`, ...hard(12) }}>
          <h2 className="font-black uppercase tracking-tight mb-4" style={{ fontSize: 'clamp(1.8rem, 4vw, 3rem)' }}>{CTA.headline}</h2>
          <p className="font-bold max-w-[460px] mx-auto mb-7">{CTA.sub}</p>
          <button type="button" className="font-black uppercase px-8 py-4 transition-transform active:translate-x-1.5 active:translate-y-1.5" style={{ background: INK, color: GOLD, border: `4px solid ${INK}`, ...hard(7, '#fff') }}>
            {CTA.button}
          </button>
        </div>
      </section>

      <footer className="px-5 py-8 text-center font-bold uppercase text-xs" style={{ borderTop: `4px solid ${INK}` }}>
        {FOOTER_NOTE}
      </footer>
    </div>
  )
}
