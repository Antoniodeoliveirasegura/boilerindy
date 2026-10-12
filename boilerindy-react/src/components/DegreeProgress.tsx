import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'
import MajorPicker from './MajorPicker'
import { getProgram, matchProgress, extractCourseCodes } from '../../../src/degreePrograms.mjs'
import { LETTER_GRADES, isGpaLetter, gradePoints } from '../lib/gradeTrackerStore'

type DegreeGrade = {
  id: string | null
  courseName: string
  letterGrade: string
  creditHours: number
}

export type ReqCourse = { code: string; name: string; credits: number; done: boolean }

type DegreeProgressProps = {
  major: string | null
  onChangeMajor: (id: string | null) => void
  grades: DegreeGrade[]
  /** Log (or re-grade) a requirement course straight from the checklist. */
  onLogCourse: (course: ReqCourse, letterGrade: string, existingId: string | null) => void
  onRemoveCourse: (id: string) => void
  /** Why the last major change did not save, if it did not (issue #202). */
  majorError?: string
}

type ReqGroup = {
  name: string
  total: number
  doneCount: number
  note?: string
  courses: ReqCourse[]
}
type ProgressData = {
  doneCourses: number
  listedCourses: number
  doneCredits: number
  listedCredits: number
  groups: ReqGroup[]
}

/** Matches degreePrograms.isPassing: GPA letter above F, or Pass. */
function isPassingGrade(letterGrade: string): boolean {
  if (letterGrade === 'P') return true
  const gp = gradePoints(letterGrade)
  return gp !== null && gp > 0
}

/** Prefer a passing / higher grade when multiple tracker rows share a course code. */
function preferTrackedGrade(current: DegreeGrade, candidate: DegreeGrade): DegreeGrade {
  const currentPass = isPassingGrade(current.letterGrade)
  const candidatePass = isPassingGrade(candidate.letterGrade)
  if (currentPass !== candidatePass) return candidatePass ? candidate : current
  const currentPts = gradePoints(current.letterGrade)
  const candidatePts = gradePoints(candidate.letterGrade)
  const a = currentPts == null ? -1 : currentPts
  const b = candidatePts == null ? -1 : candidatePts
  return b > a ? candidate : current
}

/** Every course code a requirement accepts, e.g. "MA 16100 (or MA 16500)". */
function acceptedCodes(course: ReqCourse): string[] {
  return extractCourseCodes(`${course.code} ${course.name}`) as string[]
}

/**
 * Degree planner view (issue #18): a major selector + the program's required
 * courses, auto-checked against the student's tracked grades. Curated, sourced
 * data - shown as a planning aid (selectives/gen-ed are ranges, not auto-tracked).
 *
 * The checklist is interactive: tapping a requirement logs that course into the
 * grade tracker with the grade you pick, so the plan can be filled in without
 * retyping course codes into the form below.
 */
