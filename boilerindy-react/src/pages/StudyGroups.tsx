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

// Study Group Finder (issue #33). Privacy is opt-in (default off): a student only
// appears in classmate counts after turning the toggle on, and membership is
// visible only within a group. A group someone else started can be reported,
// or its creator blocked (issue #192).
const EMPTY_FORM = { title: '', description: '', meetingInfo: '', capacity: '' }

type StudyCourse = { code: string; classmateCount?: number }
type StudyGroup = {
  id: string
  courseCode?: string
  memberCount?: number
  capacity?: number
  title?: string
  meetingInfo?: string
  description?: string
  joinedByMe?: boolean
  /** The caller started the group (mapStudyGroupRow). */
  isMine?: boolean
}

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback
}

export default function StudyGroups() {
  const { report, blockAuthor, moderationUi } = useReportAndBlock()
  const { confirm, confirmDialog } = useConfirm()
  const [optIn, setOptIn] = useState(false)
  const [courses, setCourses] = useState<StudyCourse[]>([])
  const [loadingCourses, setLoadingCourses] = useState(true)
  const [coursesError, setCoursesError] = useState('')
  const [optBusy, setOptBusy] = useState(false)
  const [optError, setOptError] = useState('')

  const [selectedCourse, setSelectedCourse] = useState('')
  const [groups, setGroups] = useState<StudyGroup[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  // A course's groups rise in once they land (hooks/useEntrance). Picking
  // another course reads them again through loadingGroups, so it needs no key.
  const rowsRef = useEntrance<HTMLUListElement>(!loadingGroups)

  const [myGroups, setMyGroups] = useState<StudyGroup[]>([])
  // Join and Leave used to swallow every failure (a group that just filled,
  // the write limiter), and a double tap sent two requests. A group's button
  // now waits for its request, and a failure is told in that group's row.
  const [busyGroupIds, setBusyGroupIds] = useState<string[]>([])
  const [groupError, setGroupError] = useState<{ id: string; context: 'course' | 'mine'; message: string } | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    track('study_groups_viewed')
  }, [])

  const loadMyGroups = useCallback(() => {
    authRequest('/api/me/study-groups')
      .then((data) => {
        const d = data as { groups?: StudyGroup[] }
        setMyGroups(Array.isArray(d?.groups) ? d.groups : [])
      })
      .catch(() => setMyGroups([]))
  }, [])

  useEffect(() => {
    let active = true
    authRequest('/api/me/study-groups/courses')
      .then((data) => {
        if (!active) return
        const d = data as { optIn?: boolean; courses?: StudyCourse[] }
        setOptIn(Boolean(d?.optIn))
        setCourses(Array.isArray(d?.courses) ? d.courses : [])
      })
      .catch((e) => {
        if (active) setCoursesError(errorText(e, 'Could not load your courses.'))
      })
      .finally(() => {
        if (active) setLoadingCourses(false)
      })
    loadMyGroups()
    return () => {
      active = false
    }
  }, [loadMyGroups])

  function selectCourse(code: string) {
    setSelectedCourse(code)
    setShowCreate(false)
    setForm(EMPTY_FORM)
    setLoadingGroups(true)
    authRequest(`/api/study-groups?course=${encodeURIComponent(code)}`)
      .then((data) => {
        const d = data as { groups?: StudyGroup[] }
        setGroups(Array.isArray(d?.groups) ? d.groups : [])
      })
      .catch(() => setGroups([]))
      .finally(() => setLoadingGroups(false))
  }

  async function toggleOptIn() {
    setOptBusy(true)
    setOptError('')
    try {
      const next = !optIn
      const data = (await authRequest('/api/me/study-groups/opt-in', {
        method: 'PATCH',
        body: JSON.stringify({ optIn: next }),
      })) as { optIn?: boolean }
      setOptIn(Boolean(data?.optIn))
    } catch (err) {
      // Keep the previous state and say why the button did not change: the
      // user-write limiter's 429 message, or a generic line (issue #202).
      setOptError(writeFailureMessage(err, 'Could not update your visibility. Please try again.'))
    } finally {
      setOptBusy(false)
    }
  }

  async function createGroup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError('')
    if (!form.title.trim()) {
      setFormError('A title is required.')
      return
    }
    setSubmitting(true)
    try {
      await authRequest('/api/study-groups', {
        method: 'POST',
        body: JSON.stringify({
          courseCode: selectedCourse,
          title: form.title.trim(),
          description: form.description.trim(),
          meetingInfo: form.meetingInfo.trim(),
          // Sent as typed so the server checks it: Number('six') is NaN, which
          // JSON sends as null, and null means no limit, so a size that was not
          // a number used to create an unlimited group without a word.
          capacity: form.capacity.trim() === '' ? undefined : form.capacity.trim(),
        }),
      })
      setForm(EMPTY_FORM)
      setShowCreate(false)
      selectCourse(selectedCourse)
      loadMyGroups()
    } catch (err) {
      setFormError(errorText(err, 'Could not create the group.'))
    } finally {
      setSubmitting(false)
    }
  }

  function changeMembership(group: StudyGroup, action: 'join' | 'leave', context: 'course' | 'mine') {
    if (busyGroupIds.includes(group.id)) return
    setBusyGroupIds((ids) => [...ids, group.id])
    setGroupError(null)
    authRequest(`/api/study-groups/${group.id}/${action}`, { method: 'POST' })
      .catch((err: unknown) => {
        // The server's reason ("This group is full.", the limiter's 429) or a
        // generic line; the reload below shows the counts that caused it.
        setGroupError({ id: group.id, context, message: writeFailureMessage(err, `Could not ${action} the group. Please try again.`) })
      })
      .finally(() => {
        setBusyGroupIds((ids) => ids.filter((id) => id !== group.id))
        if (selectedCourse) selectCourse(selectedCourse)
        loadMyGroups()
      })
  }

  // Leaving does not take a group down, so its creator deletes it here.
  async function deleteGroup(group: StudyGroup, context: 'course' | 'mine') {
    if (busyGroupIds.includes(group.id)) return
    if (
      !(await confirm({
        title: 'Delete this group?',
        message: 'This removes the group for everyone in it.',
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    ) {
      return
    }
    setBusyGroupIds((ids) => [...ids, group.id])
    setGroupError(null)
    try {
      await authRequest(`/api/study-groups/${group.id}`, { method: 'DELETE' })
    } catch (err) {
      setGroupError({ id: group.id, context, message: writeFailureMessage(err, 'Could not delete the group. Please try again.') })
    } finally {
      setBusyGroupIds((ids) => ids.filter((id) => id !== group.id))
      if (selectedCourse) selectCourse(selectedCourse)
      loadMyGroups()
    }
  }

  // A blocked creator's groups leave both lists, so both are read again.
  async function handleBlockCreator(group: StudyGroup) {
    if (!(await blockAuthor('study_group', group.id))) return
    if (selectedCourse) selectCourse(selectedCourse)
    loadMyGroups()
  }

  function renderGroupCard(group: StudyGroup, context: 'course' | 'mine') {
    const busy = busyGroupIds.includes(group.id)
    const full = Boolean(group.capacity) && (group.memberCount ?? 0) >= (group.capacity ?? 0)
    return (
      <li key={group.id} className="py-4 border-t border-[var(--color-border)] first:border-t-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="code solid">
                {group.courseCode}
              </span>
              <span className="text-[12.5px] text-[var(--color-txt-2)] tnum">
                {group.memberCount}
                {group.capacity ? `/${group.capacity}` : ''} member{group.memberCount === 1 ? '' : 's'}
              </span>
            </div>
            <h3 className="row-title mt-2 break-words">{group.title}</h3>
            {group.meetingInfo && (
              <div className="text-[13px] text-[var(--color-txt-2)] flex items-center gap-1.5 mt-1">
                <Icon name="clock" size={13} />
                {group.meetingInfo}
              </div>
            )}
            {group.description && (
              <p className="text-[14px] leading-relaxed text-[var(--color-txt-1)] mt-1.5 whitespace-pre-wrap break-words">{group.description}</p>
            )}
          </div>
          {group.joinedByMe ? (
            <button
              type="button"
              onClick={() => changeMembership(group, 'leave', context)}
              disabled={busy}
              className="btn btn-ghost btn-sm shrink-0 -mr-3 text-[var(--color-txt-2)]"
            >
              Leave
            </button>
          ) : full ? (
            <button type="button" disabled className="btn btn-ink btn-sm shrink-0">
              Full
            </button>
          ) : (
            <button
              type="button"
              onClick={() => changeMembership(group, 'join', context)}
              disabled={busy}
              className="btn btn-ink btn-sm shrink-0"
            >
              Join
            </button>
          )}
        </div>
        {groupError?.id === group.id && groupError.context === context && (
          <StatusBanner tone="error" className="mt-2.5">
            {groupError.message}
          </StatusBanner>
        )}
        <div className="mod-actions">
          {context === 'mine' && group.courseCode && (
            <button
              type="button"
              onClick={() => selectCourse(group.courseCode || '')}
              className="link-btn py-1"
            >
              See all {group.courseCode} groups
            </button>
          )}
          {group.isMine ? (
            <button type="button" onClick={() => void deleteGroup(group, context)} disabled={busy}>
              <Icon name="trash" size={13} /> Delete group
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={(e) => report({ targetType: 'study_group', targetId: group.id, targetLabel: 'this group' }, e.currentTarget)}
              >
                <Icon name="flag" size={13} /> Report
              </button>
              <button type="button" onClick={() => void handleBlockCreator(group)}>
                Block author
              </button>
            </>
          )}
        </div>
      </li>
    )
  }

  return (
    <div className="page r-cls">
      <div className="page-measure">
        <PageTitle>Study Groups</PageTitle>
        {moderationUi}
        {confirmDialog}
        <header className="page-head">
          <div>
            <h1 className="page-title">Study Groups</h1>
            <p className="page-sub">
              Find classmates in your courses and form study groups.
            </p>
          </div>
        </header>

        <div className="space-y-5">
          {/* Opt-in control */}
          <section className="card card-pad flex flex-wrap items-start gap-x-4 gap-y-3">
            <span className="route-badge" aria-hidden="true">
              <Icon name="eye" size={18} />
            </span>
            <div className="flex-1 min-w-[13rem]">
              <div className="card-title">Be discoverable to classmates</div>
              <p className="text-[14px] leading-relaxed text-[var(--color-txt-2)] mt-1.5">
                When on, other opted-in students in your courses can see how many classmates share each course.
                Your name is never shown outside a group you join. Default is off.
              </p>
              {optError && (
                <p role="alert" className="text-[13px] text-[var(--color-error)] mt-2">
                  {optError}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={toggleOptIn}
              disabled={optBusy}
              aria-pressed={optIn}
              className="btn btn-secondary shrink-0 max-sm:ml-12"
            >
              {optIn ? <Icon name="check" size={15} strokeWidth={2.5} /> : null}
              {optIn ? 'Opted in' : 'Opt in'}
            </button>
          </section>

          {/* Your courses */}
          <section className="card card-pad">
            <div className="card-head">
              <span className="route-badge" aria-hidden="true">
                <Icon name="book" size={18} />
              </span>
              <div className="card-title">Your courses</div>
            </div>
            {loadingCourses ? (
              <p className="text-[14px] text-[var(--color-txt-2)]">Loading your courses…</p>
            ) : coursesError ? (
              <p className="text-[14px] text-[var(--color-error)]">{coursesError}</p>
            ) : courses.length === 0 ? (
              <div className="empty row">
                <span className="ico">
                  <Icon name="calendar" size={18} />
                </span>
                <p>
                  No courses detected yet. Connect your class schedule in setup, then come back.
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {courses.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    onClick={() => selectCourse(c.code)}
                    className={`pill tnum ${selectedCourse === c.code ? 'pill-active' : ''}`}
                  >
                    {c.code}
                    {(c.classmateCount ?? 0) > 0 && (
                      <span className="font-semibold opacity-75">· {c.classmateCount} classmate{c.classmateCount === 1 ? '' : 's'}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Groups for the selected course */}
          {selectedCourse && (
            <section className="card card-pad">
              <div className="card-head">
                <span className="route-badge" aria-hidden="true">
                  <Icon name="users" size={18} />
                </span>
                <h2 className="card-title">{selectedCourse} groups</h2>
                <button type="button" onClick={() => setShowCreate((s) => !s)} className={`btn btn-sm ml-auto shrink-0 ${showCreate ? 'btn-secondary' : 'btn-primary'}`}>
                  <Icon name={showCreate ? 'close' : 'plus'} size={14} />
                  {showCreate ? 'Close' : 'New group'}
                </button>
              </div>

              {showCreate && (
                <form onSubmit={createGroup} className="mb-4 pb-5 space-y-3 border-b border-[var(--color-border)]">
                  <input
                    value={form.title}
                    onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                    maxLength={120}
                    placeholder="Group name (e.g. Exam 2 review crew)"
                    className="input"
                  />
                  <input
                    value={form.meetingInfo}
                    onChange={(e) => setForm((f) => ({ ...f, meetingInfo: e.target.value }))}
                    maxLength={200}
                    placeholder="When/where (optional) - e.g. Tue 4pm, Library 2nd floor"
                    className="input"
                  />
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    maxLength={1000}
                    rows={3}
                    placeholder="Details (optional)"
                    className="input resize-y"
                  />
                  <input
                    value={form.capacity}
                    onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                    inputMode="numeric"
                    placeholder="Max size (optional, 2-100)"
                    className="input tnum"
                  />
                  {formError && <p className="text-[13px] text-[var(--color-error)]">{formError}</p>}
                  <button type="submit" disabled={submitting} className="btn btn-primary">
                    {submitting ? 'Creating…' : 'Create group'}
                  </button>
                </form>
              )}

              {loadingGroups ? (
                <p className="text-[14px] text-[var(--color-txt-2)]">Loading groups…</p>
              ) : groups.length === 0 ? (
                <div className="empty row">
                  <span className="ico">
                    <Icon name="users" size={18} />
                  </span>
                  <div>
                    <p className="font-display font-bold text-[15px] text-[var(--color-txt-0)]">No groups yet for {selectedCourse}</p>
                    <p className="mt-0.5">Start one and classmates can join.</p>
                  </div>
                </div>
              ) : (
                <ul ref={rowsRef} className="-mt-2">{groups.map((g) => renderGroupCard(g, 'course'))}</ul>
              )}
            </section>
          )}

          {/* My groups */}
          {myGroups.length > 0 && (
            <section className="card card-pad">
              <div className="card-head">
                <span className="route-badge" aria-hidden="true">
                  <Icon name="users" size={18} />
                </span>
                <div className="card-title">Your groups</div>
              </div>
              <ul className="-mt-2">{myGroups.map((g) => renderGroupCard(g, 'mine'))}</ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
