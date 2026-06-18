// PROTOTYPE — design playground host. Dev-only route /design-playground.
// Reads ?variant= and renders that full-page design with the floating switcher
// over it. Throwaway: delete src/pages/prototype/ once a direction is chosen,
// and remove the /design-playground route from App.tsx.
import { useSearchParams } from 'react-router-dom'
import BrutalistVariant from './BrutalistVariant'
import EditorialVariant from './EditorialVariant'
import LuxeVariant from './LuxeVariant'
import TerminalVariant from './TerminalVariant'
import PrototypeSwitcher from './PrototypeSwitcher'

type Variant = { key: string; label: string; Component: React.ComponentType }

const VARIANTS: Variant[] = [
  { key: 'A', label: 'Neo-brutalist', Component: BrutalistVariant },
  { key: 'B', label: 'Swiss / editorial', Component: EditorialVariant },
  { key: 'C', label: 'Dark luxe / glass', Component: LuxeVariant },
  { key: 'D', label: 'Retro terminal', Component: TerminalVariant },
]

export default function DesignPlayground() {
  const [params] = useSearchParams()
  const key = params.get('variant') ?? VARIANTS[0].key
  const active = VARIANTS.find((v) => v.key === key) ?? VARIANTS[0]
  const Active = active.Component

  return (
    <>
      <Active />
      <PrototypeSwitcher
        variants={VARIANTS.map(({ key, label }) => ({ key, label }))}
        current={active.key}
      />
    </>
  )
}
