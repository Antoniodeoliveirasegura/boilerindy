// degreePrograms.mjs
//
// Curated, sourced degree requirements for a few Purdue majors (issue #18), plus
// pure helpers to match a student's tracked courses against a program. I/O-free
// so it is unit-testable and shared verbatim by the server and the frontend.
//
// IMPORTANT: this is a planning aid, not an official audit. Selective ("choose
// N"), lab-science, and general-education buckets are credit ranges in the
// catalog, so those groups carry a `note` and an empty (or representative)
// course list rather than fabricated course numbers. Each program cites the
// official source it was built from; students should confirm with their advisor
// / MyPurduePlan.

import { gradePoints } from './gradeTracker.mjs'

export const DEGREE_PROGRAMS = [
  {
    id: 'computer-science',
    name: 'Computer Science',
    degree: 'BS',
    totalCredits: 120,
    sourceUrl: 'https://www.cs.purdue.edu/undergraduate/curriculum/bachelor.html',
    sourceNote:
      'Purdue Computer Science (College of Science) requirements. Offered at Purdue in Indianapolis with a shared curriculum. CS requires the core plus one track (6 advanced courses); the Machine Intelligence track is shown as a representative example.',
    requirementGroups: [
      {
        name: 'Computer Science Core',
        note: 'All required; a grade of C or better is expected in each.',
        courses: [
          { code: 'CS 18000', name: 'Problem Solving and Object-Oriented Programming', credits: 4 },
          { code: 'CS 18200', name: 'Foundations of Computer Science', credits: 3 },
          { code: 'CS 24000', name: 'Programming in C', credits: 3 },
          { code: 'CS 25000', name: 'Computer Architecture', credits: 4 },
          { code: 'CS 25100', name: 'Data Structures and Algorithms', credits: 3 },
          { code: 'CS 25200', name: 'Systems Programming', credits: 4 },
        ],
      },
      {
        name: 'First-Semester Tools',
        courses: [{ code: 'CS 19300', name: 'Tools', credits: 1 }],
      },
      {
        name: 'Mathematics',
        note: 'Each line has equivalent honors/accelerated alternatives (e.g. MA 16500/16600).',
        courses: [
          { code: 'MA 16100', name: 'Calculus I (or MA 16500)', credits: 5 },
          { code: 'MA 16200', name: 'Calculus II (or MA 16600)', credits: 5 },
          { code: 'MA 26100', name: 'Multivariate Calculus (or MA 27101)', credits: 4 },
          { code: 'MA 26500', name: 'Linear Algebra (or MA 35100)', credits: 3 },
        ],
      },
      {
        name: 'Statistics',
        note: 'Choose one.',
        courses: [
          { code: 'STAT 35000', name: 'Introduction to Statistics', credits: 3 },
          { code: 'STAT 51100', name: 'Statistical Methods', credits: 3 },
        ],
      },
      {
        name: 'Advanced CS Track (example: Machine Intelligence)',
        note: 'Select one track and complete 6 advanced courses; the Machine Intelligence track is shown as an example. Other tracks substitute different CS 3xxxx/4xxxx courses.',
        courses: [
          { code: 'CS 37300', name: 'Data Mining and Machine Learning', credits: 3 },
          { code: 'CS 38100', name: 'Introduction to the Analysis of Algorithms', credits: 3 },
          { code: 'CS 47100', name: 'Introduction to Artificial Intelligence (or CS 47300)', credits: 3 },
        ],
      },
      {
        name: 'Laboratory Science',
        note: 'Two-course lab science sequence (PHYS/CHM/BIOL) from the approved list, ~6–8 cr. Specific courses are your choice.',
        courses: [],
      },
      {
        name: 'General Education & Communication',
        note: 'Written/technical communication, Great Issues, cultural diversity, STS, and free electives fill the remainder to 120 cr. Not auto-tracked here.',
        courses: [],
      },
    ],
  },
  {
    id: 'data-science',
    name: 'Data Science',
    degree: 'BS',
    totalCredits: 120,
    sourceUrl: 'https://catalog.purdue.edu/preview_program.php?catoid=18&poid=33846',
    sourceNote:
      'Purdue University Catalog 2025–2026, Data Science BS (Dept. of Computer Science). This reflects the West Lafayette plan of study — an Indianapolis-specific Data Science plan was not located.',
    requirementGroups: [
      {
        name: 'Data Science / CS Core',
        courses: [
          { code: 'CS 18000', name: 'Problem Solving and Object-Oriented Programming', credits: 4 },
          { code: 'CS 18200', name: 'Foundations of Computer Science', credits: 3 },
          { code: 'CS 25300', name: 'Data Structures and Algorithms for DS/AI', credits: 3 },
          { code: 'CS 37300', name: 'Data Mining and Machine Learning', credits: 3 },
          { code: 'CS 38003', name: 'Python Programming', credits: 1 },
          { code: 'CS 44000', name: 'Large Scale Data Analytics', credits: 3 },
        ],
      },
      {
        name: 'Introduction to Data Science',
        note: 'Choose one (cross-listed).',
        courses: [
          { code: 'CS 24200', name: 'Introduction to Data Science', credits: 3 },
          { code: 'STAT 24200', name: 'Introduction to Data Science', credits: 3 },
        ],
      },
      {
        name: 'Mathematics',
        courses: [
          { code: 'MA 16100', name: 'Calculus I (or MA 16500)', credits: 5 },
          { code: 'MA 16200', name: 'Calculus II (or MA 16600)', credits: 5 },
          { code: 'MA 26100', name: 'Multivariate Calculus (or MA 27101)', credits: 4 },
          { code: 'MA 35100', name: 'Elementary Linear Algebra', credits: 3 },
        ],
      },
      {
        name: 'Statistics',
        courses: [
          { code: 'STAT 35500', name: 'Statistics for Data Science', credits: 3 },
          { code: 'STAT 41600', name: 'Probability', credits: 3 },
          { code: 'STAT 41700', name: 'Statistical Theory', credits: 3 },
        ],
      },
      {
        name: 'Ethics Selective',
        note: 'Choose one.',
        courses: [
          { code: 'ILS 23000', name: 'Data Science and Society: Ethical, Legal, Social Issues', credits: 3 },
          { code: 'PHIL 20700', name: 'Ethics for Technology, Engineering, and Design', credits: 3 },
          { code: 'PHIL 20800', name: 'Ethics of Data Science', credits: 3 },
        ],
      },
      {
        name: 'Capstone Experience',
        note: 'Choose one.',
        courses: [{ code: 'CS 44100', name: 'Data Science Capstone', credits: 3 }],
      },
      {
        name: 'Selectives & General Education',
        note: 'Statistics selective, two CS electives, lab science, and College of Science gen-ed buckets fill the remainder to 120 cr. Not auto-tracked here.',
        courses: [],
      },
    ],
  },
  {
    id: 'electrical-engineering',
    name: 'Electrical Engineering',
    degree: 'BSEE',
    totalCredits: 124,
    sourceUrl: 'https://catalog.purdue.edu/preview_program.php?catoid=17&poid=31879',
    sourceNote:
      'Purdue University Catalog 2024–2025, Electrical Engineering BSEE (Elmore Family School of ECE). Offered at Indianapolis. Calculus I/II and a first chemistry/physics sit inside First-Year Engineering.',
    requirementGroups: [
      {
        name: 'First-Year Engineering',
        courses: [
          { code: 'ENGR 13100', name: 'Transforming Ideas to Innovation I', credits: 2 },
          { code: 'ENGR 13200', name: 'Transforming Ideas to Innovation II', credits: 2 },
        ],
      },
      {
        name: 'Mathematics',
        courses: [
          { code: 'MA 16100', name: 'Calculus I (or MA 16500)', credits: 5 },
          { code: 'MA 16200', name: 'Calculus II (or MA 16600)', credits: 5 },
          { code: 'MA 26100', name: 'Multivariate Calculus', credits: 4 },
          { code: 'MA 26600', name: 'Ordinary Differential Equations', credits: 3 },
          { code: 'MA 26500', name: 'Linear Algebra', credits: 3 },
        ],
      },
      {
        name: 'Science',
        note: 'Plus a 4-cr science selective (BIOL/CHM/PHYS).',
        courses: [{ code: 'PHYS 27200', name: 'Electric and Magnetic Interactions', credits: 4 }],
      },
      {
        name: 'ECE Core',
        courses: [
          { code: 'ECE 20001', name: 'Electrical Engineering Fundamentals I', credits: 3 },
          { code: 'ECE 20002', name: 'Electrical Engineering Fundamentals II', credits: 3 },
          { code: 'ECE 20007', name: 'EE Fundamentals I Lab', credits: 1 },
          { code: 'ECE 20008', name: 'EE Fundamentals II Lab', credits: 1 },
          { code: 'ECE 20875', name: 'Python for Data Science', credits: 3 },
          { code: 'ECE 26400', name: 'Advanced C Programming', credits: 3 },
          { code: 'ECE 27000', name: 'Introduction to Digital System Design', credits: 4 },
          { code: 'ECE 30100', name: 'Signals and Systems', credits: 3 },
          { code: 'ECE 30200', name: 'Probabilistic Methods in ECE', credits: 3 },
          { code: 'ECE 30411', name: 'Electromagnetics I', credits: 3 },
        ],
      },
      {
        name: 'Required Seminars',
        courses: [
          { code: 'ECE 29401', name: 'Sophomore Seminar', credits: 1 },
          { code: 'ECE 39401', name: 'Professional Communications and Diversity', credits: 1 },
          { code: 'ECE 49401', name: 'Professional Communication Capstone', credits: 1 },
        ],
      },
      {
        name: 'Advanced EE Selectives',
        note: 'Choose three (9–12 cr) from the EE selective list; representative options shown.',
        courses: [
          { code: 'ECE 30412', name: 'Electromagnetics II', credits: 3 },
          { code: 'ECE 36200', name: 'Microprocessor Systems and Interfacing', credits: 4 },
          { code: 'ECE 38200', name: 'Feedback System Analysis and Design', credits: 3 },
          { code: 'ECE 44000', name: 'Transmission of Information', credits: 4 },
          { code: 'ECE 30500', name: 'Semiconductor Devices', credits: 3 },
          { code: 'ECE 43800', name: 'Digital Signal Processing', credits: 4 },
        ],
      },
      {
        name: 'Senior Design',
        note: 'Choose one (4 cr).',
        courses: [
          { code: 'ECE 49022', name: 'Senior Design Projects', credits: 4 },
          { code: 'ECE 47700', name: 'Digital Systems Senior Project', credits: 4 },
        ],
      },
      {
        name: 'ECE Electives & General Education',
        note: 'ECE electives (incl. advanced labs) and General Education buckets fill the remainder to 124 cr. Not auto-tracked here.',
        courses: [],
      },
    ],
  },
]

