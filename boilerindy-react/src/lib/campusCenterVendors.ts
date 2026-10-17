// The Campus Center's food court vendors (issue #477). The Campus Center posts
// no menu to the campus menu feed (it is `kind: "retail"`), so the Dining page
// lists who serves there instead, from the Campus Center's own Restaurants &
// Services page. The list is kept by hand: re-check it each semester and move
// CAMPUS_CENTER_VENDORS_CHECKED with it (docs/dining.md). Each vendor keeps
// its own hours, on Dine On Campus; places outside the building are #28.

export type CampusCenterVendor = { name: string; floor: string; serves: string }

/** The Campus Center's slug in the feed. */
export const CAMPUS_CENTER_SLUG = 'campus-center'
export const CAMPUS_CENTER_VENDORS_SOURCE =
  'https://studentaffairs.indianapolis.iu.edu/campus-center/restaurants-services/index.html'
export const CAMPUS_CENTER_VENDORS_CHECKED = '2026-10-17'

// Floor by floor, as the building is walked; by name within a floor. What each
// serves is in our own few words, not the official page's copy.
export const CAMPUS_CENTER_VENDORS: readonly CampusCenterVendor[] = [
  { name: 'Chick-fil-A', floor: 'Level 1, Citizens Commons', serves: 'Chicken sandwiches, nuggets and salads' },
  { name: "Copperhead Jack's", floor: 'Level 1, Citizens Commons', serves: 'Tex-Mex: tacos, burritos and quesadillas' },
  { name: 'Panda Express', floor: 'Level 1, Citizens Commons', serves: 'Chinese-American plates' },
  { name: 'Pizza Hut', floor: 'Level 1, Citizens Commons', serves: 'Pizza, breadsticks and wings' },
  { name: 'The Market', floor: 'Level 1, Citizens Commons', serves: 'Grab-and-go sandwiches, snacks and drinks' },
  { name: 'IU Indianapolis Café', floor: 'Level 1', serves: 'Starbucks coffee, inside the bookstore' },
  { name: 'Sticky Notes', floor: 'Level 1', serves: 'Cinnamon rolls, brownies and cookies' },
  { name: "Tea's Me Café", floor: 'Level 1', serves: 'Teas from around the world' },
  { name: 'Caribou Coffee', floor: 'Level 2', serves: 'Coffee, tea and pastries' },
  { name: 'The Daily Bagel', floor: 'Level 2', serves: 'Bagel sandwiches for breakfast and lunch' },
]

/** The vendors grouped by floor, floors in the order they first appear. */
export function vendorsByFloor(vendors: readonly CampusCenterVendor[] = CAMPUS_CENTER_VENDORS) {
  const floors: { floor: string; vendors: CampusCenterVendor[] }[] = []
  for (const vendor of vendors) {
    const group = floors.find((f) => f.floor === vendor.floor)
    if (group) group.vendors.push(vendor)
    else floors.push({ floor: vendor.floor, vendors: [vendor] })
  }
  return floors
}

/** The Campus Center's vendors for a dining location, or none for any other. */
export function campusCenterVendorsFor(
  loc: { id?: string | null; slug?: string | null } | null | undefined,
): readonly CampusCenterVendor[] {
  if (!loc) return []
  return loc.slug === CAMPUS_CENTER_SLUG || loc.id === CAMPUS_CENTER_SLUG ? CAMPUS_CENTER_VENDORS : []
}

/** "Oct 17, 2026" for a YYYY-MM-DD date, read as a calendar day. */
export function checkedLabel(ymd: string = CAMPUS_CENTER_VENDORS_CHECKED): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
