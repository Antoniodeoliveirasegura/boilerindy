import Icon from './Icons'
import { OFFICIAL_HOURS_URL } from '../lib/dining'
import {
  CAMPUS_CENTER_VENDORS_CHECKED,
  CAMPUS_CENTER_VENDORS_SOURCE,
  checkedLabel,
  vendorsByFloor,
  type CampusCenterVendor,
} from '../lib/campusCenterVendors'

// The Campus Center's food court vendors in place of a menu (issue #477): the
// Campus Center posts none to the feed, so the Dining page lists who serves
// there, one card per floor in the station cards' style, and links Dine On
// Campus for each vendor's hours. A static list, see lib/campusCenterVendors.ts.

export default function CampusCenterVendors({ name, vendors }: { name: string; vendors: readonly CampusCenterVendor[] }) {
  const floors = vendorsByFloor(vendors)
  return (
    <section aria-label={`${name} vendors`} data-dining-empty="retail" data-dining-vendors>
      <div className="empty row bg-[var(--color-surface)] mb-4">
        <span className="ico">
          <Icon name="building" size={18} />
        </span>
        <div className="flex-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">Food court and retail vendors</p>
            <p className="max-w-md">
              {name} vendors serve from their own counters, so there is no daily menu to post here. Each keeps its own hours.
            </p>
          </div>
          <a
            href={OFFICIAL_HOURS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary w-fit shrink-0 no-underline"
            data-dining-vendor-hours
          >
            Hours for each vendor
            <Icon name="arrowUpRight" size={15} />
          </a>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4 items-start">
        {floors.map(({ floor, vendors: here }) => (
          <div key={floor} className="card card-pad r-din flex flex-col" data-dining-vendor-floor={floor}>
            <div className="flex items-center gap-2.5 mb-2">
              <span className="route-badge sm">
                <Icon name="building" size={14} />
              </span>
              <h3 className="eyebrow bare leading-tight text-[var(--color-txt-0)]">{floor}</h3>
            </div>
            <ul>
              {here.map((vendor) => (
                <li key={vendor.name} className="py-2.5 border-t border-[var(--color-border)] first:border-t-0" data-dining-vendor={vendor.name}>
                  <p className="font-display font-semibold text-[14px] text-[var(--color-txt-0)]">{vendor.name}</p>
                  <p className="mt-0.5 text-[13px] leading-snug text-[var(--color-txt-2)]">{vendor.serves}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-4 text-[12.5px] leading-snug text-[var(--color-txt-2)]" data-dining-vendor-source>
        From the Campus Center&apos;s{' '}
        <a href={CAMPUS_CENTER_VENDORS_SOURCE} target="_blank" rel="noopener noreferrer" className="prose-link">
          Restaurants &amp; Services page
        </a>
        , checked {checkedLabel(CAMPUS_CENTER_VENDORS_CHECKED)}. Hours and menus for each vendor are at IU Indy Eats.
      </p>
    </section>
  )
}
