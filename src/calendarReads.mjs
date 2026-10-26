// calendarReads.mjs
//
// The per-user calendar reads (issue #191): a student's calendar_items rows
// (listCalendarItems), the class meetings of one term (getClassItemsForUser)
// and their schedule edits (readScheduleOverrides). The me router serves them
// (src/routes/me.mjs), and the assistant, study groups and friends routers read
// them for their own answers, so they live here rather than in one router.
// server.mjs builds them once with createCalendarReads(supabase) and hands the
// same three functions to all four, as it does communityCounters. Moved out of
// server.mjs with the functions unchanged. listCalendarItems can also merge in
// the shared campus events (issue #30, src/campusEventsFeed.mjs) when server.mjs
// turns the feed on and a read asks for them.

import { classScanFrom, getAcademicTerm, getPreferredClassTerm, parseTermKey } from './academicTerms.mjs'
import { applyDowntownSwitch, listSharedCalendarItems, withoutOwnDuplicates } from './campusEventsFeed.mjs'
import { hasFreeFood } from './freeFood.mjs'
import { DEFAULT_MAX_ROWS, selectUpTo } from './pagedSelect.mjs'
import { normalizeScheduleOverrides } from './scheduleOverrides.mjs'

function orderClassItemsForDisplay(items) {
  const now = new Date()
  const upcoming = items
    .filter((item) => new Date(item.end_time || item.start_time) >= now)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))

  if (upcoming.length) return upcoming

  return [...items].sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
}

/**
 * The three readers over one Supabase client:
 *
 * - listCalendarItems(userId, { category, categories, limit, order, from, throwOnError, sharedCategories }):
 *   the user's calendar_items in start_time order with an id tiebreak, paged
 *   past PostgREST's max-rows by selectUpTo, in the client's camelCase shape
 *   with allDay and freeFood; [] when the read fails, or the database error
 *   thrown when throwOnError is set. With the shared events feed on and
 *   sharedCategories naming 'campus_event' or 'deadline', the upcoming shared
 *   campus events of those categories (listSharedCalendarItems, marked
 *   `shared: true`, and `followed` saying whether the student follows the club
 *   that listed one, issue #16) join them in start order, the student's own
 *   row first on a tie, and `limit` counts both; a shared row that is one
 *   event with one of the student's is left out (withoutOwnDuplicates), its
 *   free food handed to the student's row. Those rows never fail the
 *   read: without them (a missing campus_events table, a failed read) it
 *   answers the student's rows alone.
 * - getClassItemsForUser(userId, { limit, term, mode }): the class meetings
 *   of one term ('auto' picks it, 'all' keeps every term, or a key such as
 *   '2026-fall'), read from classScanFrom(term) on. Mode 'display' keeps the
 *   meetings still ahead, soonest first (every meeting, latest first, once
 *   none is ahead); any other mode sorts them by start time. Answers
 *   { items, meta } with at most `limit` items.
 * - readScheduleOverrides(userId): the student's schedule edits, normalized;
 *   { series: {}, manual: [] } when there is no row or the read fails.
 *
 * @param {object} supabase the Supabase client
 * @param {{ sharedEventsFeed?: boolean, downtownEnabled?: boolean }} [options]
 *   sharedEventsFeed: CAMPUS_EVENTS_FEED, off by default; downtownEnabled:
 *   CAMPUS_EVENTS_DOWNTOWN, off by default, which lists the downtown sources'
 *   shared rows too (applyDowntownSwitch)
 * @returns {{ listCalendarItems: Function, getClassItemsForUser: Function, readScheduleOverrides: Function }}
 */
