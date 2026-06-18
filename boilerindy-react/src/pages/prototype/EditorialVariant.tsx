// PROTOTYPE — Variant B: Swiss / editorial. Quiet, light, strict type grid,
// hairline rules, numbered sections, generous whitespace, one gold accent.
// Throwaway — delete with src/pages/prototype/.
import Icon from '../../components/Icons'
import { HERO, STATS, FEATURES, TIMELINE, INTEGRATIONS, CTA, TAGLINE, FOOTER_NOTE } from './playgroundContent'

const INK = '#111111'
const MUTE = '#6B6B6B'
const LINE = '#E4E4E4'
const GOLD = '#9A7A2E'

function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 mb-8" style={{ borderTop: `1px solid ${INK}`, paddingTop: 12 }}>
      <span className="text-xs font-semibold tabular-nums" style={{ color: GOLD }}>{n}</span>
      <span className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: MUTE }}>{children}</span>
    </div>
  )
}

export default function EditorialVariant() {
  return (
    <div style={{ background: '#fff', color: INK, fontFamily: "'Inter', system-ui, sans-serif", letterSpacing: '-0.02em' }} className="min-h-screen">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 sm:px-10 py-5" style={{ borderBottom: `1px solid ${LINE}` }}>
        <span className="font-semibold tracking-tight">BoilerIndy</span>
        <div className="hidden md:flex items-center gap-8 text-sm" style={{ color: MUTE }}>
          <a href="#features" className="hover:text-black">Features</a>
          <a href="#day" className="hover:text-black">A day on campus</a>
          <a href="#stack" className="hover:text-black">Connected to</a>
        </div>
        <a href="#" className="text-sm font-medium border-b-2 pb-0.5" style={{ borderColor: GOLD }}>Get started →</a>
      </nav>

      {/* Hero — typographic cover */}
      <section className="px-6 sm:px-10 pt-16 sm:pt-24 pb-16 max-w-[1180px] mx-auto">
        <div className="flex items-baseline gap-3 mb-10">
          <span className="text-xs font-semibold" style={{ color: GOLD }}>00</span>
          <span className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: MUTE }}>{TAGLINE}</span>
        </div>
        <h1 className="font-semibold tracking-[-0.04em] leading-[0.95] max-w-[14ch]" style={{ fontSize: 'clamp(3rem, 9vw, 7.5rem)' }}>
          The whole campus, one quiet screen.
        </h1>
        <div className="grid sm:grid-cols-[1fr_1fr] gap-8 mt-12 pt-8" style={{ borderTop: `1px solid ${INK}` }}>
          <p className="text-lg leading-relaxed max-w-[44ch]" style={{ color: MUTE }}>{HERO.sub}</p>
          <div className="flex flex-col items-start gap-4 sm:items-end sm:text-right">
            <a href="#" className="text-base font-medium border-b-2 pb-1" style={{ borderColor: INK }}>{HERO.primaryCta}</a>
            <a href="#features" className="text-base" style={{ color: MUTE }}>{HERO.secondaryCta} ↓</a>
          </div>
        </div>

        {/* Stats as a hairline row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 mt-16">
          {STATS.map((s) => (
            <div key={s.label} className="py-6" style={{ borderTop: `1px solid ${LINE}` }}>
              <div className="text-3xl font-semibold tracking-tight">{s.value}</div>
              <div className="text-xs uppercase tracking-wider mt-1" style={{ color: MUTE }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features — editorial index */}
      <section id="features" className="px-6 sm:px-10 py-16 max-w-[1180px] mx-auto">
        <SectionLabel n="01">Features — the index</SectionLabel>
        <h2 className="font-semibold tracking-[-0.03em] leading-tight mb-12 max-w-[18ch]" style={{ fontSize: 'clamp(1.8rem, 4.5vw, 3.4rem)' }}>
          Not a folder of apps. A single, opinionated home.
        </h2>
        <ol className="grid sm:grid-cols-2 gap-x-16">
          {FEATURES.map((f, i) => (
            <li key={f.title} className="grid grid-cols-[auto_1fr] gap-5 py-6 items-start" style={{ borderTop: `1px solid ${LINE}` }}>
              <span className="text-sm tabular-nums font-semibold" style={{ color: GOLD }}>{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3 className="text-lg font-medium tracking-tight">{f.title}</h3>
                <p className="text-sm mt-1.5 leading-relaxed" style={{ color: MUTE }}>{f.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Day — schedule table */}
      <section id="day" className="px-6 sm:px-10 py-16 max-w-[1180px] mx-auto">
        <SectionLabel n="02">A day on campus</SectionLabel>
        <div>
          {TIMELINE.map((step) => (
            <div key={step.time} className="grid grid-cols-[88px_1fr] sm:grid-cols-[140px_1fr] gap-6 py-7" style={{ borderTop: `1px solid ${LINE}` }}>
              <div className="text-sm font-semibold tabular-nums tracking-tight">{step.time}</div>
              <div>
                <h3 className="text-lg font-medium tracking-tight">{step.title}</h3>
                <p className="text-sm mt-1.5 leading-relaxed max-w-[60ch]" style={{ color: MUTE }}>{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Integrations — inline list */}
      <section id="stack" className="px-6 sm:px-10 py-16 max-w-[1180px] mx-auto">
        <SectionLabel n="03">Connected to</SectionLabel>
        <p className="text-2xl sm:text-3xl font-medium leading-relaxed tracking-tight" style={{ color: MUTE }}>
          {INTEGRATIONS.map(([, label], i) => (
            <span key={label}>
              <span style={{ color: INK }}>{label}</span>
              {i < INTEGRATIONS.length - 1 && <span style={{ color: GOLD }}> · </span>}
            </span>
          ))}
        </p>
      </section>

      {/* CTA */}
      <section className="px-6 sm:px-10 py-24 max-w-[1180px] mx-auto text-center" style={{ borderTop: `1px solid ${INK}` }}>
        <h2 className="font-semibold tracking-[-0.03em] leading-tight mx-auto max-w-[16ch] mb-6" style={{ fontSize: 'clamp(2rem, 5vw, 4rem)' }}>
          {CTA.headline}
        </h2>
        <p className="text-base mx-auto max-w-[46ch] mb-10" style={{ color: MUTE }}>{CTA.sub}</p>
        <a href="#" className="inline-flex items-center gap-2 text-base font-medium px-8 py-4" style={{ border: `1px solid ${INK}` }}>
          {CTA.button} <Icon name="arrowUpRight" size={16} />
        </a>
      </section>

      <footer className="px-6 sm:px-10 py-10 text-xs" style={{ borderTop: `1px solid ${LINE}`, color: MUTE }}>
        {FOOTER_NOTE}
      </footer>
    </div>
  )
}
