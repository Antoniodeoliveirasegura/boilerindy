// PROTOTYPE — Variant D: Retro terminal / "Campus OS". CRT dark, monospace,
// scanlines, window chrome, phosphor green + amber + gold. Techy and playful.
// Throwaway — delete with src/pages/prototype/.
import Icon from '../../components/Icons'
import { HERO, STATS, FEATURES, TIMELINE, INTEGRATIONS, CTA, FOOTER_NOTE } from './playgroundContent'

const BG = '#070B0A'
const PANEL = '#0C1311'
const GREEN = '#6EE7A0'
const AMBER = '#FFC857'
const GOLD = '#E6C77A'
const DIM = '#5E7D70'
const mono = { fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, 'SF Mono', Menlo, monospace" } as const
const logTones = [GREEN, GOLD, '#7AD4E6', AMBER, '#FF8FB1', '#C39BFF']

function WinBar({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${GREEN}33`, background: '#0A100E' }}>
      <span className="w-3 h-3 rounded-full" style={{ background: '#FF5F57' }} />
      <span className="w-3 h-3 rounded-full" style={{ background: AMBER }} />
      <span className="w-3 h-3 rounded-full" style={{ background: GREEN }} />
      <span className="ml-2 text-xs" style={{ color: DIM }}>{title}</span>
    </div>
  )
}

export default function TerminalVariant() {
  return (
    <div style={{ ...mono, background: BG, color: GREEN }} className="min-h-screen relative">
      <style>{`@keyframes biBlink{0%,49%{opacity:1}50%,100%{opacity:0}} .bi-cursor{animation:biBlink 1s step-end infinite}`}</style>
      {/* Scanline overlay */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-50" style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)', mixBlendMode: 'multiply' }} />

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 text-xs" style={{ borderBottom: `1px solid ${GREEN}33` }}>
        <span style={{ color: GOLD }}>BoilerIndy OS <span style={{ color: DIM }}>v1.0</span></span>
        <div className="hidden sm:flex gap-5" style={{ color: DIM }}>
          <a href="#features" className="hover:text-white">~/features</a>
          <a href="#day" className="hover:text-white">~/log</a>
          <a href="#stack" className="hover:text-white">~/net</a>
        </div>
        <span style={{ color: GREEN }}>● online</span>
      </div>

      {/* Hero terminal window */}
      <section className="px-4 sm:px-8 py-12 max-w-[1100px] mx-auto">
        <div className="rounded-md overflow-hidden" style={{ border: `1px solid ${GREEN}40`, background: PANEL, boxShadow: `0 0 40px ${GREEN}14` }}>
          <WinBar title="campus@boilerindy: ~" />
          <div className="p-6 sm:p-10">
            <div className="text-sm" style={{ color: DIM }}>$ boilerindy --launch</div>
            <h1 className="font-bold leading-[1.05] my-5" style={{ fontSize: 'clamp(2rem, 6vw, 4.2rem)', color: GREEN, textShadow: `0 0 18px ${GREEN}55` }}>
              The whole campus,<br />one quiet screen.<span className="bi-cursor" style={{ color: AMBER }}>_</span>
            </h1>
            <p className="text-sm sm:text-base max-w-[60ch] leading-relaxed mb-7" style={{ color: '#9FBDB0' }}># {HERO.sub}</p>
            <div className="flex flex-wrap gap-3 text-sm font-bold">
              <a href="#" className="px-5 py-2.5 rounded" style={{ background: GREEN, color: BG }}>[ RUN ]</a>
              <a href="#features" className="px-5 py-2.5 rounded" style={{ border: `1px solid ${GREEN}66`, color: GREEN }}>[ TOUR ]</a>
            </div>
          </div>
        </div>

        {/* Stats readout */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px mt-6 text-sm" style={{ background: `${GREEN}22`, border: `1px solid ${GREEN}33` }}>
          {STATS.map((s) => (
            <div key={s.label} className="px-4 py-4" style={{ background: PANEL }}>
              <span style={{ color: DIM }}>{s.label.toLowerCase().replace(/ /g, '_')}=</span>
              <span style={{ color: AMBER }}>{s.value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Features — app grid */}
      <section id="features" className="px-4 sm:px-8 py-10 max-w-[1100px] mx-auto">
        <div className="text-sm mb-5" style={{ color: DIM }}>$ ls ~/campus/apps <span style={{ color: GREEN }}>// {FEATURES.length} modules</span></div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {FEATURES.map((f) => (
            <article key={f.title} className="p-4 rounded transition-colors" style={{ border: `1px solid ${GREEN}33`, background: PANEL }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = GREEN)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = `${GREEN}33`)}>
              <div className="w-9 h-9 rounded flex items-center justify-center mb-3" style={{ border: `1px solid ${GREEN}40`, color: AMBER }}>
                <Icon name={f.icon} size={18} />
              </div>
              <h3 className="text-sm font-bold leading-tight mb-1" style={{ color: GREEN }}>{f.title}</h3>
              <p className="text-xs leading-snug" style={{ color: DIM }}>{f.desc}</p>
            </article>
          ))}
        </div>
      </section>

      {/* Day — system log */}
      <section id="day" className="px-4 sm:px-8 py-10 max-w-[1100px] mx-auto">
        <div className="rounded-md overflow-hidden" style={{ border: `1px solid ${GREEN}40`, background: '#060A09' }}>
          <WinBar title="tail -f /var/log/your-tuesday" />
          <div className="p-5 sm:p-7 text-sm space-y-2.5">
            {TIMELINE.map((step, i) => (
              <div key={step.time} className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
                <span className="shrink-0" style={{ color: DIM }}>[{step.time}]</span>
                <span className="shrink-0 font-bold uppercase text-xs px-1.5 rounded" style={{ color: logTones[i % logTones.length] }}>{step.icon}</span>
                <span style={{ color: '#BFE0D2' }}>{step.title} <span style={{ color: DIM }}>— {step.body}</span></span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Integrations — connection statuses */}
      <section id="stack" className="px-4 sm:px-8 py-10 max-w-[1100px] mx-auto">
        <div className="text-sm mb-4" style={{ color: DIM }}>$ systemctl status campus-net</div>
        <div className="grid sm:grid-cols-2 gap-x-10 gap-y-1.5 text-sm">
          {INTEGRATIONS.map(([icon, label]) => (
            <div key={label} className="flex items-center gap-3 py-1">
              <span className="font-bold" style={{ color: GREEN }}>[ OK ]</span>
              <Icon name={icon} size={14} className="opacity-60" />
              <span style={{ color: '#BFE0D2' }}>{label}</span>
              <span className="ml-auto text-xs" style={{ color: DIM }}>connected</span>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 sm:px-8 pb-16 max-w-[1100px] mx-auto">
        <div className="rounded-md p-8 sm:p-12 text-center" style={{ border: `1px solid ${AMBER}55`, background: PANEL, boxShadow: `0 0 50px ${AMBER}14` }}>
          <h2 className="text-2xl sm:text-4xl font-bold mb-4" style={{ color: AMBER, textShadow: `0 0 18px ${AMBER}44` }}>{CTA.headline}</h2>
          <p className="text-sm max-w-[52ch] mx-auto mb-7" style={{ color: '#9FBDB0' }}># {CTA.sub}</p>
          <a href="#" className="inline-block text-sm font-bold px-7 py-3 rounded" style={{ background: AMBER, color: BG }}>$ sudo get-started --free</a>
        </div>
      </section>

      <footer className="px-4 py-4 text-xs flex items-center justify-between" style={{ borderTop: `1px solid ${GREEN}33`, color: DIM }}>
        <span>{FOOTER_NOTE}</span>
        <span style={{ color: GREEN }}>EOF</span>
      </footer>
    </div>
  )
}
