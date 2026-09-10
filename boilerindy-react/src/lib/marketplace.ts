// Marketplace display helpers shared by the cards, the detail panel and the
// compose form (issue #32). Ported from the mobile app's lib/marketplace.ts so
// both clients agree on category labels, tints and price formatting. The web
// keeps the API's own vocabulary (priceCents, imageUrl) instead of the app's
// dollars / images[] translation.

export type PriceMode = 'fixed' | 'free' | 'best_offer'

export type Listing = {
  id: string
  title?: string
  description?: string
  category?: string
  priceCents?: number | null
  /** Set price, Free, or Best offer (#177). Older rows carry none: zero means Free, null means unspecified. */
  priceMode?: PriceMode | string
  imageUrl?: string | null
  /** Ordered gallery, first image is the cover (#177). Older rows carry only imageUrl. */
  images?: string[]
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

export const PRICE_MODES: { value: PriceMode; label: string }[] = [
  { value: 'fixed', label: 'Set price' },
  { value: 'free', label: 'Free' },
  { value: 'best_offer', label: 'Best offer' },
]

/** Sellers can attach up to this many photos (cover first), matching the API and the app. */
export const MAX_LISTING_PHOTOS = 6

/** "$45", "$12.50", "Free" (zero or the Free mode), "Best offer", or "Contact for price" when unspecified. */
export function formatPrice(priceCents: number | null | undefined, priceMode?: string | null): string {
  if (priceMode === 'best_offer') return 'Best offer'
  if (priceMode === 'free') return 'Free'
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) return 'Contact for price'
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
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 100)
}

/** The mode a listing row implies when it predates price modes. */
export function priceModeOf(listing: Pick<Listing, 'priceCents' | 'priceMode'>): PriceMode {
  if (listing.priceMode === 'free' || listing.priceMode === 'best_offer' || listing.priceMode === 'fixed') return listing.priceMode
  return listing.priceCents === 0 ? 'free' : 'fixed'
}

/** Lines of the image-links box -> trimmed, de-duplicated URLs in order. */
export function parseImageLinks(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))]
}

/** Cents -> what the price box should show when editing: "45", "12.50", "". */
export function centsToInput(priceCents: number | null | undefined): string {
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) return ''
  return (priceCents / 100).toFixed(2).replace(/\.00$/, '')
}

/** Every photo in order; a row with only the legacy imageUrl yields that one. */
export function listingImages(listing: Pick<Listing, 'imageUrl' | 'images'>): string[] {
  const gallery = Array.isArray(listing.images) ? listing.images.filter((u): u is string => typeof u === 'string' && u.length > 0) : []
  if (gallery.length) return gallery
  return typeof listing.imageUrl === 'string' && listing.imageUrl.length > 0 ? [listing.imageUrl] : []
}

/** The cover photo, if any. */
export function listingImage(listing: Pick<Listing, 'imageUrl' | 'images'>): string | null {
  return listingImages(listing)[0] ?? null
}
