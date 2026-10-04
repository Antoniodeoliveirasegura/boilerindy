// calendarReads.mjs
//
// The per-user calendar reads (issue #191): a student's calendar_items rows
// (listCalendarItems), the class meetings of one term (getClassItemsForUser)
// and their schedule edits (readScheduleOverrides). The me router serves them
// (src/routes/me.mjs), and the assistant, study groups and friends routers read
// them for their own answers, so they live here rather than in one router.
// server.mjs builds them once with createCalendarReads(supabase) and hands the
// same three functions to all four, as it does communityCounters. Moved out of
// server.mjs with the functions unchanged.

import { classScanFrom, getAcademicTerm, getPreferredClassTerm, parseTermKey } from './academicTerms.mjs'
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
 * - listCalendarItems(userId, { category, categories, limit, order, from }):
 *   the user's calendar_items in start_time order with an id tiebreak, paged
 *   past PostgREST's max-rows by selectUpTo, in the client's camelCase shape
 *   with allDay and freeFood; [] when the read fails.
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
 * @returns {{ listCalendarItems: Function, getClassItemsForUser: Function, readScheduleOverrides: Function }}
 */
export function createCalendarReads(supabase) {
  async function listCalendarItems(userId, { category, categories, limit = 100, order = 'asc', from = null } = {}) {
    const ascending = order === 'asc'
    const rowLimit = Number(limit) || 100

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
    const { data, error } = await selectUpTo(() => buildQuery().order('id', { ascending }), rowLimit)

    if (error) return []
    return data.map(row => ({
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
