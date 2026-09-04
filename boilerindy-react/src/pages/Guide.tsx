import { useCallback, useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { useConfirm } from '../hooks/useConfirm'

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
    } catch {
      load(activeCat)
    }
  }

  function togglePin(rec: Rec) {
    authRequest(`/api/guide/${rec.id}/pin`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned: !rec.pinned }),
    })
      .then(() => load(activeCat))
      .catch(() => load(activeCat))
  }

  const mapped = useMemo(() => recs.filter((r) => r.lat != null && r.lng != null), [recs])

  return (
    <div className="max-w-[900px] mx-auto px-6 py-8 pb-24">
      {confirmDialog}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Neighborhood Guide</h1>
          <p className="text-[14px] text-[var(--color-txt-2)] mt-1">
            Student picks for food, studying, parking, and staying safe around campus.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="btn btn-primary px-4 py-2.5 text-[13px] w-fit"
        >
          <Icon name="plus" size={16} />
          {showForm ? 'Close' : 'Add a tip'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="card p-5 mb-6 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-[12px] font-medium text-[var(--color-txt-1)]">
              Category
              <select
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                className="input w-full mt-1 text-[13px] px-3 py-2"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </label>
            <label className="text-[12px] font-medium text-[var(--color-txt-1)]">
              Place name (optional)
              <input
                value={form.placeName}
                onChange={(e) => setForm((f) => ({ ...f, placeName: e.target.value }))}
                maxLength={120}
                className="input w-full mt-1 text-[13px] px-3 py-2"
                placeholder="e.g. Greyhouse Coffee"
              />
            </label>
          </div>
          <label className="text-[12px] font-medium text-[var(--color-txt-1)] block">
            Title
            <input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              maxLength={120}
              className="input w-full mt-1 text-[13px] px-3 py-2"
              placeholder="Short, helpful headline"
            />
          </label>
          <label className="text-[12px] font-medium text-[var(--color-txt-1)] block">
            Details (optional)
            <textarea
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              maxLength={1000}
              rows={3}
              className="input w-full mt-1 text-[13px] px-3 py-2 resize-y"
              placeholder="Why is this a good pick?"
            />
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="text-[11px] text-[var(--color-txt-2)]">
              Latitude (optional, for map pin)
              <input
                value={form.lat}
                onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                inputMode="decimal"
                className="input w-full mt-1 text-[13px] px-3 py-2"
                placeholder="39.7740"
              />
            </label>
            <label className="text-[11px] text-[var(--color-txt-2)]">
              Longitude (optional)
              <input
                value={form.lng}
                onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                inputMode="decimal"
                className="input w-full mt-1 text-[13px] px-3 py-2"
                placeholder="-86.1720"
              />
            </label>
          </div>
          {formError && <p className="text-[12px] text-[var(--color-error)]">{formError}</p>}
          <button type="submit" disabled={submitting} className="btn btn-primary px-4 py-2.5 text-[13px] disabled:opacity-60">
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
            className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
              activeCat === key
                ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'
            }`}
          >
            {key === 'all' ? '✦ All' : CATEGORY_LABEL[key]}
          </button>
        ))}
      </div>

      {/* Map of recommendations with coordinates */}
      {mapped.length > 0 && (
        <div className="card p-0 overflow-hidden mb-6 h-[260px]">
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
                pathOptions={{ color: 'var(--color-accent)', fillColor: 'var(--color-accent)', fillOpacity: 0.6 }}
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
        <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)]">{error}</div>
      )}

      {loading ? (
        <p className="text-[13px] text-[var(--color-txt-3)]">Loading…</p>
      ) : recs.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-[14px] font-medium text-[var(--color-txt-0)]">No recommendations yet</p>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">Be the first to add a tip for this category.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {recs.map((rec) => (
            <div key={rec.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {rec.pinned && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-gold)]/15 text-[var(--color-gold-muted)] font-semibold">
                        📌 Pinned
                      </span>
                    )}
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)]">
                      {CATEGORY_LABEL[rec.category ?? ''] || rec.category}
                    </span>
                  </div>
                  <h3 className="text-[15px] font-semibold text-[var(--color-txt-0)] mt-1.5 break-words">{rec.title}</h3>
                  {rec.placeName && (
                    <div className="text-[12px] text-[var(--color-txt-2)] flex items-center gap-1 mt-0.5">
                      <Icon name="mapPin" size={12} />
                      {rec.placeName}
                    </div>
                  )}
                  {rec.body && (
                    <p className="text-[13px] text-[var(--color-txt-1)] mt-1.5 whitespace-pre-wrap break-words">{rec.body}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => toggleUpvote(rec)}
                  aria-pressed={rec.upvotedByMe}
                  className={`flex flex-col items-center justify-center px-2.5 py-1.5 rounded-xl border transition-colors shrink-0 ${
                    rec.upvotedByMe
                      ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border-2)] text-[var(--color-txt-2)] hover:bg-[var(--color-stat)]'
                  }`}
                >
                  <Icon name="arrowUp" size={14} />
                  <span className="text-[12px] font-semibold">{rec.upvotes}</span>
                </button>
              </div>
              {(rec.isMine || isAdmin) && (
                <div className="flex gap-3 mt-3 pt-3 border-t border-[var(--color-border)]">
                  {isAdmin && (
                    <button type="button" onClick={() => togglePin(rec)} className="text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-accent)]">
                      {rec.pinned ? 'Unpin' : 'Pin'}
                    </button>
                  )}
                  {rec.isMine && (
                    <button type="button" onClick={() => handleDelete(rec)} className="text-[12px] text-[var(--color-error)] hover:underline">
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
