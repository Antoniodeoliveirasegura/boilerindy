// PROTOTYPE — Variant C: Dark luxe / glassmorphism. Near-black, glowing gold,
// frosted-glass panels, serif display headline. Premium, dark, layered depth.
// Throwaway — delete with src/pages/prototype/.
import Icon from '../../components/Icons'
import { HERO, STATS, FEATURES, TIMELINE, INTEGRATIONS, CTA, TAGLINE, FOOTER_NOTE } from './playgroundContent'

const BG = '#0A0A0C'
const GOLD = '#E6C77A'
const GOLD_DEEP = '#B8943F'
const TXT = '#ECEAE4'
const MUTE = '#9B988F'

const serif = { fontFamily: "'Georgia', 'Times New Roman', serif" } as const
const glass = {
  background: 'rgba(255,255,255,0.045)',
  backdropFilter: 'blur(16px) saturate(160%)',
  WebkitBackdropFilter: 'blur(16px) saturate(160%)',
  border: '1px solid rgba(255,255,255,0.09)',
} as const
const goldText = {
  background: `linear-gradient(120deg, ${GOLD} 0%, #FFF1C9 45%, ${GOLD_DEEP} 100%)`,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
} as const

export default function LuxeVariant() {
  return (
    <div style={{ background: BG, color: TXT, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen relative overflow-hidden">
      {/* Aurora glows */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute rounded-full" style={{ width: 700, height: 700, top: -200, left: '50%', marginLeft: -350, background: `radial-gradient(circle, ${GOLD}38, transparent 65%)`, filter: 'blur(80px)' }} />
        <div className="absolute rounded-full" style={{ width: 520, height: 520, bottom: -160, right: -80, background: 'radial-gradient(circle, rgba(120,90,255,0.22), transparent 65%)', filter: 'blur(90px)' }} />
      </div>

      <div className="relative">
        {/* Floating glass nav */}
        <div className="flex justify-center pt-6 px-4">
          <nav className="flex items-center gap-6 rounded-full px-5 py-2.5" style={glass}>
            <span className="font-semibold tracking-tight text-sm" style={{ color: TXT }}>BoilerIndy</span>
            <div className="hidden sm:flex items-center gap-5 text-xs" style={{ color: MUTE }}>
              <a href="#features" className="hover:text-white">Features</a>
              <a href="#day" className="hover:text-white">A day</a>
              <a href="#stack" className="hover:text-white">Connected</a>
            </div>
            <a href="#" className="text-xs font-semibold rounded-full px-3.5 py-1.5" style={{ background: GOLD, color: '#1A1408' }}>Get started</a>
          </nav>
        </div>

        {/* Hero */}
        <section className="text-center px-6 pt-20 pb-16 max-w-[860px] mx-auto">
          <span className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium mb-8" style={{ ...glass, color: GOLD }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GOLD }} /> {TAGLINE}
          </span>
          <h1 style={{ ...serif, fontSize: 'clamp(2.8rem, 7vw, 5.5rem)' }} className="leading-[1.02] tracking-tight mb-7">
            The whole campus,<br />
            <em style={goldText}>one quiet screen.</em>
          </h1>
          <p className="text-lg leading-relaxed max-w-[540px] mx-auto mb-10" style={{ color: MUTE }}>{HERO.sub}</p>
          <div className="flex flex-wrap gap-4 justify-center">
            <a href="#" className="inline-flex items-center gap-2 text-sm font-semibold rounded-xl px-7 py-3.5" style={{ background: GOLD, color: '#1A1408', boxShadow: `0 8px 40px ${GOLD}55` }}>
              <Icon name="sparkles" size={16} /> {HERO.primaryCta}
            </a>
            <a href="#features" className="inline-flex items-center gap-2 text-sm font-medium rounded-xl px-7 py-3.5" style={{ ...glass, color: TXT }}>
              {HERO.secondaryCta}
            </a>
          </div>

          {/* Glass product preview */}
          <div className="mt-16 rounded-2xl p-5 text-left" style={{ ...glass, boxShadow: '0 30px 80px rgba(0,0,0,0.5)' }}>
            <div className="grid grid-cols-3 gap-3">
              {[['mapPin', 'Map'], ['dining', 'Dining'], ['bus', 'Transit']].map(([ic, t]) => (
                <div key={t} className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-2" style={{ background: `${GOLD}22`, color: GOLD }}><Icon name={ic} size={16} /></div>
                  <div className="text-xs font-medium">{t}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 rounded-xl p-4" style={{ background: `linear-gradient(120deg, ${GOLD}1f, transparent)`, border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="text-[10px] uppercase tracking-widest" style={{ color: GOLD }}>Next class</div>
              <div className="font-medium mt-1">CS 30200 · Software Engineering</div>
              <div className="text-xs mt-0.5" style={{ color: MUTE }}>ET 215 · 1:30 PM · in 25 min</div>
            </div>
          </div>
        </section>

        {/* Stats */}
        <section className="px-6 max-w-[1080px] mx-auto mb-20">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {STATS.map((s) => (
              <div key={s.label} className="rounded-2xl p-5 text-center" style={glass}>
                <div className="text-3xl font-semibold" style={goldText}>{s.value}</div>
                <div className="text-xs mt-1" style={{ color: MUTE }}>{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Features */}
        <section id="features" className="px-6 max-w-[1080px] mx-auto py-12">
          <div className="text-center mb-12">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] mb-3" style={{ color: GOLD }}>Everything, in its place</div>
            <h2 style={{ ...serif, fontSize: 'clamp(1.8rem, 4vw, 3rem)' }} className="leading-tight">A single, opinionated home.</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <article key={f.title} className="group rounded-2xl p-6 transition-all hover:-translate-y-1" style={glass}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${GOLD}66`)}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)')}>
                <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: `${GOLD}1f`, color: GOLD, border: `1px solid ${GOLD}33` }}>
                  <Icon name={f.icon} size={20} />
                </div>
                <h3 className="font-medium text-base mb-1.5" style={serif}>{f.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: MUTE }}>{f.desc}</p>
              </article>
            ))}
          </div>
        </section>

        {/* Day timeline */}
        <section id="day" className="px-6 max-w-[760px] mx-auto py-16">
          <h2 style={{ ...serif, fontSize: 'clamp(1.8rem, 4vw, 2.8rem)' }} className="text-center leading-tight mb-12">
            A Tuesday, <em style={goldText}>narrated.</em>
          </h2>
          <div className="relative pl-8" style={{ borderLeft: `1px solid ${GOLD}40` }}>
            {TIMELINE.map((step) => (
              <div key={step.time} className="relative pb-10 last:pb-0">
                <span className="absolute -left-[41px] top-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: BG, border: `1px solid ${GOLD}`, boxShadow: `0 0 16px ${GOLD}66` }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: GOLD }} />
                </span>
                <div className="text-xs font-semibold tabular-nums mb-1" style={{ color: GOLD }}>{step.time}</div>
                <div className="font-medium" style={serif}>{step.title}</div>
                <p className="text-sm mt-1 leading-relaxed" style={{ color: MUTE }}>{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Integrations */}
        <section id="stack" className="px-6 max-w-[1080px] mx-auto py-12 text-center">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] mb-8" style={{ color: GOLD }}>Plugged into your campus</div>
          <div className="flex flex-wrap justify-center gap-3">
            {INTEGRATIONS.map(([icon, label]) => (
              <span key={label} className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm" style={{ ...glass, color: TXT }}>
                <Icon name={icon} size={15} className="opacity-70" /> {label}
              </span>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 pb-24 max-w-[900px] mx-auto">
          <div className="rounded-3xl px-8 py-16 text-center relative overflow-hidden" style={{ ...glass, boxShadow: `0 0 120px ${GOLD}33` }}>
            <h2 style={{ ...serif, fontSize: 'clamp(2rem, 4.5vw, 3.4rem)' }} className="leading-tight mb-5">{CTA.headline}</h2>
            <p className="max-w-[460px] mx-auto mb-9" style={{ color: MUTE }}>{CTA.sub}</p>
            <a href="#" className="inline-flex items-center gap-2 text-sm font-semibold rounded-xl px-8 py-4" style={{ background: GOLD, color: '#1A1408', boxShadow: `0 8px 40px ${GOLD}55` }}>
              <Icon name="home" size={16} /> {CTA.button}
            </a>
          </div>
        </section>

        <footer className="px-6 py-10 text-center text-xs" style={{ color: MUTE, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {FOOTER_NOTE}
        </footer>
      </div>
    </div>
  )
}
