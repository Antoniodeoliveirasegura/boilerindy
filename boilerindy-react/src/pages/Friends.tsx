import { useCallback, useEffect, useState } from 'react'
import Icon from '../components/Icons'
import { useConfirm } from '../hooks/useConfirm'
import { useEntrance } from '../hooks/useEntrance'
import { useReportAndBlock } from '../hooks/useReportAndBlock'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'
import { writeFailureMessage } from '../lib/writeFailure'
import PageTitle from '../components/PageTitle'
import StatusBanner from '../components/StatusBanner'

// Friend Matching (issue #17). Privacy is opt-in (discoverable, default off):
// pre-acceptance only name, interests, and shared-course count are shown.
// Matches and connections can be reported, and anyone here, a request's sender
// included, can be blocked (issue #192).

// The shared field label (as on Lost and Found and Settings).
const FIELD_LABEL = 'text-[13px] font-semibold text-[var(--color-txt-1)] block mb-1.5'

type Match = {
  userId: string
  displayName?: string
  sharedCount?: number
  sharedCourses?: string[]
  interests?: string[]
}
type Connection = { userId: string; displayName?: string; email?: string }
type IncomingRequest = { userId: string; displayName?: string }

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

export default function Friends() {
  const { report, blockUser, moderationUi } = useReportAndBlock()
  const { confirm, confirmDialog } = useConfirm()
  const [bio, setBio] = useState('')
  const [interests, setInterests] = useState('')
  const [discoverable, setDiscoverable] = useState(false)
  // The form is only editable once the saved profile has loaded. Before, a
  // failed read left the blanks in place, and Save sent them as the whole
  // profile: it wiped the bio and interests and turned discoverable off.
  const [profileState, setProfileState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  const [matches, setMatches] = useState<Match[]>([])
  const [loadingMatches, setLoadingMatches] = useState(true)
  const [matchError, setMatchError] = useState('')
  // What became of the last Connect: "Request sent", or why it failed (the
  // match comes back on a failure, which used to be the only sign of it).
  const [connectNotice, setConnectNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  // The suggested classmates rise in once the matches and the profile, which
  // says whether they show, have both landed (hooks/useEntrance).
  const rowsRef = useEntrance<HTMLUListElement>(!loadingMatches && profileState === 'ready')

  const [accepted, setAccepted] = useState<Connection[]>([])
  const [incoming, setIncoming] = useState<IncomingRequest[]>([])
  const [outgoing, setOutgoing] = useState<IncomingRequest[]>([])
  const [requestError, setRequestError] = useState('')

  useEffect(() => {
    track('friends_viewed')
  }, [])

  const loadMatches = useCallback(() => {
    setLoadingMatches(true)
    // A reload that succeeds must not keep an earlier failure's message.
    setMatchError('')
    authRequest('/api/me/matches')
      .then((data) => {
        const d = data as { matches?: Match[] }
        setMatches(Array.isArray(d?.matches) ? d.matches : [])
      })
      .catch((e) => setMatchError(errorText(e, 'Could not load matches.')))
      .finally(() => setLoadingMatches(false))
  }, [])

  const loadConnections = useCallback(() => {
    authRequest('/api/me/connections')
      .then((data) => {
        const d = data as { accepted?: Connection[]; incoming?: IncomingRequest[]; outgoing?: IncomingRequest[] }
        setAccepted(Array.isArray(d?.accepted) ? d.accepted : [])
        setIncoming(Array.isArray(d?.incoming) ? d.incoming : [])
        setOutgoing(Array.isArray(d?.outgoing) ? d.outgoing : [])
      })
      .catch(() => {})
  }, [])

  // isCurrent lets the first load ignore an answer that lands after unmount.
  const loadProfile = useCallback((isCurrent: () => boolean = () => true) => {
    authRequest('/api/me/profile-card')
      .then((data) => {
        if (!isCurrent()) return
        const d = data as { bio?: string; interests?: string[]; discoverable?: boolean }
        setBio(d?.bio || '')
        setInterests((d?.interests || []).join(', '))
        setDiscoverable(Boolean(d?.discoverable))
        setProfileState('ready')
      })
      .catch(() => {
        if (isCurrent()) setProfileState('failed')
      })
  }, [])

  useEffect(() => {
    let active = true
    loadProfile(() => active)
    // Initial matches fetch inline - loadingMatches already starts true, so we
    // only setState in async callbacks (no synchronous setState in the effect).
    authRequest('/api/me/matches')
      .then((data) => {
        const d = data as { matches?: Match[] }
        if (active) setMatches(Array.isArray(d?.matches) ? d.matches : [])
      })
      .catch((e) => {
        if (active) setMatchError(errorText(e, 'Could not load matches.'))
      })
      .finally(() => {
        if (active) setLoadingMatches(false)
      })
    loadConnections()
    return () => {
      active = false
    }
  }, [loadConnections, loadProfile])

  function retryProfile() {
    setProfileState('loading')
    loadProfile()
  }

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (profileState !== 'ready') return
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
      setProfileMsg(errorText(err, 'Could not save your profile.'))
    } finally {
      setSavingProfile(false)
    }
  }

  function connect(match: Match) {
    setConnectNotice(null)
    setMatches((prev) => prev.filter((m) => m.userId !== match.userId))
    authRequest('/api/connections', { method: 'POST', body: JSON.stringify({ addresseeId: match.userId }) })
      .then(() => setConnectNotice({ tone: 'success', text: `Request sent to ${match.displayName || 'your classmate'}.` }))
      .catch((err: unknown) => {
        // The reload brings the classmate back; say why (as respond does).
        loadMatches()
        setConnectNotice({ tone: 'error', text: writeFailureMessage(err, 'Could not send the request. Please try again.') })
      })
  }

  function respond(req: IncomingRequest, action: 'accept' | 'decline') {
    setRequestError('')
    setIncoming((prev) => prev.filter((i) => i.userId !== req.userId))
    authRequest(`/api/connections/${req.userId}`, { method: 'PATCH', body: JSON.stringify({ action }) })
      .then(() => loadConnections())
      .catch((err: unknown) => {
        // The reload brings the request back; say why (issue #202).
        loadConnections()
        setRequestError(writeFailureMessage(err, `Could not ${action} the request. Please try again.`))
      })
  }

  // Cancels a sent request, or ends an accepted connection. Either way the
  // classmate can show up in matches again.
  async function disconnect(person: { userId: string; displayName?: string }, kind: 'cancel' | 'remove') {
    const name = person.displayName || 'this student'
    if (
      kind === 'remove' &&
      !(await confirm({
        title: `Remove ${name}?`,
        message: 'You will no longer see each other’s email. You can send a new request later.',
        confirmLabel: 'Remove',
        tone: 'danger',
      }))
    ) {
      return
    }
    setRequestError('')
    try {
      await authRequest(`/api/connections/${person.userId}`, { method: 'DELETE' })
    } catch (err) {
      setRequestError(
        writeFailureMessage(err, kind === 'cancel' ? 'Could not cancel the request. Please try again.' : 'Could not remove the connection. Please try again.'),
      )
    }
    loadConnections()
    loadMatches()
  }

  function reportUser(person: { userId: string; displayName?: string }, opener: HTMLElement) {
    report({ targetType: 'user', targetId: person.userId, targetLabel: person.displayName || 'this student' }, opener)
  }

  // A block ends any connection or request between the two and takes each out
  // of the other's matches, so both lists are read again.
  async function handleBlock(person: { userId: string; displayName?: string }) {
    if (!(await blockUser(person.userId, person.displayName || 'this student'))) return
    loadMatches()
    loadConnections()
  }

  const initial = (name?: string) => (name || '').trim().charAt(0).toUpperCase()

  return (
    <div className="page r-ink">
      <div className="page-measure">
        <PageTitle>People</PageTitle>
        {moderationUi}
        {confirmDialog}
        <header className="page-head">
          <div>
            <h1 className="page-title">People</h1>
            <p className="page-sub">Meet classmates who share your courses.</p>
          </div>
        </header>

        <div className="space-y-5">
          {/* Profile / discoverable */}
          <form onSubmit={saveProfile} className="card card-pad space-y-3.5">
            <div className="card-head mb-3.5">
              <span className="route-badge" aria-hidden="true">
                <Icon name="user" size={18} />
              </span>
              <div className="card-title">Your profile</div>
            </div>
            <p className="text-[14px] leading-relaxed text-[var(--color-txt-2)] max-w-[40rem]">
              Turn on “discoverable” to appear to classmates in your courses. Until you accept a request, others only see
              your name, interests, and how many courses you share - never your email or schedule. Default is off.
            </p>
            {profileState === 'failed' && (
              <div className="flex flex-wrap items-center gap-3">
                <StatusBanner tone="error">Could not load your profile, so it cannot be edited right now.</StatusBanner>
                <button type="button" onClick={retryProfile} className="btn btn-secondary btn-sm">
                  Try again
                </button>
              </div>
            )}
            {/* Visible labels (the copy the placeholders used to carry), so
                a filled-in profile still says what each field is. */}
            <div className="grid gap-3.5">
              <div>
                <label htmlFor="friends-bio" className={FIELD_LABEL}>Short bio (optional)</label>
                <textarea
                  id="friends-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  disabled={profileState !== 'ready'}
                  maxLength={300}
                  rows={2}
                  className="input resize-y block"
                />
              </div>
              <div>
                <label htmlFor="friends-interests" className={FIELD_LABEL}>Interests, comma-separated (e.g. chess, hiking)</label>
                <input
                  id="friends-interests"
                  value={interests}
                  onChange={(e) => setInterests(e.target.value)}
                  disabled={profileState !== 'ready'}
                  className="input"
                />
              </div>
            </div>
            <label className="flex items-center gap-2.5 min-h-[40px] text-[14px] text-[var(--color-txt-1)] cursor-pointer">
              <input
                type="checkbox"
                checked={discoverable}
                onChange={(e) => setDiscoverable(e.target.checked)}
                disabled={profileState !== 'ready'}
                className="w-4 h-4 accent-[var(--color-txt-0)]"
              />
              Discoverable to classmates
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={savingProfile || profileState !== 'ready'} className="btn btn-primary">
                {savingProfile ? 'Saving…' : 'Save profile'}
              </button>
              {profileMsg && <span className="text-[13px] text-[var(--color-txt-2)]">{profileMsg}</span>}
            </div>
          </form>

          {/* Incoming requests */}
          {requestError && (
            <div role="alert" className="card px-4 py-3 border-[var(--color-error)]/40 text-[14px] text-[var(--color-error)]">
              {requestError}
            </div>
          )}
          {incoming.length > 0 && (
            <section className="card card-pad">
              <div className="card-head">
                <span className="route-badge" aria-hidden="true">
                  <Icon name="bell" size={18} />
                </span>
                <div className="card-title">Requests</div>
              </div>
              <ul className="-mt-1">
                {incoming.map((req) => (
                  <li key={req.userId} className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-x-3.5 py-3 border-t border-[var(--color-border)] first:border-t-0">
                    <span className="ava" aria-hidden="true">{initial(req.displayName)}</span>
                    <div className="min-w-0 flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2">
                      {/* The name line keeps the avatar's 36px height, so the
                          actions line under it needs no top margin of its own. */}
                      <div className="min-w-0">
                        <span className="min-h-9 min-w-0 flex items-center font-display font-bold text-[15px] text-[var(--color-txt-0)] [overflow-wrap:anywhere]">{req.displayName} wants to connect</span>
                        <div className="mod-actions mt-0">
                          <button type="button" onClick={() => void handleBlock(req)}>Block</button>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => respond(req, 'accept')} className="btn btn-ink btn-sm">Accept</button>
                        <button type="button" onClick={() => respond(req, 'decline')} className="btn btn-secondary btn-sm">Decline</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Connections */}
          {accepted.length > 0 && (
            <section className="card card-pad">
              <div className="card-head">
                <span className="route-badge" aria-hidden="true">
                  <Icon name="users" size={18} />
                </span>
                <div className="card-title">Your connections</div>
              </div>
              <ul className="-mt-1">
                {accepted.map((c) => (
                  <li key={c.userId} className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-x-3.5 py-3 border-t border-[var(--color-border)] first:border-t-0">
                    <span className="ava" aria-hidden="true">{initial(c.displayName)}</span>
                    <div className="min-w-0">
                      <div className="min-h-9 min-w-0 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                        <span className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">{c.displayName}</span>
                        {c.email && <a href={`mailto:${c.email}`} className="text-[13px] text-[var(--color-accent)] hover:underline underline-offset-[3px] [overflow-wrap:anywhere]">{c.email}</a>}
                      </div>
                      <div className="mod-actions mt-0">
                        <button type="button" onClick={(e) => reportUser(c, e.currentTarget)}>
                          <Icon name="flag" size={13} />
                          Report user
                        </button>
                        <button type="button" onClick={() => void handleBlock(c)}>Block</button>
                        <button type="button" onClick={() => void disconnect(c, 'remove')}>Remove</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Sent requests */}
          {outgoing.length > 0 && (
            <section className="card card-pad">
              <div className="card-head">
                <span className="route-badge" aria-hidden="true">
                  <Icon name="plus" size={18} />
                </span>
                <div className="card-title">Sent requests</div>
              </div>
              <ul className="-mt-1">
                {outgoing.map((req) => (
                  <li key={req.userId} className="grid grid-cols-[36px_minmax(0,1fr)] items-center gap-x-3.5 py-3 border-t border-[var(--color-border)] first:border-t-0">
                    <span className="ava" aria-hidden="true">{initial(req.displayName)}</span>
                    <div className="min-w-0 flex flex-wrap items-center justify-between gap-x-3.5 gap-y-2">
                      <span className="min-w-0 font-display font-bold text-[15px] text-[var(--color-txt-0)] [overflow-wrap:anywhere]">{req.displayName}</span>
                      <button type="button" onClick={() => void disconnect(req, 'cancel')} className="btn btn-secondary btn-sm">Cancel request</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Matches */}
          <section className="card card-pad">
            <div className="card-head">
              <span className="route-badge" aria-hidden="true">
                <Icon name="users" size={18} />
              </span>
              <div className="card-title">Suggested classmates</div>
            </div>
            {matchError && <div className="mb-3 text-[14px] text-[var(--color-error)]">{matchError}</div>}
            {connectNotice && (
              <StatusBanner tone={connectNotice.tone} className="mb-3">
                {connectNotice.text}
              </StatusBanner>
            )}
            {loadingMatches ? (
              <p className="text-[14px] text-[var(--color-txt-2)]">Loading…</p>
            ) : !discoverable ? (
              <div className="empty row">
                <span className="ico">
                  <Icon name="eyeOff" size={18} />
                </span>
                <div>
                  <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">Turn on “discoverable” to see matches</p>
                  <p className="mt-0.5">You’ll be matched with classmates who also opt in.</p>
                </div>
              </div>
            ) : matches.length === 0 ? (
              <div className="empty row">
                <span className="ico">
                  <Icon name="users" size={18} />
                </span>
                <div>
                  <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No matches yet</p>
                  <p className="mt-0.5">Check back as more classmates opt in.</p>
                </div>
              </div>
            ) : (
              <ul ref={rowsRef} className="-mt-1">
                {matches.map((m) => (
                  <li key={m.userId} className="grid grid-cols-[36px_minmax(0,1fr)] gap-x-3.5 py-4 border-t border-[var(--color-border)] first:border-t-0">
                    <span className="ava" aria-hidden="true">{initial(m.displayName)}</span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                        <div className="min-w-0">
                          <h3 className="row-title break-words">{m.displayName}</h3>
                          <div className="text-[13px] font-semibold text-[var(--color-txt-1)] mt-0.5 tnum">
                            {m.sharedCount} shared course{m.sharedCount === 1 ? '' : 's'}
                            {Array.isArray(m.sharedCourses) && m.sharedCourses.length > 0 && (
                              <span className="font-normal text-[var(--color-txt-2)]"> · {m.sharedCourses.join(', ')}</span>
                            )}
                          </div>
                        </div>
                        <button type="button" onClick={() => connect(m)} className="btn btn-secondary btn-sm shrink-0">
                          <Icon name="plus" size={14} />
                          Connect
                        </button>
                      </div>
                      {Array.isArray(m.interests) && m.interests.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {m.interests.slice(0, 6).map((i) => (
                            <span key={i} className="chip">{i}</span>
                          ))}
                        </div>
                      )}
                      <div className="mod-actions">
                        <button type="button" onClick={(e) => reportUser(m, e.currentTarget)}>
                          <Icon name="flag" size={13} />
                          Report user
                        </button>
                        <button type="button" onClick={() => void handleBlock(m)}>Block</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
