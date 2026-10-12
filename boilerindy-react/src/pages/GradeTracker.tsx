import { useMemo, useState } from 'react'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { useGradeTracker } from '../hooks/useGradeTracker'
import { useMajor } from '../hooks/useMajor'
import DegreeProgress, { type ReqCourse } from '../components/DegreeProgress'
import { LETTER_GRADES, DEFAULT_CREDIT_HOURS, isGpaLetter } from '../lib/gradeTrackerStore'
import PageTitle from '../components/PageTitle'

const EMPTY_FORM = {
  courseName: '',
  term: '',
  creditHours: String(DEFAULT_CREDIT_HOURS),
  letterGrade: 'A',
}

function gpaText(gpa: number | null | undefined) {
  return gpa == null ? '-' : gpa.toFixed(2)
}

// Colour the GPA number by band so it reads at a glance. The middle band stays
// ink: --color-warning is the signal amber in dark, and amber is kept for now,
// the primary action and urgency.
function gpaTone(gpa: number | null | undefined) {
  if (gpa == null) return 'text-[var(--color-txt-2)]'
  if (gpa >= 3.5) return 'text-[var(--color-success)]'
  if (gpa >= 2.5) return 'text-[var(--color-txt-0)]'
  return 'text-[var(--color-error)]'
}

type Course = {
  id: string
  courseName: string
  term: string
  creditHours: number
  letterGrade: string
}

function GradeBadge({ letter }: { letter: string }) {
  return (
    <span
      className={`inline-grid h-9 min-w-[2.5rem] shrink-0 place-items-center rounded-[var(--radius-md)] px-1.5 font-display text-[14px] font-extrabold tnum ${
        isGpaLetter(letter)
          ? 'bg-[var(--color-stat)] text-[var(--color-txt-0)] shadow-[inset_0_0_0_1.5px_var(--color-border-2)]'
          : 'text-[var(--color-txt-2)] shadow-[inset_0_0_0_1.5px_var(--color-border-3)]'
      }`}
      title={isGpaLetter(letter) ? undefined : 'Not counted in GPA'}
    >
      {letter}
    </span>
  )
}

