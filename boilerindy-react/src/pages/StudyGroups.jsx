import { useCallback, useEffect, useState } from 'react'
import Icon from '../components/Icons'
import { authRequest } from '../lib/authApi'
import { track } from '../lib/usageStats'

// Study Group Finder (issue #33). Privacy is opt-in (default off): a student only
// appears in classmate counts after turning the toggle on, and membership is
// visible only within a group.
const EMPTY_FORM = { title: '', description: '', meetingInfo: '', capacity: '' }

export default function StudyGroups() {
  const [optIn, setOptIn] = useState(false)
  const [courses, setCourses] = useState([])
  const [loadingCourses, setLoadingCourses] = useState(true)
  const [coursesError, setCoursesError] = useState('')
  const [optBusy, setOptBusy] = useState(false)

  const [selectedCourse, setSelectedCourse] = useState('')
  const [groups, setGroups] = useState([])
  const [loadingGroups, setLoadingGroups] = useState(false)

  const [myGroups, setMyGroups] = useState([])

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    track('study_groups_viewed')
  }, [])

  const loadMyGroups = useCallback(() => {
    authRequest('/api/me/study-groups')
      .then((data) => setMyGroups(Array.isArray(data?.groups) ? data.groups : []))
      .catch(() => setMyGroups([]))
  }, [])

  useEffect(() => {
    let active = true
    authRequest('/api/me/study-groups/courses')
      .then((data) => {
        if (!active) return
        setOptIn(Boolean(data?.optIn))
        setCourses(Array.isArray(data?.courses) ? data.courses : [])
      })
      .catch((e) => {
        if (active) setCoursesError(e?.message || 'Could not load your courses.')
      })
      .finally(() => {
        if (active) setLoadingCourses(false)
      })
    loadMyGroups()
    return () => {
      active = false
    }
  }, [loadMyGroups])

  function selectCourse(code) {
    setSelectedCourse(code)
    setShowCreate(false)
    setForm(EMPTY_FORM)
    setLoadingGroups(true)
    authRequest(`/api/study-groups?course=${encodeURIComponent(code)}`)
      .then((data) => setGroups(Array.isArray(data?.groups) ? data.groups : []))
      .catch(() => setGroups([]))
      .finally(() => setLoadingGroups(false))
  }

  async function toggleOptIn() {
    setOptBusy(true)
    try {
      const next = !optIn
      const data = await authRequest('/api/me/study-groups/opt-in', {
        method: 'PATCH',
        body: JSON.stringify({ optIn: next }),
      })
      setOptIn(Boolean(data?.optIn))
    } catch {
      /* keep previous state on failure */
    } finally {
      setOptBusy(false)
    }
  }

  async function createGroup(e) {
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
          capacity: form.capacity === '' ? undefined : Number(form.capacity),
        }),
      })
      setForm(EMPTY_FORM)
      setShowCreate(false)
      selectCourse(selectedCourse)
      loadMyGroups()
    } catch (err) {
      setFormError(err?.message || 'Could not create the group.')
    } finally {
      setSubmitting(false)
    }
  }

  function joinGroup(group) {
    authRequest(`/api/study-groups/${group.id}/join`, { method: 'POST' })
      .then(() => {
        if (selectedCourse) selectCourse(selectedCourse)
        loadMyGroups()
      })
      .catch(() => {})
  }

  function leaveGroup(group) {
    authRequest(`/api/study-groups/${group.id}/leave`, { method: 'POST' })
      .then(() => {
        if (selectedCourse) selectCourse(selectedCourse)
        loadMyGroups()
      })
      .catch(() => {})
  }

  function renderGroupCard(group, context) {
    return (
      <div key={group.id} className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-stat)] text-[var(--color-txt-2)] font-medium">
                {group.courseCode}
              </span>
              <span className="text-[11px] text-[var(--color-txt-3)]">
                {group.memberCount}
                {group.capacity ? `/${group.capacity}` : ''} member{group.memberCount === 1 ? '' : 's'}
              </span>
            </div>
            <h3 className="text-[15px] font-semibold text-[var(--color-txt-0)] mt-1.5 break-words">{group.title}</h3>
            {group.meetingInfo && (
              <div className="text-[12px] text-[var(--color-txt-2)] flex items-center gap-1 mt-0.5">
                <Icon name="clock" size={12} />
                {group.meetingInfo}
              </div>
            )}
            {group.description && (
              <p className="text-[13px] text-[var(--color-txt-1)] mt-1.5 whitespace-pre-wrap break-words">{group.description}</p>
            )}
          </div>
          {group.joinedByMe ? (
            <button
              type="button"
              onClick={() => leaveGroup(group)}
              className="text-[12px] px-3 py-2 rounded-xl border border-[var(--color-border-2)] text-[var(--color-txt-2)] hover:bg-[var(--color-stat)] shrink-0"
            >
              Leave
            </button>
          ) : (
            <button
              type="button"
              onClick={() => joinGroup(group)}
              className="btn btn-primary text-[12px] px-3 py-2 shrink-0"
            >
              Join
            </button>
          )}
        </div>
        {context === 'mine' && group.courseCode && (
          <button
            type="button"
            onClick={() => selectCourse(group.courseCode)}
            className="text-[11px] text-[var(--color-accent)] hover:underline mt-2"
          >
            See all {group.courseCode} groups
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-[900px] mx-auto px-6 py-8 pb-24">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--color-txt-0)]">Study Groups</h1>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1">
          Find classmates in your courses and form study groups.
        </p>
      </div>

      {/* Opt-in control */}
      <div className="card p-4 mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-[var(--color-txt-0)]">Be discoverable to classmates</div>
          <p className="text-[12px] text-[var(--color-txt-2)] mt-1 max-w-[560px]">
            When on, other opted-in students in your courses can see how many classmates share each course.
            Your name is never shown outside a group you join. Default is off.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleOptIn}
          disabled={optBusy}
          aria-pressed={optIn}
          className={`shrink-0 px-4 py-2 rounded-xl text-[13px] font-medium border transition-colors disabled:opacity-60 ${
            optIn
              ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
              : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'
          }`}
        >
          {optIn ? 'Opted in' : 'Opt in'}
        </button>
      </div>

      {/* Your courses */}
      <div className="mb-6">
        <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-2">Your courses</div>
        {loadingCourses ? (
          <p className="text-[13px] text-[var(--color-txt-3)]">Loading your courses…</p>
        ) : coursesError ? (
          <p className="text-[13px] text-[var(--color-error)]">{coursesError}</p>
        ) : courses.length === 0 ? (
          <p className="text-[13px] text-[var(--color-txt-2)]">
            No courses detected yet. Connect your class schedule in setup, then come back.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {courses.map((c) => (
              <button
                key={c.code}
                type="button"
                onClick={() => selectCourse(c.code)}
                className={`text-[12px] px-3 py-1.5 rounded-full border transition-colors ${
                  selectedCourse === c.code
                    ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                    : 'border-[var(--color-border-2)] text-[var(--color-txt-1)] hover:bg-[var(--color-stat)]'
                }`}
              >
                {c.code}
                {c.classmateCount > 0 && (
                  <span className="ml-1.5 opacity-80">· {c.classmateCount} classmate{c.classmateCount === 1 ? '' : 's'}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Groups for the selected course */}
      {selectedCourse && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[16px] font-semibold text-[var(--color-txt-0)]">{selectedCourse} groups</h2>
            <button type="button" onClick={() => setShowCreate((s) => !s)} className="btn btn-primary text-[12px] px-3 py-2">
              <Icon name="plus" size={14} />
              {showCreate ? 'Close' : 'New group'}
            </button>
          </div>

          {showCreate && (
            <form onSubmit={createGroup} className="card p-5 mb-4 space-y-3">
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                maxLength={120}
                placeholder="Group name (e.g. Exam 2 review crew)"
                className="input w-full text-[13px] px-3 py-2"
              />
              <input
                value={form.meetingInfo}
                onChange={(e) => setForm((f) => ({ ...f, meetingInfo: e.target.value }))}
                maxLength={200}
                placeholder="When/where (optional) — e.g. Tue 4pm, Library 2nd floor"
                className="input w-full text-[13px] px-3 py-2"
              />
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                maxLength={1000}
                rows={3}
                placeholder="Details (optional)"
                className="input w-full text-[13px] px-3 py-2 resize-y"
              />
              <input
                value={form.capacity}
                onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))}
                inputMode="numeric"
                placeholder="Max size (optional, 2–100)"
                className="input w-full text-[13px] px-3 py-2"
              />
              {formError && <p className="text-[12px] text-[var(--color-error)]">{formError}</p>}
              <button type="submit" disabled={submitting} className="btn btn-primary px-4 py-2.5 text-[13px] disabled:opacity-60">
                {submitting ? 'Creating…' : 'Create group'}
              </button>
            </form>
          )}

          {loadingGroups ? (
            <p className="text-[13px] text-[var(--color-txt-3)]">Loading groups…</p>
          ) : groups.length === 0 ? (
            <div className="card p-8 text-center">
              <p className="text-[14px] font-medium text-[var(--color-txt-0)]">No groups yet for {selectedCourse}</p>
              <p className="text-[13px] text-[var(--color-txt-2)] mt-1">Start one and classmates can join.</p>
            </div>
          ) : (
            <div className="space-y-3">{groups.map((g) => renderGroupCard(g, 'course'))}</div>
          )}
        </div>
      )}

      {/* My groups */}
      {myGroups.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">Your groups</div>
          <div className="space-y-3">{myGroups.map((g) => renderGroupCard(g, 'mine'))}</div>
        </div>
      )}
    </div>
  )
}
