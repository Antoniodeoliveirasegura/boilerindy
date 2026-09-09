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
    <div className="card p-4 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <div className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
          Degree progress
        </div>
        <MajorPicker value={major} onChange={onChangeMajor} />
      </div>

      {!program ? (
        <p className="text-[13px] text-[var(--color-txt-2)] mt-2">
          Pick your major to see the required courses and check them off automatically as you log
          grades.
        </p>
      ) : !hasPlan ? (
        // A catalogue major we haven't mapped a plan of study for yet.
        <div className="mt-3 rounded-xl border border-dashed border-[var(--color-border-2)] p-4">
          <div className="text-[13px] font-medium text-[var(--color-txt-0)]">
            {program.name} is saved to your profile.
          </div>
          <p className="text-[12px] text-[var(--color-txt-2)] mt-1 leading-relaxed">
            We haven&apos;t mapped this major&apos;s plan of study yet, so there&apos;s no checklist
            to tick off - your GPA, credits and courses below still track normally.{' '}
            <a
              href="https://catalog.purdue.edu/"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] hover:underline"
            >
              Check the Purdue catalog
            </a>{' '}
            for the official requirements.
          </p>
        </div>
      ) : (
        <div className="mt-3">
          {/* Overall progress */}
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <div className="text-[13px] text-[var(--color-txt-1)]">
              <span className="font-semibold text-[var(--color-txt-0)]">
                {progress!.doneCourses}
              </span>{' '}
              of {progress!.listedCourses} listed courses ·{' '}
              <span className="font-semibold text-[var(--color-txt-0)]">
                {progress!.doneCredits}
              </span>{' '}
              cr done
            </div>
            <div className="text-[12px] text-[var(--color-txt-3)]">
              {program.totalCredits} cr to graduate
            </div>
          </div>
          <div className="h-2 rounded-full bg-[var(--color-stat)] overflow-hidden">
            <div
              className="h-full bg-[var(--color-gold)] rounded-full transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>

          <div className="text-[11px] text-[var(--color-txt-3)] mt-2">
            Tap any course to log the grade you earned - it goes straight into your tracker.
          </div>

          {/* Requirement groups */}
          <div ref={listRef} className="mt-3 space-y-4">
            {progress!.groups.map((g) => (
              <div key={g.name}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="text-[13px] font-semibold text-[var(--color-txt-0)]">{g.name}</div>
                  {g.total > 0 && (
                    <div className="text-[11px] text-[var(--color-txt-3)] shrink-0">
                      {g.doneCount}/{g.total}
                    </div>
                  )}
                </div>
                {g.note && (
                  <div className="text-[11px] text-[var(--color-txt-3)] mb-1.5">{g.note}</div>
                )}
                {g.courses.length > 0 ? (
                  <div className="space-y-0.5">
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
                            className={`group w-full flex items-center gap-2.5 text-[13px] text-left rounded-lg px-2 -mx-2 py-1.5 transition-colors outline-none hover:bg-[var(--color-stat)] focus-visible:ring-2 focus-visible:ring-[var(--color-gold)]/40 ${
                              isOpen ? 'bg-[var(--color-stat)]' : ''
                            }`}
                          >
                            <span
                              className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-full shrink-0 text-[10px] font-semibold ${
                                c.done
                                  ? 'bg-[var(--color-success)] text-white'
                                  : logged
                                    ? 'border border-[var(--color-error)] text-[var(--color-error)]'
                                    : 'border border-dashed border-[var(--color-border-2)] text-[var(--color-txt-3)] group-hover:border-[var(--color-gold)] group-hover:text-[var(--color-gold)]'
                              }`}
                            >
                              {c.done ? (
                                <Icon name="check" size={11} />
                              ) : logged ? (
                                logged.letterGrade
                              ) : (
                                <Icon
                                  name="plus"
                                  size={10}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                                />
                              )}
                            </span>
                            <span className="font-mono text-[12px] text-[var(--color-txt-2)] w-[5.5rem] shrink-0">
                              {c.code}
                            </span>
                            <span
                              className={`flex-1 min-w-0 truncate ${
                                c.done ? 'text-[var(--color-txt-2)]' : 'text-[var(--color-txt-1)]'
                              }`}
                            >
                              {c.name}
                            </span>
                            <span className="text-[11px] text-[var(--color-txt-3)] shrink-0">
                              {c.credits} cr
                            </span>
                          </button>

                          {isOpen && (
                            <div className="absolute left-0 right-0 z-40 mt-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-xl)] p-2.5">
                              <div className="text-[11px] text-[var(--color-txt-3)] mb-1.5">
                                {logged ? 'Change your grade for' : 'What did you get in'}{' '}
                                <span className="font-mono text-[var(--color-txt-2)]">{c.code}</span>
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
                                      className={`min-w-[2.1rem] px-1.5 py-1 rounded-lg text-[12px] font-semibold border transition-colors ${
                                        active
                                          ? 'bg-[var(--color-gold)] border-[var(--color-gold)] text-black'
                                          : `border-[var(--color-border)] hover:border-[var(--color-gold)] hover:text-[var(--color-gold)] ${
                                              isGpaLetter(letter)
                                                ? 'text-[var(--color-txt-1)]'
                                                : 'text-[var(--color-txt-3)]'
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
                                  className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-[var(--color-txt-2)] hover:text-[var(--color-error)] transition-colors"
                                >
                                  <Icon name="trash" size={13} />
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
          <div className="mt-4 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-txt-3)] leading-relaxed">
            Planning aid only - selective and general-education credits aren&apos;t auto-tracked.
            Confirm with your advisor / MyPurduePlan.{' '}
            <a
              href={program.sourceUrl ?? 'https://catalog.purdue.edu/'}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-accent)] hover:underline"
            >
              Source
            </a>
            . {program.sourceNote}
          </div>
        </div>
      )}
    </div>
  )
}
