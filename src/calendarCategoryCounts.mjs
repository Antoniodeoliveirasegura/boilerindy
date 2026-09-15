// calendarCategoryCounts.mjs
//
// GET /api/me/calendar/categories counts a user's calendar_items per category on
// every dashboard and Assignments load. It used to select the category of every
// row and count in JS, which ships the whole column over the wire and, past
// PostgREST's max-rows (1000), silently under-counts (issue #198).
//
// The preferred path is the calendar_category_counts(p_user_id) Postgres
// function (db/supabase-calendar-category-counts.sql), which groups in the
// database and returns one row per category. Until that migration runs, the
// RPC answers "function not found" and this falls back to the old JS count, so
// the route keeps working (capped at max-rows) instead of failing.

import { isMissingFunctionError } from './communityCounters.mjs'

export const CALENDAR_CATEGORY_LABELS = {
  class: 'Classes',
  exam: 'Exams',
  assignment: 'Assignments',
  lab: 'Labs',
  project: 'Projects',
  quiz: 'Quizzes',
  campus_event: 'Campus Events',
  resource: 'Resources',
  deadline: 'Deadlines',
  event: 'Other Events',
}

/**
 * @returns {Promise<{ counts: Record<string, number>, error?: unknown }>}
 */
export async function loadCalendarCategoryCounts(supabase, userId) {
  const { data, error } = await supabase.rpc('calendar_category_counts', { p_user_id: userId })
  if (!error) {
    const counts = {}
    for (const row of data || []) {
      const count = Number(row.item_count)
      if (row.category && count > 0) counts[row.category] = count
    }
    return { counts }
  }
  if (!isMissingFunctionError(error)) return { counts: {}, error }

  const { data: rows, error: selectError } = await supabase
    .from('calendar_items')
    .select('category')
    .eq('user_id', userId)
  if (selectError) return { counts: {}, error: selectError }

  const counts = {}
  for (const row of rows || []) {
    counts[row.category] = (counts[row.category] || 0) + 1
  }
  return { counts }
}

// Response shape for the route: labelled, most-populated category first.
export function categoryListFromCounts(counts) {
  return Object.entries(counts)
    .map(([key, count]) => ({
      id: key,
      label: CALENDAR_CATEGORY_LABELS[key] || key,
      count,
    }))
    .sort((a, b) => b.count - a.count)
}
