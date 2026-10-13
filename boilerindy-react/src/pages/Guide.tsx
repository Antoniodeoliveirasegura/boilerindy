import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { writeFailureMessage } from '../lib/writeFailure'
import { useConfirm } from '../hooks/useConfirm'
import { useReportAndBlock } from '../hooks/useReportAndBlock'
import PageTitle from '../components/PageTitle'

// Neighborhood Guide (issue #31): student-submitted local recommendations.
const CAMPUS_CENTER: [number, number] = [39.774, -86.172]
// Basemap: Esri's keyless gray canvases (issue #160); see Map.tsx for why.
const TILE_DARK = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const TILE_LIGHT = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
const TILE_ATTRIBUTION = 'Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors'

type Rec = {
  id: string
  category?: string
  title?: string
  placeName?: string
  body?: string
  lat?: number | null
  lng?: number | null
  upvotes?: number
  upvotedByMe?: boolean
  pinned?: boolean
  isMine?: boolean
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

const CATEGORIES = [
  { key: 'food', label: 'Food', emoji: '🍔' },
  { key: 'study', label: 'Study', emoji: '📚' },
  { key: 'parking', label: 'Parking', emoji: '🅿️' },
  { key: 'safety', label: 'Safety', emoji: '🛟' },
  { key: 'other', label: 'Other', emoji: '📌' },
]
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, `${c.emoji} ${c.label}`]),
)

const EMPTY_FORM = { category: 'food', title: '', body: '', placeName: '', lat: '', lng: '' }

