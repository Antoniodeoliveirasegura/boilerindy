// Marketplace display helpers shared by the cards, the detail panel and the
// compose form (issue #32). Ported from the mobile app's lib/marketplace.ts so
// both clients agree on category labels, tints and price formatting. The web
// keeps the API's own vocabulary (priceCents, imageUrl) instead of the app's
// dollars / images[] translation.

export type Listing = {
  id: string
  title?: string
  description?: string
  category?: string
  priceCents?: number | null
  imageUrl?: string | null
  status?: string
  createdAt?: string
  isMine?: boolean
  sellerName?: string
  sellerEmail?: string | null
}

// One of the four colour groups the design tokens already define (see the
// Services page); the category tile and the detail hero use it as a backdrop.
export type CategoryTone = 'map' | 'events' | 'bus' | 'dining'

export type MarketplaceCategory = { slug: string; label: string; icon: string; tone: CategoryTone }

// The eight slugs the backend accepts (src/marketplace.mjs MARKETPLACE_CATEGORIES).
// Sending a label instead of a slug 400s the request, so the slug is the single
// source of truth for the picker, the cards and the detail row.
const MISC: MarketplaceCategory = { slug: 'misc', label: 'Misc', icon: 'grid', tone: 'dining' }

export const MARKETPLACE_CATEGORIES: MarketplaceCategory[] = [
  { slug: 'textbooks', label: 'Textbooks', icon: 'book', tone: 'map' },
  { slug: 'furniture', label: 'Furniture', icon: 'home', tone: 'dining' },
  { slug: 'electronics', label: 'Electronics', icon: 'laptop', tone: 'bus' },
  { slug: 'housing', label: 'Housing', icon: 'building', tone: 'events' },
  { slug: 'rideshare', label: 'Rideshare', icon: 'bus', tone: 'bus' },
  { slug: 'tutoring', label: 'Tutoring', icon: 'graduation', tone: 'map' },
  { slug: 'tickets', label: 'Tickets', icon: 'tag', tone: 'events' },
  MISC,
]

/** What the compose form starts on (the app starts on its first category too). */
export const FORM_DEFAULT_CATEGORY = 'textbooks'

const BY_SLUG = new Map(MARKETPLACE_CATEGORIES.map((c) => [c.slug, c]))

// Free-text categories from listings posted before the slug set existed still
// need a sensible tile. Unknown values fall back to Misc.
const LEGACY: Record<string, string> = {
  book: 'textbooks',
  books: 'textbooks',
  textbook: 'textbooks',
  tech: 'electronics',
  food: 'misc',
  dorm: 'housing',
  other: 'misc',
}

export function categoryFor(category: unknown): MarketplaceCategory {
  const raw = typeof category === 'string' ? category.trim().toLowerCase() : ''
  const slug = BY_SLUG.has(raw) ? raw : LEGACY[raw]
  return (slug && BY_SLUG.get(slug)) || MISC
}

/** Slug -> label; anything else is title-cased so an old "food" reads "Food". */
export function labelForCategory(category: unknown): string {
  const raw = typeof category === 'string' ? category.trim().toLowerCase() : ''
  if (!raw) return ''
  return BY_SLUG.get(raw)?.label ?? raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** "$45", "$12.50", "Free" for zero, "Free / contact" when no price was given. */
export function formatPrice(priceCents: number | null | undefined): string {
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) return 'Free / contact'
  if (priceCents <= 0) return 'Free'
  const dollars = priceCents / 100
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
}

/**
 * Dollars typed into the form -> integer cents. Blank means "no price" (null);
 * anything that is not a non-negative number is undefined so the form can
 * complain instead of posting $0.
 */
export function parsePriceInput(text: string): number | null | undefined {
  const trimmed = text.trim().replace(/^\$/, '')
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 100)
}

/** Cents -> what the price box should show when editing: "45", "12.50", "". */
export function centsToInput(priceCents: number | null | undefined): string {
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) return ''
  return (priceCents / 100).toFixed(2).replace(/\.00$/, '')
}

export function listingImage(listing: Pick<Listing, 'imageUrl'>): string | null {
  return typeof listing.imageUrl === 'string' && listing.imageUrl.length > 0 ? listing.imageUrl : null
}
