import Icon from '../Icons'
import { MAP_LAYERS, type MapLayerId, type MapLayerState } from './mapLayers'

type Props = {
  layers: MapLayerState
  onToggle: (id: MapLayerId) => void
  size?: 'sm' | 'md'
  /** `paper` sits on a surface (the sidebar); `ink` floats over the map as ink plates. */
  tone?: 'paper' | 'ink'
  className?: string
}

// Each chip's badge keys what the layer draws: buildings are the Map line
// (teal), like their outlines. Garage pins are coloured by status, not by a
// line, so the parking badge stays neutral.
const LAYER_ROUTE: Record<MapLayerId, string> = {
  buildings: 'r-map',
  parking: 'r-ink',
}

// The neutral badge is the chip's own text colour, so on a switched-on chip
// (an inverted plate) it would vanish; there it flips to the plate's ground.
const NEUTRAL_BADGE_ON: Record<NonNullable<Props['tone']>, string> = {
  paper: 'bg-[var(--color-surface)] text-[var(--color-txt-0)]',
  ink: 'bg-[var(--color-ink-lift)] text-[var(--color-ink-txt)]',
}

// On the map each chip is a 44px ink plate, level with the search and locate
// buttons; the switched-on one inverts to a white plate with the amber
// underline, the way .pill-active does on paper.
const INK_BASE =
  'ink-panel inline-flex items-center gap-2 h-11 shrink-0 pl-2.5 pr-3.5 rounded-[var(--radius-lg)] font-display font-bold text-[13px] leading-none whitespace-nowrap transition-colors'
const INK_OFF = 'shadow-[var(--shadow-md)] hover:bg-[var(--color-ink-lift-2)]'
const INK_ON =
  'border-[var(--color-ink-txt)] bg-[var(--color-ink-txt)] text-[var(--color-ink-lift)] shadow-[inset_0_-3px_0_var(--color-ink-signal),var(--shadow-md)]'

/** Chip row that switches map overlays on and off (issue #158). */
export default function MapLayerToggle({ layers, onToggle, size = 'sm', tone = 'paper', className = '' }: Props) {
  const md = size === 'md'
  return (
    <div role="group" aria-label="Map layers" className={`flex flex-wrap gap-2 ${className}`}>
      {MAP_LAYERS.map((layer) => {
        const on = layers[layer.id]
        const look =
          tone === 'ink'
            ? `${INK_BASE} ${on ? INK_ON : INK_OFF}`
            : `pill pl-1.5 ${on ? 'pill-active' : ''} ${md ? 'min-h-[40px] text-[13px]' : ''}`
        const route = LAYER_ROUTE[layer.id]
        const badgeOn = on && route === 'r-ink' ? NEUTRAL_BADGE_ON[tone] : ''
        return (
          <button
            key={layer.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(layer.id)}
            className={look}
          >
            <span className={`route-badge sm ${route} ${badgeOn}`}>
              <Icon name={layer.icon} size={14} />
            </span>
            {layer.label}
          </button>
        )
      })}
    </div>
  )
}