export default function Guide() {
  const { confirm, confirmDialog } = useConfirm()
  const { report, blockAuthor, moderationUi } = useReportAndBlock()
  const { user } = useAuth()
  const { dark } = useTheme()
  const isAdmin = Boolean(user?.isAdmin)

  const [recs, setRecs] = useState<Rec[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeCat, setActiveCat] = useState('all')

  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    track('guide_viewed')
  }, [])

  const load = useCallback((category: string) => {
    setLoading(true)
    setError('')
    const q = category && category !== 'all' ? `?category=${encodeURIComponent(category)}` : ''
    authRequest(`/api/guide${q}`)
      .then((data) => {
        const d = data as { recommendations?: Rec[] }
        setRecs(Array.isArray(d?.recommendations) ? d.recommendations : [])
      })
      .catch((e) => setError(errorText(e, 'Could not load the guide.')))
      .finally(() => setLoading(false))
  }, [])

  // Initial load. `loading` already starts true, so we fetch directly and only
  // setState inside async callbacks - no synchronous setState in the effect body
  // (avoids the cascading-render lint warning). Category changes go through
  // selectCategory(), an event handler, which is allowed to setState eagerly.
  useEffect(() => {
    let active = true
    authRequest('/api/guide')
      .then((data) => {
        const d = data as { recommendations?: Rec[] }
        if (active) setRecs(Array.isArray(d?.recommendations) ? d.recommendations : [])
      })
      .catch((e) => {
        if (active) setError(errorText(e, 'Could not load the guide.'))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  function selectCategory(key: string) {
    setActiveCat(key)
    load(key)
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError('')
    if (!form.title.trim()) {
      setFormError('A title is required.')
      return
    }
    setSubmitting(true)
    try {
      const payload = {
        category: form.category,
        title: form.title.trim(),
        body: form.body.trim(),
        placeName: form.placeName.trim() || undefined,
        lat: form.lat === '' ? undefined : Number(form.lat),
        lng: form.lng === '' ? undefined : Number(form.lng),
      }
      await authRequest('/api/guide', { method: 'POST', body: JSON.stringify(payload) })
      setForm(EMPTY_FORM)
      setShowForm(false)
      load(activeCat)
    } catch (err) {
      setFormError(errorText(err, 'Could not post your recommendation.'))
    } finally {
      setSubmitting(false)
    }
  }

  function toggleUpvote(rec: Rec) {
    // Optimistic; reconcile with the server response.
    setRecs((prev) =>
      prev.map((r) =>
        r.id === rec.id
          ? { ...r, upvotedByMe: !r.upvotedByMe, upvotes: (r.upvotes ?? 0) + (r.upvotedByMe ? -1 : 1) }
          : r,
      ),
    )
    authRequest(`/api/guide/${rec.id}/upvote`, { method: 'POST' })
      .then((data) => {
        const d = data as { upvotes?: number; upvotedByMe?: boolean }
        setRecs((prev) =>
          prev.map((r) =>
            r.id === rec.id ? { ...r, upvotes: d.upvotes, upvotedByMe: d.upvotedByMe } : r,
          ),
        )
      })
      .catch(() => load(activeCat))
  }

  async function handleDelete(rec: Rec) {
    if (!(await confirm({ title: 'Delete this recommendation?', confirmLabel: 'Delete', tone: 'danger' }))) return
    setRecs((prev) => prev.filter((r) => r.id !== rec.id))
    try {
      await authRequest(`/api/guide/${rec.id}`, { method: 'DELETE' })
    } catch (err) {
      // The reload brings the card back; say why (load clears the banner
      // first, so set it after). Issue #202.
      load(activeCat)
      setError(writeFailureMessage(err, 'Could not delete the recommendation. Please try again.'))
    }
  }

  // A blocked author's tips leave the guide, so it is read again (issue #192).
  async function handleBlockAuthor(rec: Rec) {
    if (await blockAuthor('guide', rec.id)) load(activeCat)
  }

  function togglePin(rec: Rec) {
    authRequest(`/api/guide/${rec.id}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned: !rec.pinned }),
    })
      .then(() => load(activeCat))
      .catch((err: unknown) => {
        load(activeCat)
        setError(writeFailureMessage(err, 'Could not update the pin. Please try again.'))
      })
  }

  const mapped = useMemo(() => recs.filter((r) => r.lat != null && r.lng != null), [recs])

  return (
    <div className="page">
      <div className="page-measure r-map">
        <PageTitle>Neighborhood Guide</PageTitle>
        {confirmDialog}
        {moderationUi}
        <header className="page-head">
          <div>
            <h1 className="page-title">Neighborhood Guide</h1>
            <p className="page-sub">
              Student picks for food, studying, parking, and staying safe around campus.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowForm((s) => !s)}
            className={`btn ${showForm ? 'btn-secondary' : 'btn-primary'}`}
          >
            <Icon name={showForm ? 'close' : 'plus'} size={16} />
            {showForm ? 'Close' : 'Add a tip'}
          </button>
        </header>

        {showForm && (
          <form onSubmit={handleSubmit} className="card card-pad mb-6 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block text-[13px] font-semibold text-[var(--color-txt-1)]">
                Category
                <select
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                  className="input mt-1.5"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
              </label>
              <label className="block text-[13px] font-semibold text-[var(--color-txt-1)]">
                Place name (optional)
                <input
                  value={form.placeName}
                  onChange={(e) => setForm((f) => ({ ...f, placeName: e.target.value }))}
                  maxLength={120}
                  className="input mt-1.5 font-normal"
                  placeholder="e.g. Greyhouse Coffee"
                />
              </label>
            </div>
            <label className="block text-[13px] font-semibold text-[var(--color-txt-1)]">
              Title
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                maxLength={120}
                className="input mt-1.5 font-normal"
                placeholder="Short, helpful headline"
              />
            </label>
            <label className="block text-[13px] font-semibold text-[var(--color-txt-1)]">
              Details (optional)
              <textarea
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                maxLength={1000}
                rows={3}
                className="input mt-1.5 font-normal resize-y"
                placeholder="Why is this a good pick?"
              />
            </label>
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block text-[13px] font-semibold text-[var(--color-txt-1)]">
                Latitude (optional, for map pin)
                <input
                  value={form.lat}
                  onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                  inputMode="decimal"
                  className="input mt-1.5 font-normal tnum"
                  placeholder="39.7740"
                />
              </label>
              <label className="block text-[13px] font-semibold text-[var(--color-txt-1)]">
                Longitude (optional)
                <input
                  value={form.lng}
                  onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                  inputMode="decimal"
                  className="input mt-1.5 font-normal tnum"
                  placeholder="-86.1720"
                />
              </label>
            </div>
            {formError && <p className="text-[13px] text-[var(--color-error)]">{formError}</p>}
            <button type="submit" disabled={submitting} className="btn btn-primary">
              {submitting ? 'Posting…' : 'Post recommendation'}
            </button>
          </form>
        )}

        {/* Category tabs */}
        <div className="flex flex-wrap gap-2 mb-5">
          {['all', ...CATEGORIES.map((c) => c.key)].map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => selectCategory(key)}
              className={`pill ${activeCat === key ? 'pill-active' : ''}`}
            >
              {key === 'all' ? '✦ All' : CATEGORY_LABEL[key]}
            </button>
          ))}
        </div>

        {/* Map of recommendations with coordinates. `isolate` keeps Leaflet's
            pane z-indexes (400 to 1000) inside the map, as on /map and /transit;
            without it the map painted over the tab bar, the assistant button
            and the open assistant panel. */}
        {mapped.length > 0 && (
          <div className="card p-0 overflow-hidden isolate mb-6 h-[260px]">
            <MapContainer center={CAMPUS_CENTER} zoom={14} className="h-full w-full">
              <TileLayer
                key={dark ? 'dark' : 'light'}
                url={dark ? TILE_DARK : TILE_LIGHT}
                attribution={TILE_ATTRIBUTION}
                maxNativeZoom={16}
                maxZoom={19}
              />
              {mapped.map((r) => (
                <CircleMarker
                  key={r.id}
                  center={[r.lat as number, r.lng as number]}
                  radius={8}
                  pathOptions={{ color: 'var(--color-map-color)', fillColor: 'var(--color-map-color)', fillOpacity: 0.6 }}
                >
                  <Popup>
                    <strong>{r.title}</strong>
                    {r.placeName ? <div>{r.placeName}</div> : null}
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
          </div>
        )}

        {error && (
          <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)] border-[var(--color-error)]/30">{error}</div>
        )}

        {loading ? (
          <p className="text-[13px] text-[var(--color-txt-3)]">Loading…</p>
        ) : recs.length === 0 ? (
          <div className="card card-pad">
            <div className="empty row">
              <span className="ico">
                <Icon name="mapPin" size={18} />
              </span>
              <div>
                <p className="font-display font-bold text-[var(--color-txt-0)]">No recommendations yet</p>
                <p className="text-[13px] mt-0.5">Be the first to add a tip for this category.</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {recs.map((rec) => (
              <div key={rec.id} className="card card-pad">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {rec.pinned && (
                        <span className="badge badge-route">
                          📌 Pinned
                        </span>
                      )}
                      <span className="chip">
                        {CATEGORY_LABEL[rec.category ?? ''] || rec.category}
                      </span>
                    </div>
                    <h3 className="text-[17px] leading-tight text-[var(--color-txt-0)] mt-2.5 break-words">{rec.title}</h3>
                    {rec.placeName && (
                      <div className="text-[13px] text-[var(--color-txt-2)] flex items-center gap-1 mt-1">
                        <Icon name="mapPin" size={13} className="text-[var(--route)]" />
                        {rec.placeName}
                      </div>
                    )}
                    {rec.body && (
                      <p className="text-[14px] text-[var(--color-txt-1)] mt-2 whitespace-pre-wrap break-words">{rec.body}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleUpvote(rec)}
                    aria-pressed={rec.upvotedByMe}
                    className={`flex flex-col items-center justify-center gap-0.5 min-w-[48px] min-h-[52px] px-2 rounded-[var(--radius-md)] border-[1.5px] transition-colors shrink-0 ${
                      rec.upvotedByMe
                        ? 'bg-[var(--route)] border-[var(--route)] text-[var(--route-on)]'
                        : 'bg-[var(--color-stat)] border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:border-[var(--color-border-3)]'
                    }`}
                  >
                    <Icon name="arrowUp" size={14} />
                    <span className="font-display font-bold text-[13px] tnum">{rec.upvotes}</span>
                  </button>
                </div>
                {/* Everyone gets the row: Report and Block author on someone
                    else's tip (issue #192), Delete on your own, Pin for admins. */}
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-[var(--color-border)]">
                  {isAdmin && (
                    <button type="button" onClick={() => togglePin(rec)} className="btn btn-ghost btn-sm">
                      {rec.pinned ? 'Unpin' : 'Pin'}
                    </button>
                  )}
                  {rec.isMine ? (
                    <button type="button" onClick={() => handleDelete(rec)} className="btn btn-ghost btn-sm text-[var(--color-error)] hover:text-[var(--color-error)]">
                      Delete
                    </button>
                  ) : (
                    <span className="mod-actions mt-0">
                      <button
                        type="button"
                        onClick={(e) => report({ targetType: 'guide', targetId: rec.id, targetLabel: 'this recommendation' }, e.currentTarget)}
                      >
                        <Icon name="flag" size={13} /> Report
                      </button>
                      <button type="button" onClick={() => void handleBlockAuthor(rec)}>
                        Block author
                      </button>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
