import { useMemo, useState } from 'react'
import Icon from '../components/Icons'
import { useAuth } from '../context/AuthContext'
import { useGradeTracker } from '../hooks/useGradeTracker'
import { useMajor } from '../hooks/useMajor'
import DegreeProgress from '../components/DegreeProgress'
import { LETTER_GRADES, DEFAULT_CREDIT_HOURS, isGpaLetter } from '../lib/gradeTrackerStore'

const EMPTY_FORM = {
  courseName: '',
  term: '',
  creditHours: String(DEFAULT_CREDIT_HOURS),
  letterGrade: 'A',
}

function gpaText(gpa: number | null | undefined) {
  return gpa == null ? '-' : gpa.toFixed(2)
}

// Colour the GPA number by band so it reads at a glance.
function gpaTone(gpa: number | null | undefined) {
  if (gpa == null) return 'text-[var(--color-txt-2)]'
  if (gpa >= 3.5) return 'text-[var(--color-success)]'
  if (gpa >= 2.5) return 'text-[var(--color-gold)]'
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
      className={`inline-flex items-center justify-center min-w-[2.25rem] px-2 py-0.5 rounded-lg text-[12px] font-semibold border ${
        isGpaLetter(letter)
          ? 'bg-[var(--color-stat)] border-[var(--color-border)] text-[var(--color-txt-0)]'
          : 'bg-[var(--color-bg-2)] border-[var(--color-border)] text-[var(--color-txt-2)]'
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
  const { major, setMajor } = useMajor(userId)

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

  const inputBase =
    'w-full py-2 px-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-txt-0)] text-[13px] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20 placeholder:text-[var(--color-txt-3)]'

  return (
    <div className="max-w-[920px] mx-auto px-6 py-8 pb-24">
      <div className="mb-6">
        <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-2">
          Academics
        </div>
        <h1 className="text-2xl font-semibold text-[var(--color-txt-0)] flex items-center gap-2">
          <Icon name="graduation" size={22} className="text-[var(--color-gold)]" />
          Grade Tracker
        </h1>
        <p className="text-[14px] text-[var(--color-txt-2)] mt-1 max-w-[640px]">
          Add your courses with credit hours and letter grades to see your term and cumulative GPA
          on the Purdue 4.0 scale. Stored to your account, available on any device.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-4 col-span-2 sm:col-span-2">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
            Cumulative GPA
          </div>
          <div className={`text-4xl font-semibold mt-1 ${gpaTone(summary.gpa)}`}>
            {gpaText(summary.gpa)}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
            Credits
          </div>
          <div className="text-4xl font-semibold mt-1 text-[var(--color-txt-0)]">
            {summary.credits}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-[11px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
            Courses
          </div>
          <div className="text-4xl font-semibold mt-1 text-[var(--color-txt-0)]">
            {grades.length}
          </div>
        </div>
      </div>

      {/* Degree progress */}
      <DegreeProgress major={major} onChangeMajor={setMajor} grades={grades} />

      {/* Add / edit form */}
      <form onSubmit={submit} className="card p-4 mb-6">
        <div className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider mb-3">
          {editingId ? 'Edit course' : 'Add a course'}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
          <input
            className={`${inputBase} sm:col-span-5`}
            placeholder="Course (e.g. CS 30200)"
            value={form.courseName}
            onChange={setField('courseName')}
            maxLength={120}
            required
          />
          <input
            className={`${inputBase} sm:col-span-3`}
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
            className={`${inputBase} sm:col-span-2`}
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
            className={`${inputBase} sm:col-span-2`}
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
        <div className="flex items-center gap-2 mt-3">
          <button type="submit" className="btn btn-primary text-[13px] px-4 py-2">
            <Icon name={editingId ? 'check' : 'plus'} size={14} />
            {editingId ? 'Save changes' : 'Add course'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="btn btn-secondary text-[13px] px-4 py-2"
            >
              Cancel
            </button>
          )}
        </div>
        {error && <div className="text-[12px] text-[var(--color-error)] mt-2">{error}</div>}
      </form>

      {/* Course list, grouped by term */}
      {loading && grades.length === 0 ? (
        <div className="card p-6 text-[13px] text-[var(--color-txt-2)]">Loading your courses…</div>
      ) : grades.length === 0 ? (
        <div className="card p-8 text-center">
          <Icon name="graduation" size={28} className="text-[var(--color-txt-3)] mx-auto mb-2" />
          <div className="text-[14px] font-medium text-[var(--color-txt-1)]">No courses yet</div>
          <div className="text-[13px] text-[var(--color-txt-2)] mt-1">
            Add your first course above to start tracking your GPA.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {summary.terms.map((term) => (
            <div key={term.term} className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[13px] font-semibold text-[var(--color-txt-0)]">{term.term}</div>
                <div className="text-[12px] text-[var(--color-txt-2)]">
                  Term GPA{' '}
                  <span className={`font-semibold ${gpaTone(term.gpa)}`}>{gpaText(term.gpa)}</span>
                  <span className="text-[var(--color-txt-3)]"> · {term.credits} cr</span>
                </div>
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {term.courses.map((course: Course) => (
                  <div key={course.id} className="flex items-center gap-3 py-2.5">
                    <GradeBadge letter={course.letterGrade} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[var(--color-txt-0)] truncate">
                        {course.courseName}
                      </div>
                      <div className="text-[11px] text-[var(--color-txt-2)]">
                        {course.creditHours} credit{course.creditHours === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEdit(course)}
                      aria-label={`Edit ${course.courseName}`}
                      className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--color-txt-2)] hover:text-[var(--color-accent)] hover:bg-[var(--color-stat)] transition-colors"
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteGrade(course.id)}
                      aria-label={`Delete ${course.courseName}`}
                      className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-[var(--color-txt-2)] hover:text-[var(--color-error)] hover:bg-[var(--color-stat)] transition-colors"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
