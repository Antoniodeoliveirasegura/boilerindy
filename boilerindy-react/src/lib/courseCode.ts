// Course titles from the calendar feeds often lead with the course code
// ("CS 25100 Data Structures"). The pages put that code on a plate and keep
// the rest as text. Home, Schedule and Assignments share this one rule so the
// same title splits the same way everywhere.
//
// Only a Purdue code counts: a 2 to 5 letter subject, an optional space, a
// 5-digit number and an optional letter ("MA 16100", "CS25100", "PHYS 17200L").
// It must be followed by whitespace or the end of the title, so the rest keeps
// its own punctuation ("CS 25100 - Lab 3" leaves "- Lab 3") and
// "CS 25100: Project 2" or "CS 251 Data Structures" do not split.
const COURSE_CODE_LEAD = /^([A-Z]{2,5} ?\d{5}[A-Z]?)(?:\s+(\S.*))?$/

export type CourseCodeSplit = { code: string; rest: string }

/**
 * Split a leading Purdue course code off a title. Returns the code and the
 * trimmed rest ('' when the title is only a code), or null when the title does
 * not start with one.
 */
export function splitCourseCode(title: string | null | undefined): CourseCodeSplit | null {
  const trimmed = String(title ?? '').trim()
  const match = COURSE_CODE_LEAD.exec(trimmed)
  return match ? { code: match[1], rest: match[2] ?? '' } : null
}
