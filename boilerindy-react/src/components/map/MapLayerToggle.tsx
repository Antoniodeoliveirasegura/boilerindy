import Icon from '../Icons'
import { MAP_LAYERS, type MapLayerId, type MapLayerState } from './mapLayers'

type Props = {
  layers: MapLayerState
  onToggle: (id: MapLayerId) => void
  size?: 'sm' | 'md'
  className?: string
}

/** Chip row that switches map overlays on and off (issue #158). */
export default function MapLayerToggle({ layers, onToggle, size = 'sm', className = '' }: Props) {
  const pad = size === 'md' ? 'px-3.5 py-2 text-[13px]' : 'px-3 py-1.5 text-[12px]'
  return (
    <div role="group" aria-label="Map layers" className={`flex flex-wrap gap-2 ${className}`}>
      {MAP_LAYERS.map((layer) => {
        const on = layers[layer.id]
        return (
          <button
            key={layer.id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(layer.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors ${pad} ${
              on
                ? 'bg-[var(--color-gold)]/15 border-[var(--color-gold)] text-[var(--color-txt-0)]'
                : 'bg-[var(--color-surface)] border-[var(--color-border-2)] text-[var(--color-txt-2)] hover:bg-[var(--color-surface-hover)]'
            }`}
          >
            <Icon name={layer.icon} size={size === 'md' ? 14 : 12} />
            {layer.label}
          </button>
        )
      })}
    </div>
  )
}
