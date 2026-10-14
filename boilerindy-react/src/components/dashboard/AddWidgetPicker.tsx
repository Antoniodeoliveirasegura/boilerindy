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
      className="card card-pad mt-4 border-[1.5px] border-dashed border-[var(--color-border-3)] bg-transparent shadow-none"
    >
      <div className="flex items-center gap-2 mb-3 text-[var(--color-txt-2)]">
        <Icon name="plus" size={14} />
        <span className="eyebrow bare">Add a widget</span>
      </div>
      <ul className="list-none m-0 p-0 flex flex-wrap gap-2">
        {hiddenWidgets.map(({ id, title }) => (
          <li key={id} className="list-none">
            <button type="button" onClick={() => onAdd(id)} className="btn btn-secondary btn-sm">
              <Icon name="plus" size={14} />
              {title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