const PROGRAM_BY_ID = new Map(DEGREE_PROGRAMS.map((p) => [p.id, p]))

/** Lightweight list for a selector: [{ id, name, degree }]. */
export function listPrograms() {
  return DEGREE_PROGRAMS.map(({ id, name, degree }) => ({ id, name, degree }))
}

/** Full program by id, or null. */
export function getProgram(id) {
  return PROGRAM_BY_ID.get(id) || null
}

// Purdue course codes are 2–4 subject letters + a 5-digit number, e.g. "CS 18000".
const COURSE_CODE_RE = /\b([A-Z]{2,4})\s*(\d{5})\b/gi

/** All normalized course codes found in a string ("CS18000 / MA 165" -> ["CS 18000"]). */
export function extractCourseCodes(text) {
  const out = []
  const s = String(text || '').toUpperCase()
  let m
  COURSE_CODE_RE.lastIndex = 0
  while ((m = COURSE_CODE_RE.exec(s)) !== null) {
    out.push(`${m[1]} ${m[2]}`)
  }
  return out
}

/** First normalized course code in a string, or null. */
export function extractCourseCode(text) {
  return extractCourseCodes(text)[0] || null
}

// A tracked course "counts" toward a requirement when it was passed: any GPA
// letter above F, or a Pass.
function isPassing(letterGrade) {
  if (letterGrade === 'P') return true
  const gp = gradePoints(letterGrade)
  return gp !== null && gp > 0
}

