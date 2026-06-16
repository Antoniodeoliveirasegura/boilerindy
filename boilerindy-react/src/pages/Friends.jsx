import { useCallback, useEffect, useState } from 'react'
import Icon from '../components/Icons'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

// Friend Matching (issue #17). Privacy is opt-in (discoverable, default off):
// pre-acceptance only name, interests, and shared-course count are shown.
export default function Friends() {
  const [bio, setBio] = useState('')
  const [interests, setInterests] = useState('')
  const [discoverable, setDiscoverable] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  const [matches, setMatches] = useState([])
  const [loadingMatches, setLoadingMatches] = useState(true)
  const [matchError, setMatchError] = useState('')

  const [accepted, setAccepted] = useState([])
  const [incoming, setIncoming] = useState([])

  useEffect(() => {
    track('friends_viewed')
  }, [])

  const loadMatches = useCallback(() => {
    setLoadingMatches(true)
    authRequest('/api/me/matches')
      .then((data) => setMatches(Array.isArray(data?.matches) ? data.matches : []))
      .catch((e) => setMatchError(e?.message || 'Could not load matches.'))
      .finally(() => setLoadingMatches(false))
  }, [])

  const loadConnections = useCallback(() => {
    authRequest('/api/me/connections')
      .then((data) => {
        setAccepted(Array.isArray(data?.accepted) ? data.accepted : [])
        setIncoming(Array.isArray(data?.incoming) ? data.incoming : [])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let active = true
    authRequest('/api/me/profile-card')
      .then((data) => {
        if (!active) return
        setBio(data?.bio || '')
        setInterests((data?.interests || []).join(', '))
        setDiscoverable(Boolean(data?.discoverable))
      })
      .catch(() => {})
    // Initial matches fetch inline — loadingMatches already starts true, so we
    // only setState in async callbacks (no synchronous setState in the effect).
    authRequest('/api/me/matches')
      .then((data) => {
        if (active) setMatches(Array.isArray(data?.matches) ? data.matches : [])
      })
      .catch((e) => {
        if (active) setMatchError(e?.message || 'Could not load matches.')
      })
      .finally(() => {
        if (active) setLoadingMatches(false)
      })
    loadConnections()
    return () => {
      active = false
    }
  }, [loadConnections])

  async function saveProfile(e) {
    e.preventDefault()
    setSavingProfile(true)
    setProfileMsg('')
    try {
      await authRequest('/api/me/profile-card', {
        method: 'PUT',
        body: JSON.stringify({
          bio: bio.trim(),
          interests: interests.split(',').map((s) => s.trim()).filter(Boolean),
          discoverable,
        }),
      })
      setProfileMsg('Saved.')
      loadMatches()
    } catch (err) {
      setProfileMsg(err?.message || 'Could not save your profile.')
    } finally {
      setSavingProfile(false)
    }
  }

  function connect(match) {
    setMatches((prev) => prev.filter((m) => m.userId !== match.userId))
    authRequest('/api/connections', { method: 'POST', body: JSON.stringify({ addresseeId: match.userId }) }).catch(() => loadMatches())
  }

  function respond(req, action) {
    setIncoming((prev) => prev.filter((i) => i.userId !== req.userId))
    authRequest(`/api/connections/${req.userId}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      .then(() => loadConnections())
      .catch(() => loadConnections())
  }

  return (
    <div className="max-w-[900px] mx-auto px-6 py-8 pb-24">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">People</h1>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1">Meet classmates who share your courses.</p>
      </div>

      {/* Profile / discoverable */}
      <form onSubmit={saveProfile} className="card p-5 mb-6 space-y-3">
        <div className="text-[12px] font-semibold text-[var(--color-txt-2)] uppercase tracking-wider">Your profile</div>
        <p className="text-[12px] text-[var(--color-txt-2)]">
          Turn on “discoverable” to appear to classmates in your courses. Until you accept a request, others only see
          your name, interests, and how many courses you share — never your email or schedule. Default is off.
        </p>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={300}
          rows={2}
          placeholder="Short bio (optional)"
          className="input w-full text-[13px] px-3 py-2 resize-y"
        />
        <input
          value={interests}
          onChange={(e) => setInterests(e.target.value)}
          placeholder="Interests, comma-separated (e.g. chess, hiking)"
          className="input w-full text-[13px] px-3 py-2"
        />
        <label className="flex items-center gap-2 text-[13px] text-[var(--color-txt-1)]">
          <input type="checkbox" checked={discoverable} onChange={(e) => setDiscoverable(e.target.checked)} />
          Discoverable to classmates
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={savingProfile} className="btn btn-primary px-4 py-2.5 text-[13px] disabled:opacity-60">
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
          {profileMsg && <span className="text-[12px] text-[var(--color-txt-2)]">{profileMsg}</span>}
        </div>
      </form>

      {/* Incoming requests */}
      {incoming.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">Requests</div>
          <div className="space-y-2">
            {incoming.map((req) => (
              <div key={req.userId} className="card p-4 flex items-center justify-between gap-3">
                <span className="text-[14px] font-medium text-[var(--color-txt-0)]">{req.displayName} wants to connect</span>
                <div className="flex gap-2">
                  <button type="button" onClick={() => respond(req, 'accept')} className="btn btn-primary text-[12px] px-3 py-2">Accept</button>
                  <button type="button" onClick={() => respond(req, 'decline')} className="text-[12px] px-3 py-2 rounded-xl border border-[var(--color-border-2)] text-[var(--color-txt-2)]">Decline</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connections */}
      {accepted.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">Your connections</div>
          <div className="space-y-2">
            {accepted.map((c) => (
              <div key={c.userId} className="card p-4 flex items-center justify-between gap-3">
                <span className="text-[14px] font-medium text-[var(--color-txt-0)]">{c.displayName}</span>
                {c.email && <a href={`mailto:${c.email}`} className="text-[12px] text-[var(--color-accent)] hover:underline">{c.email}</a>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Matches */}
      <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">Suggested classmates</div>
      {matchError && <div className="card p-4 mb-4 text-[13px] text-[var(--color-error)]">{matchError}</div>}
      {loadingMatches ? (
        <p className="text-[13px] text-[var(--color-txt-3)]">Loading…</p>
      ) : !discoverable ? (
        <div className="card p-8 text-center">
          <p className="text-[14px] font-medium text-[var(--color-txt-0)]">Turn on “discoverable” to see matches</p>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">You’ll be matched with classmates who also opt in.</p>
        </div>
      ) : matches.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-[14px] font-medium text-[var(--color-txt-0)]">No matches yet</p>
          <p className="text-[13px] text-[var(--color-txt-2)] mt-1">Check back as more classmates opt in.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {matches.map((m) => (
            <div key={m.userId} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-[var(--color-txt-0)] break-words">{m.displayName}</h3>
                  <div className="text-[12px] text-[var(--color-accent)] mt-0.5">
                    {m.sharedCount} shared course{m.sharedCount === 1 ? '' : 's'}
                    {Array.isArray(m.sharedCourses) && m.sharedCourses.length > 0 && (
                      <span className="text-[var(--color-txt-3)]"> · {m.sharedCourses.join(', ')}</span>
                    )}
                  </div>
                  {Array.isArray(m.interests) && m.interests.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {m.interests.slice(0, 6).map((i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)]">{i}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => connect(m)} className="btn btn-primary text-[12px] px-3 py-2 shrink-0">
                  <Icon name="plus" size={14} />
                  Connect
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