export function createCalendarReads(supabase, { sharedEventsFeed = false, downtownEnabled = false } = {}) {
  async function listCalendarItems(
    userId,
    { category, categories, limit = 100, order = 'asc', from = null, throwOnError = false, sharedCategories = null } = {},
  ) {
    const ascending = order === 'asc'
    const rowLimit = Number(limit) || 100
    const withShared = sharedEventsFeed && Array.isArray(sharedCategories) && sharedCategories.length > 0

    const buildQuery = () => {
      let query = supabase
        .from('calendar_items')
        .select('id, source_id, title, description, start_time, end_time, location, category, external_uid, source_type, all_day')
        .eq('user_id', userId)

      if (category) {
        query = query.eq('category', category)
      } else if (categories && categories.length > 0) {
        query = query.in('category', categories)
      }

      if (from) {
        query = query.gte('start_time', from)
      }

      return query.order('start_time', { ascending })
    }

    // PostgREST truncates every response to max-rows (1000) whatever .limit()
    // asks for, so selectUpTo pages a larger read with .range() up to
    // DEFAULT_MAX_ROWS (issue #198). The id tiebreak keeps rows that share a
    // start_time from repeating or vanishing across page boundaries.
    const [{ data, error }, shared] = await Promise.all([
      selectUpTo(() => buildQuery().order('id', { ascending }), rowLimit),
      withShared ? listSharedCalendarItems(supabase, { categories: sharedCategories, from, userId }) : [],
    ])

    // The readers that only add context (the assistant, study groups, friends)
    // carry on without the calendar. GET /api/me/calendar throws instead: an
    // empty list there told a student with a quiz due tomorrow that nothing
    // was due, when the read had failed.
    if (error) {
      if (throwOnError) throw error
      return []
    }
    const own = data.map(row => ({
      id: row.id,
      sourceId: row.source_id,
      title: row.title,
      description: row.description,
      startTime: row.start_time,
      endTime: row.end_time,
      location: row.location,
      category: row.category,
      externalUid: row.external_uid,
      sourceType: row.source_type,
      // DATE-only feed items (no clock time). The client hides the time for these
      // instead of rendering a meaningless midnight (issue #121).
      allDay: Boolean(row.all_day),
      // Flag events that advertise free food (issue #46). Cheap per-row regex;
      // only meaningful for event categories but harmless elsewhere.
      freeFood: hasFreeFood(row.title, row.description),
    }))
    const listed = applyDowntownSwitch(shared, downtownEnabled)
    if (!listed.length) return own
    // A shared row that is one event with one of the student's rows is left
    // out, and the student's row takes its free food (withoutOwnDuplicates).
    const unique = withoutOwnDuplicates(own, listed)
    // Both lists are in start order. A stable sort on the start alone keeps
    // the database's id order among the student's rows and puts them ahead of
    // a shared row with the same start; the first rowLimit of the merge are
    // right even when the student's read stopped at rowLimit.
    const sign = ascending ? 1 : -1
    return [...unique.own, ...(ascending ? unique.shared : [...unique.shared].reverse())]
      .sort((a, b) => sign * (Date.parse(a.startTime) - Date.parse(b.startTime)))
      .slice(0, rowLimit)
  }

  async function getClassItemsForUser(userId, { limit = 20, term = 'auto', mode = 'display' } = {}) {
    // Windowed to the last CLASS_SCAN_LOOKBACK_MONTHS and paged past max-rows: an
    // unbounded ascending read returned only the oldest 1000 meetings, so students
    // with a few synced semesters lost the current term entirely (issue #198).
    const allItems = await listCalendarItems(userId, {
      category: 'class',
      limit: DEFAULT_MAX_ROWS,
      order: 'asc',
      from: classScanFrom(term),
    })
    if (!allItems.length) {
      return {
        items: [],
        meta: {
          selectedTermKey: null,
          selectedTermLabel: null,
          totalInTerm: 0,
        },
      }
    }

    // Convert camelCase to snake_case for term processing
    const itemsForTermProcessing = allItems.map(item => ({
      ...item,
      start_time: item.startTime,
      end_time: item.endTime
    }))

    const preferredTerm = term === 'all' ? null : (term && term !== 'auto' ? parseTermKey(term) : getPreferredClassTerm(itemsForTermProcessing))
    const termItems = preferredTerm
      ? allItems.filter((item) => getAcademicTerm(item.startTime)?.key === preferredTerm.key)
      : allItems

    const orderedItems = mode === 'display'
      ? orderClassItemsForDisplay(termItems.map(item => ({ ...item, start_time: item.startTime, end_time: item.endTime })))
          .map(item => ({ ...item, startTime: item.start_time, endTime: item.end_time }))
      : [...termItems].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))

    return {
      items: orderedItems.slice(0, Number(limit) || 20),
      meta: {
        selectedTermKey: preferredTerm?.key || null,
        selectedTermLabel: preferredTerm?.label || null,
        totalInTerm: termItems.length,
      },
    }
  }

  async function readScheduleOverrides(userId) {
    const { data, error } = await supabase
      .from('user_schedule_overrides')
      .select('series, manual')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return { series: {}, manual: [] }
    return normalizeScheduleOverrides(data)
  }

  return { listCalendarItems, getClassItemsForUser, readScheduleOverrides }
}