export default function GradeTracker() {
  const { user } = useAuth()
  const userId = user?.id as string | undefined
  const { grades, summary, loading, error, addGrade, updateGrade, deleteGrade } = useGradeTracker(
    userId,
  )
  const { major, setMajor, error: majorError } = useMajor(userId)

  const [form, setForm] = useState(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Suggest terms the user has already used (for the datalist).
  const termOptions = useMemo(
    () => [...new Set(grades.map((g) => g.term as string).filter(Boolean))],
    [grades],
  )

  const setField =
    (key: keyof typeof EMPTY_FORM) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))

  const resetForm = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
  }

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const payload = {
      courseName: form.courseName,
      term: form.term,
      creditHours: Number(form.creditHours),
      letterGrade: form.letterGrade,
    }
    const ok = editingId ? await updateGrade(editingId, payload) : await addGrade(payload)
    if (ok) resetForm()
  }

  // Log a course straight from the degree checklist. Re-grading an already
  // tracked course only patches the letter; a new one is filed under the term
  // the student last used (normalizeGrade falls back to "Other").
  const logRequirement = (course: ReqCourse, letterGrade: string, existingId: string | null) => {
    if (existingId) {
      void updateGrade(existingId, { letterGrade })
      return
    }
    void addGrade({
      courseName: `${course.code} ${course.name}`,
      letterGrade,
      creditHours: course.credits,
      term: grades.length ? grades[grades.length - 1].term : '',
    })
  }

  const startEdit = (course: Course) => {
    setEditingId(course.id)
    setForm({
      courseName: course.courseName,
      term: course.term,
      creditHours: String(course.creditHours),
      letterGrade: course.letterGrade,
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="page">
      <PageTitle>Grade Tracker</PageTitle>
      <header className="page-head">
        <div>
          <div className="eyebrow">
            Academics
          </div>
          <h1 className="page-title">
            Grade Tracker
          </h1>
          <p className="page-sub max-w-[680px]">
            Add your courses with credit hours and letter grades to see your term and cumulative GPA
            on the Purdue 4.0 scale. Stored to your account, available on any device.
          </p>
        </div>
      </header>

      {/* Summary: one stat strip. The GPA cell keeps its own .card (the e2e
          suite reads the number from the card that says Cumulative GPA). */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="card card-pad r-cls col-span-2 flex flex-col justify-between gap-3 md:col-span-1">
          <div className="eyebrow bare">
            Cumulative GPA
          </div>
          {summary.gpa == null && grades.length === 0 ? (
            <div className="flaps blank" role="img" aria-label="No courses yet">
              <span className="flap" aria-hidden="true" />
              <span className="flap-sep" aria-hidden="true">.</span>
              <span className="flap" aria-hidden="true" />
              <span className="flap" aria-hidden="true" />
            </div>
          ) : (
            <div className={`big-stat ${gpaTone(summary.gpa)}`}>
              {gpaText(summary.gpa)}
            </div>
          )}
        </div>
        <div className="card card-pad flex flex-col justify-between gap-3">
          <div className="eyebrow bare">
            Credits
          </div>
          <div className="big-stat">
            {summary.credits}
          </div>
        </div>
        <div className="card card-pad flex flex-col justify-between gap-3">
          <div className="eyebrow bare">
            Courses
          </div>
          <div className="big-stat">
            {grades.length}
          </div>
        </div>
      </div>

      {/* Degree progress */}
      <DegreeProgress
        major={major}
        onChangeMajor={setMajor}
        grades={grades}
        onLogCourse={logRequirement}
        onRemoveCourse={deleteGrade}
        majorError={majorError}
      />

      {/* Add / edit form */}
      <form onSubmit={submit} className="card card-pad r-cls mb-5">
        <div className="eyebrow mb-4">
          {editingId ? 'Edit course' : 'Add a course'}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-12">
          <input
            className="input col-span-2 sm:col-span-5"
            placeholder="Course (e.g. CS 30200)"
            value={form.courseName}
            onChange={setField('courseName')}
            maxLength={120}
            required
          />
          <input
            className="input col-span-2 sm:col-span-3"
            placeholder="Term (e.g. Fall 2025)"
            value={form.term}
            onChange={setField('term')}
            list="grade-term-options"
            maxLength={60}
          />
          <datalist id="grade-term-options">
            {termOptions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <input
            className="input tnum sm:col-span-2"
            type="number"
            inputMode="decimal"
            min="0"
            max="30"
            step="0.5"
            placeholder="Credits"
            value={form.creditHours}
            onChange={setField('creditHours')}
            required
          />
          <select
            className="input sm:col-span-2"
            value={form.letterGrade}
            onChange={setField('letterGrade')}
            aria-label="Letter grade"
          >
            {LETTER_GRADES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary">
            <Icon name={editingId ? 'check' : 'plus'} size={16} />
            {editingId ? 'Save changes' : 'Add course'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          )}
        </div>
        {error && <div className="mt-2.5 text-[13px] font-medium text-[var(--color-error)]">{error}</div>}
      </form>

      {/* Course list, grouped by term */}
      {loading && grades.length === 0 ? (
        <div className="card card-pad text-[14px] text-[var(--color-txt-2)]">Loading your courses…</div>
      ) : grades.length === 0 ? (
        <div className="card card-pad">
          <div className="empty">
            <span className="ico">
              <Icon name="graduation" size={18} />
            </span>
            <div>
              <div className="font-display text-[15px] font-bold text-[var(--color-txt-0)]">No courses yet</div>
              <p className="mt-1">
                Add your first course above to start tracking your GPA.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2">
          {summary.terms.map((term) => (
            <section key={term.term} className="card card-pad r-cls">
              <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h2 className="card-title">{term.term}</h2>
                <div className="tnum text-[13px] text-[var(--color-txt-2)]">
                  Term GPA{' '}
                  <span className={`font-display font-extrabold ${gpaTone(term.gpa)}`}>{gpaText(term.gpa)}</span>
                  <span className="text-[var(--color-txt-3)]"> · {term.credits} cr</span>
                </div>
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {term.courses.map((course: Course) => (
                  <div key={course.id} className="flex items-center gap-3 py-2.5">
                    <GradeBadge letter={course.letterGrade} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-display text-[14.5px] font-bold text-[var(--color-txt-0)]">
                        {course.courseName}
                      </div>
                      <div className="tnum mt-0.5 text-[12.5px] text-[var(--color-txt-2)]">
                        {course.creditHours} credit{course.creditHours === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(course)}
                      aria-label={`Edit ${course.courseName}`}
                      className="icon-btn"
                    >
                      <Icon name="edit" size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGrade(course.id)}
                      aria-label={`Delete ${course.courseName}`}
                      className="icon-btn -mr-2 hover:text-[var(--color-error)]"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