export default function DegreeProgress({
  major,
  onChangeMajor,
  grades,
  onLogCourse,
  onRemoveCourse,
  majorError,
}: DegreeProgressProps) {
  const program = getProgram(major)
  const progress = useMemo<ProgressData | null>(
    () => (program ? (matchProgress(program, grades) as ProgressData) : null),
    [program, grades],
  )

  // Which requirement row has its grade menu open, keyed by course code.
  const [openCode, setOpenCode] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => setOpenCode(null), [major])

  useEffect(() => {
    if (!openCode) return undefined
    const onPointerDown = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setOpenCode(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenCode(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openCode])

  // Course code -> the tracked grade that satisfies it, so a row can show the
  // logged letter and offer to change or remove it. Prefer a passing / higher
  // grade when the student has multiple rows for the same code (retakes).
  const loggedByCode = useMemo(() => {
    const map = new Map<string, DegreeGrade>()
    for (const grade of grades) {
      for (const code of extractCourseCodes(grade.courseName) as string[]) {
        const existing = map.get(code)
        map.set(code, existing ? preferTrackedGrade(existing, grade) : grade)
      }
    }
    return map
  }, [grades])

  const pct =
    progress && progress.listedCredits > 0
      ? Math.round((progress.doneCredits / progress.listedCredits) * 100)
      : 0

  const hasPlan = Boolean(program && progress && progress.groups.length > 0)

  return (
    <section className="card card-pad r-cls mb-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="route-badge">
            <Icon name="graduation" size={18} />
          </span>
          <div className="card-title">
            Degree progress
          </div>
        </div>
        <MajorPicker value={major} onChange={onChangeMajor} />
      </div>
      {majorError && (
        <p role="alert" className="mt-2.5 text-[13px] font-medium text-[var(--color-error)]">
          {majorError}
        </p>
      )}

      {!program ? (
        <p className="mt-3 text-[14px] text-[var(--color-txt-2)]">
          Pick your major to see the required courses and check them off automatically as you log
          grades.
        </p>
      ) : !hasPlan ? (
        // A catalogue major we haven't mapped a plan of study for yet.
        <div className="empty mt-4">
          <div>
            <div className="font-display text-[14.5px] font-bold text-[var(--color-txt-0)]">
              {program.name} is saved to your profile.
            </div>
            <p className="mt-1 text-[13px] leading-relaxed">
              We haven&apos;t mapped this major&apos;s plan of study yet, so there&apos;s no checklist
              to tick off - your GPA, credits and courses below still track normally.{' '}
              <a
                href="https://catalog.purdue.edu/"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[var(--color-accent)] hover:underline"
              >
                Check the Purdue catalog
              </a>{' '}
              for the official requirements.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          {/* Overall progress: the plan as a route line, filled as far as you
              have come. */}
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <div className="tnum text-[14px] text-[var(--color-txt-1)]">
              <span className="font-display font-extrabold text-[var(--color-txt-0)]">
                {progress!.doneCourses}
              </span>{' '}
              of {progress!.listedCourses} listed courses ·{' '}
              <span className="font-display font-extrabold text-[var(--color-txt-0)]">
                {progress!.doneCredits}
              </span>{' '}
              cr done
            </div>
            <div className="tnum text-[12.5px] text-[var(--color-txt-2)]">
              {program.totalCredits} cr to graduate
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-[var(--radius-xs)] bg-[var(--color-bg-3)]">
            <div
              className="h-full bg-[var(--route)] transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="mt-2.5 text-[12.5px] text-[var(--color-txt-2)]">
            Tap any course to log the grade you earned - it goes straight into your tracker.
          </div>

          {/* Requirement groups */}
          <div ref={listRef} className="mt-4 grid items-start gap-x-8 gap-y-5 lg:grid-cols-2">
            {progress!.groups.map((g) => (
              <div key={g.name} className="min-w-0">
                <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-2)] pb-1.5">
                  <div className="font-display text-[13.5px] font-extrabold text-[var(--color-txt-0)]">{g.name}</div>
                  {g.total > 0 && (
                    <div className="tnum shrink-0 font-display text-[12px] font-bold text-[var(--color-txt-2)]">
                      {g.doneCount}/{g.total}
                    </div>
                  )}
                </div>
                {g.note && (
                  <div className="mt-1.5 text-[12px] text-[var(--color-txt-2)]">{g.note}</div>
                )}
                {g.courses.length > 0 ? (
                  <div className="mt-1">
                    {g.courses.map((c) => {
                      const logged = acceptedCodes(c)
                        .map((code) => loggedByCode.get(code))
                        .filter((g): g is DegreeGrade => Boolean(g))
                        .reduce<DegreeGrade | undefined>(
                          (best, grade) => (best ? preferTrackedGrade(best, grade) : grade),
                          undefined,
                        )
                      const isOpen = openCode === c.code
                      return (
                        <div key={c.code} className="relative">
                          <button
                            type="button"
                            data-req-code={c.code}
                            data-done={c.done}
                            aria-expanded={isOpen}
                            aria-label={`${c.code} ${c.name}${
                              logged ? ` - logged ${logged.letterGrade}` : ' - not logged'
                            }`}
                            onClick={() => setOpenCode(isOpen ? null : c.code)}
                            className={`group -mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13.5px] transition-colors hover:bg-[var(--color-surface-hover)] md:min-h-[40px] ${
                              isOpen ? 'bg-[var(--color-surface-hover)]' : ''
                            }`}
                          >
                            <span
                              className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] font-display text-[10px] font-extrabold ${
                                c.done
                                  ? 'bg-[var(--route)] text-[var(--route-on)]'
                                  : logged
                                    ? 'text-[var(--color-error)] shadow-[inset_0_0_0_1.5px_var(--color-error)]'
                                    : 'border-[1.5px] border-dashed border-[var(--color-border-3)] text-[var(--color-txt-2)] group-hover:border-solid group-hover:border-[var(--color-txt-2)]'
                              }`}
                            >
                              {c.done ? (
                                <Icon name="check" size={12} strokeWidth={3} />
                              ) : logged ? (
                                logged.letterGrade
                              ) : (
                                <Icon
                                  name="plus"
                                  size={11}
                                  strokeWidth={2.5}
                                  className="opacity-0 transition-opacity group-hover:opacity-100"
                                />
                              )}
                            </span>
                            <span className="tnum w-[5.75rem] shrink-0 font-display text-[12.5px] font-bold text-[var(--color-txt-1)]">
                              {c.code}
                            </span>
                            <span
                              className={`min-w-0 flex-1 truncate ${
                                c.done ? 'text-[var(--color-txt-2)]' : 'text-[var(--color-txt-1)]'
                              }`}
                            >
                              {c.name}
                            </span>
                            <span className="tnum shrink-0 text-[12px] text-[var(--color-txt-2)]">
                              {c.credits} cr
                            </span>
                          </button>

                          {isOpen && (
                            <div className="menu-panel absolute left-0 right-0 z-40 mt-1 p-3">
                              <div className="mb-2 text-[12.5px] text-[var(--color-txt-2)]">
                                {logged ? 'Change your grade for' : 'What did you get in'}{' '}
                                <span className="font-display font-bold text-[var(--color-txt-0)]">{c.code}</span>
                                ?
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {LETTER_GRADES.map((letter: string) => {
                                  const active = logged?.letterGrade === letter
                                  return (
                                    <button
                                      key={letter}
                                      type="button"
                                      onClick={() => {
                                        onLogCourse(c, letter, logged?.id ?? null)
                                        setOpenCode(null)
                                      }}
                                      className={`h-11 min-w-[2.75rem] rounded-[var(--radius-md)] border-[1.5px] px-1.5 font-display text-[13px] font-extrabold transition-colors md:h-9 md:min-w-[2.5rem] ${
                                        active
                                          ? 'border-[var(--color-txt-0)] bg-[var(--color-txt-0)] text-[var(--color-surface)]'
                                          : `border-[var(--color-border-2)] bg-[var(--color-surface)] hover:border-[var(--color-txt-0)] ${
                                              isGpaLetter(letter)
                                                ? 'text-[var(--color-txt-0)]'
                                                : 'text-[var(--color-txt-2)]'
                                            }`
                                      }`}
                                    >
                                      {letter}
                                    </button>
                                  )
                                })}
                              </div>
                              {logged?.id && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    onRemoveCourse(logged.id as string)
                                    setOpenCode(null)
                                  }}
                                  className="btn btn-ghost btn-sm -ml-2 mt-2 text-[var(--color-txt-2)] hover:text-[var(--color-error)]"
                                >
                                  <Icon name="trash" size={14} />
                                  Remove from tracker
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* Source + disclaimer */}
          <div className="mt-5 border-t border-[var(--color-border)] pt-3 text-[12px] leading-relaxed text-[var(--color-txt-2)]">
            Planning aid only - selective and general-education credits aren&apos;t auto-tracked.
            Confirm with your advisor / MyPurduePlan.{' '}
            <a
              href={program.sourceUrl ?? 'https://catalog.purdue.edu/'}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--color-accent)] hover:underline"
            >
              Source
            </a>
            . {program.sourceNote}
          </div>
        </div>
      )}
    </section>
  )
}