/**
 * Match a student's tracked courses against a program. For each requirement
 * course, `done` is true when the student has passed any of the course's
 * acceptable codes (the primary code plus any "or ALT" alternates in its name).
 *
 * @param {object} program a DEGREE_PROGRAMS entry
 * @param {{courseName: string, letterGrade: string, creditHours: number}[]} takenCourses
 */
export function matchProgress(program, takenCourses) {
  if (!program) return null
  // Set of passed course codes from the student's tracker.
  const passedCodes = new Set()
  for (const c of Array.isArray(takenCourses) ? takenCourses : []) {
    if (!isPassing(c?.letterGrade)) continue
    for (const code of extractCourseCodes(c?.courseName)) passedCodes.add(code)
  }

  let doneCourses = 0
  let doneCredits = 0
  let listedCourses = 0
  let listedCredits = 0

  const groups = program.requirementGroups.map((g) => {
    const courses = (g.courses || []).map((course) => {
      const acceptable = extractCourseCodes(`${course.code} ${course.name}`)
      const done = acceptable.some((code) => passedCodes.has(code))
      if (done) {
        doneCourses += 1
        doneCredits += course.credits || 0
      }
      listedCourses += 1
      listedCredits += course.credits || 0
      return { ...course, done }
    })
    const groupDone = courses.filter((c) => c.done).length
    return {
      name: g.name,
      note: g.note || null,
      courses,
      doneCount: groupDone,
      total: courses.length,
    }
  })

  return {
    programId: program.id,
    groups,
    doneCourses,
    doneCredits,
    // Credits across courses we can list (excludes range-only gen-ed/selective
    // buckets) — the honest denominator for the auto-tracked portion.
    listedCourses,
    listedCredits,
    totalCredits: program.totalCredits,
  }
}
