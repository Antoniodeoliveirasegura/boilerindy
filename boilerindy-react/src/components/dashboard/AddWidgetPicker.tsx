import Icon from '../Icons'

type HiddenWidget = { id: string; title: string }

type AddWidgetPickerProps = {
  hiddenWidgets: HiddenWidget[]
  onAdd: (id: string) => void
}

/**
 * Edit-mode panel listing every hidden widget so it can be re-added to the home
 * dashboard (issue #52). Rendered only while customizing; hidden when there are
 * no hidden widgets left.
 */
export default function AddWidgetPicker({ hiddenWidgets, onAdd }: AddWidgetPickerProps) {
  if (hiddenWidgets.length === 0) return null

  return (
    <section
      aria-label="Add hidden widgets"
      className="card p-4 mt-4 border-dashed border-[var(--color-border-2)] bg-[var(--color-stat)]/40"
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon name="plus" size={14} className="text-[var(--color-txt-3)]" />
        <span className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
          Add a widget
        </span>
      </div>
      <ul className="list-none m-0 p-0 flex flex-wrap gap-2">
        {hiddenWidgets.map(({ id, title }) => (
          <li key={id} className="list-none">
            <button
              type="button"
              onClick={() => onAdd(id)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] font-medium text-[var(--color-txt-1)] hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)] transition-colors"
            >
              <Icon name="plus" size={13} />
              {title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
