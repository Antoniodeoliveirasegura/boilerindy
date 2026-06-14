import { useMemo } from 'react'
import Icon from './Icons'
import { listPrograms, getProgram, matchProgress } from '../../../degreePrograms.mjs'

/**
 * Degree planner view (issue #18): a major selector + the program's required
 * courses, auto-checked against the student's tracked grades. Curated, sourced
 * data — shown as a planning aid (selectives/gen-ed are ranges, not auto-tracked).
 *
 * @param {{ major: string|null, onChangeMajor: (id: string|null) => void,
 *   grades: {courseName: string, letterGrade: string, creditHours: number}[] }} props
 */
export default function DegreeProgress({ major, onChangeMajor, grades }) {
  const programs = useMemo(() => listPrograms(), [])
  const program = getProgram(major)
  const progress = useMemo(
    () => (program ? matchProgress(program, grades) : null),
    [program, grades],
  )

  const pct =
    progress && progress.listedCredits > 0
      ? Math.round((progress.doneCredits / progress.listedCredits) * 100)
      : 0

  return (
    <div className="card p-4 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-1">
        <div className="text-[12px] font-semibold text-[var(--color-txt-3)] uppercase tracking-wider">
          Degree progress
        </div>
        <select
          value={major || ''}
          onChange={(e) => onChangeMajor(e.target.value || null)}
          className="py-2 px-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-txt-0)] text-[13px] outline-none focus:border-[var(--color-gold)] focus:ring-2 focus:ring-[var(--color-gold)]/20"
          aria-label="Select your major"
        >
          <option value="">Select your major…</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.degree})
            </option>
          ))}
        </select>
      </div>

      {!program ? (
        <p className="text-[13px] text-[var(--color-txt-2)] mt-2">
          Pick your major to see the required courses and check them off automatically as you log
          grades.
        </p>
      ) : (
        <div className="mt-3">
          {/* Overall progress */}
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <div className="text-[13px] text-[var(--color-txt-1)]">
              <span className="font-semibold text-[var(--color-txt-0)]">
                {progress.doneCourses}
              </span>{' '}
              of {progress.listedCourses} listed courses ·{' '}
              <span className="font-semibold text-[var(--color-txt-0)]">
                {progress.doneCredits}
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

          {/* Requirement groups */}
          <div className="mt-4 space-y-4">
            {progress.groups.map((g) => (
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
                  <div className="space-y-1">
                    {g.courses.map((c) => (
                      <div key={c.code} className="flex items-center gap-2.5 text-[13px]">
                        <span
                          className={`inline-flex items-center justify-center w-4 h-4 rounded-full shrink-0 ${
                            c.done
                              ? 'bg-[var(--color-success)] text-white'
                              : 'border border-[var(--color-border-2)]'
                          }`}
                        >
                          {c.done && <Icon name="check" size={11} />}
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
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {/* Source + disclaimer */}
          <div className="mt-4 pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-txt-3)] leading-relaxed">
            Planning aid only — selective and general-education credits aren&apos;t auto-tracked.
            Confirm with your advisor / MyPurduePlan.{' '}
            <a
              href={program.sourceUrl}
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
