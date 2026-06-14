// scheduleSync.mjs
//
// The deep, pure core of schedule ingestion. Takes a parsed iCalendar feed
// (node-ical's `eventsByKey` object) plus the linked source row and returns a
// plan describing what should be persisted — it performs NO I/O, holds no
// clock, and generates no randomness, so the same feed always yields the same
// plan. That determinism is what makes `planSync` testable by value.
//
// The imperative shell (runScheduleSync in server.mjs) owns the fetch, the
// database writes, and stamping item identity (id / created_at / updated_at).

const DEFAULT_TZ = 'America/Indiana/Indianapolis'

// node-ical returns most text properties as plain strings, but when a property
// carries parameters (e.g. SUMMARY;LANGUAGE=en-US:…) it instead yields an
// object of shape { params, val }. Reading `.toLowerCase()` or `String(...)` on
// that object crashes the sync or silently stores "[object Object]". Coerce any
// iCal text property to its underlying string before use.
export function icalText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && typeof value.val === 'string') return value.val
  return String(value)
}

// ── Categorization ──────────────────────────────────────────────────────────

function normalizeCategory(sourceType, event) {
  if (sourceType === 'purdue_schedule_ical') return 'class'

  const rawSummary = icalText(event.summary)
  const summary = rawSummary.toLowerCase()
  const location = icalText(event.location).toLowerCase()

  // FIRST: Check for resources/available items (solutions, posted materials)
  // These should NOT be categorized as exams/assignments even if they contain those words
  if (/- available\b|solution|posted|released/i.test(rawSummary)) {
    return 'resource'
  }

  // Campus events - career fairs, workshops, social events (check before academic items)
  if (/career fair|workshop|showcase|networking|info session|call out|social|tailgate|bash|celebration|week\b|speaker|panel|mixer|party|resumania|block party/i.test(summary) ||
      location.includes('ece indy resources') ||
      location.includes('boiler park')) {
    return 'campus_event'
  }

  // Due items - assignments that are actually due
  if (/- due\b/i.test(rawSummary)) {
    if (/\blab\b|\bprelab\b|\bwriteup\b|\bnotebook\b/i.test(summary)) {
      return 'lab'
    }
    if (/\bproject\b|\bformal report\b/i.test(summary)) {
      return 'project'
    }
    return 'assignment'
  }

  // Exams (only if not a resource/available item - already filtered above)
  if (/\bexam\b|\bmidterm\b|\bfinal\b|\bpracticum\b/i.test(summary) && !/solution|available/i.test(summary)) {
    return 'exam'
  }

  // Homework and assignments
  if (/\bhw\d*\b|\bhomework\b|\bassignment\b/i.test(summary) ||
      /^[PQ]\d+\s*-/i.test(rawSummary)) {
    return 'assignment'
  }

  // Labs and prelabs
  if (/\blab\b|\bprelab\b|\bwriteup\b|\bnotebook\b/i.test(summary)) {
    return 'lab'
  }

  // Projects
  if (/\bproject\b|\bformal report\b/i.test(summary)) {
    return 'project'
  }

  // Quizzes
  if (/\bquiz\b/i.test(summary)) {
    return 'quiz'
  }

  // Deadlines
  if (/\bdeadline\b|\blast day\b|\bregistration\b/i.test(summary)) {
    return 'deadline'
  }

  return 'event'
}

// ── Timezone helpers ────────────────────────────────────────────────────────

/**
 * Detect timezone from iCal feed data. Falls back to Indianapolis timezone.
 */
export function detectTimezoneFromFeed(eventsByKey) {
  try {
    for (const key of Object.keys(eventsByKey)) {
      const item = eventsByKey[key]
      if (item?.type === 'VTIMEZONE' && item.tzid) {
        return item.tzid
      }
    }
    for (const key of Object.keys(eventsByKey)) {
      const item = eventsByKey[key]
      if (item?.type === 'VEVENT' && item.start?.tz) {
        return item.start.tz
      }
    }
  } catch {
    // Ignore detection errors
  }
  return DEFAULT_TZ
}

/**
 * Safely parse a date value from an iCal event.
 * Handles Date objects, strings, and edge cases.
 */
function safeParseDate(dateValue) {
  if (!dateValue) return null
  if (dateValue instanceof Date) {
    return Number.isNaN(dateValue.getTime()) ? null : dateValue
  }
  if (typeof dateValue === 'string') {
    const parsed = new Date(dateValue)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof dateValue === 'object' && dateValue.toJSDate) {
    try {
      const jsDate = dateValue.toJSDate()
      return Number.isNaN(jsDate.getTime()) ? null : jsDate
    } catch {
      return null
    }
  }
  return null
}

/**
 * Get the local time components (hour, minute) from a Date in a specific timezone.
 */
function getLocalTimeInTimezone(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(date)
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
    return { hour: hour % 24, minute }
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() }
  }
}

/**
 * Create a Date object for a specific date and local time in a timezone.
 * This properly handles DST by finding the UTC time that corresponds to the local time.
 */
function createDateInTimezone(year, month, day, hour, minute, timezone) {
  for (const offsetHours of [4, 5, 6, 7, 8, -4, -5, -6, -7, -8]) {
    const candidate = new Date(Date.UTC(year, month, day, hour + offsetHours, minute, 0, 0))
    const localTime = getLocalTimeInTimezone(candidate, timezone)
    if (localTime.hour === hour && localTime.minute === minute) {
      return candidate
    }
  }
  // Fallback: assume UTC-5 (EST)
  return new Date(Date.UTC(year, month, day, hour + 5, minute, 0, 0))
}

// ── Recurrence expansion ────────────────────────────────────────────────────

/**
 * Expand RRULE-based recurring events into individual occurrences.
 * node-ical returns one object per UID even for recurring events; this
 * generates all individual date instances within roughly ±1 year.
 *
 * The key insight: we preserve the LOCAL time from the original event start,
 * then apply it to each occurrence date. This avoids timezone conversion bugs.
 */
export function expandRecurringEvents(events, timezone = DEFAULT_TZ) {
  const rangeStart = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) // ~6 months back
  const rangeEnd   = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000) // ~13 months forward
  const result = []
  let skippedCount = 0
  const seenKeys = new Set()

  for (const event of events) {
    // Handle non-recurring events
    if (!event.rrule) {
      const startDate = safeParseDate(event.start)
      if (!startDate) {
        skippedCount++
        continue
      }

      const dedupeKey = `${event.uid}:${startDate.toISOString()}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)

      result.push({
        ...event,
        start: startDate,
        end: safeParseDate(event.end) || startDate,
      })
      continue
    }

    // Handle recurring events
    const startDate = safeParseDate(event.start)
    const endDate = safeParseDate(event.end)
    if (!startDate) {
      skippedCount++
      continue
    }

    const originalLocalTime = getLocalTimeInTimezone(startDate, timezone)
    const durationMs = endDate ? Math.max(0, endDate.getTime() - startDate.getTime()) : 0

    let dates
    try {
      dates = event.rrule.between(rangeStart, rangeEnd, true /* inclusive */)
    } catch (rruleError) {
      console.warn(`[scheduleSync] RRULE expansion failed for "${icalText(event.summary)}":`, rruleError?.message || rruleError)
      const dedupeKey = `${event.uid}:${startDate.toISOString()}`
      if (!seenKeys.has(dedupeKey)) {
        seenKeys.add(dedupeKey)
        result.push({
          ...event,
          start: startDate,
          end: endDate || startDate,
        })
      }
      continue
    }

    const eventDaysSeen = new Set()

    for (const date of dates) {
      let year, month, day
      try {
        year = date.getUTCFullYear()
        month = date.getUTCMonth()
        day = date.getUTCDate()
      } catch {
        continue
      }

      const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

      const eventDayKey = `${event.uid}:${dateKey}`
      if (eventDaysSeen.has(eventDayKey)) continue
      eventDaysSeen.add(eventDayKey)

      // Skip excluded (EXDATE) dates
      if (event.exdate) {
        try {
          const excluded = Object.keys(event.exdate).some(k => {
            const exKey = k.slice(0, 10)
            return exKey === dateKey || exKey === date.toISOString?.()?.slice(0, 10)
          })
          if (excluded) continue
        } catch {
          // Ignore exdate parsing errors
        }
      }

      // Use RECURRENCE-ID override if present
      const override = event.recurrences?.[dateKey]
      if (override) {
        const overrideStart = safeParseDate(override.start)
        if (overrideStart) {
          const dedupeKey = `${event.uid}:${dateKey}:override`
          if (!seenKeys.has(dedupeKey)) {
            seenKeys.add(dedupeKey)
            result.push({
              ...override,
              uid: `${event.uid}:${dateKey}`,
              start: overrideStart,
              end: safeParseDate(override.end) || overrideStart,
            })
          }
        }
        continue
      }

      const correctStart = createDateInTimezone(
        year, month, day,
        originalLocalTime.hour,
        originalLocalTime.minute,
        timezone,
      )
      const correctEnd = new Date(correctStart.getTime() + durationMs)

      const dedupeKey = `${event.uid}:${dateKey}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)

      result.push({
        ...event,
        start: correctStart,
        end: correctEnd,
        uid: `${event.uid}:${dateKey}`,
        rrule: undefined,
        recurrences: undefined,
        exdate: undefined,
      })
    }
  }

  if (skippedCount > 0) {
    console.warn(`[scheduleSync] Skipped ${skippedCount} events with invalid dates`)
  }

  return result
}

// ── Fetch-error classification (pure) ───────────────────────────────────────

/**
 * Map a feed-fetch error to a user-facing status + message. Pure string logic
 * so the shell can persist a clear `last_error` without re-deriving wording.
 */
export function classifyFetchError(fetchError) {
  const errorMsg = fetchError?.message || 'Failed to fetch calendar'
  const isNetworkError = errorMsg.includes('ENOTFOUND') || errorMsg.includes('ETIMEDOUT') || errorMsg.includes('fetch')
  const isAuthError = errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('Unauthorized')

  let message = 'Could not fetch the calendar feed.'
  if (isNetworkError) {
    message = 'Could not reach the calendar URL. Please check the URL is correct and accessible.'
  } else if (isAuthError) {
    message = 'Calendar access denied. The feed URL may have expired — try generating a new one.'
  } else if (errorMsg.includes('404')) {
    message = 'Calendar not found. The URL may be incorrect or the calendar may have been deleted.'
  }
  return { status: 'error', message }
}

// ── The plan (pure core) ────────────────────────────────────────────────────

/**
 * Turn a parsed iCal feed into a persistence plan.
 *
 * @param {object} eventsByKey - node-ical's parsed feed (keyed objects).
 * @param {object} source - the linked_sources row: { id, user_id, source_type, source_url }.
 * @returns {{ itemsToInsert: object[], sourceStatus: string, statusMessage: string|null, meta: object }}
 *   itemsToInsert rows carry every column EXCEPT id/created_at/updated_at — the
 *   shell stamps those at persist time so this function stays deterministic.
 */
export function planSync(eventsByKey, source) {
  const userId = source.user_id
  const sourceId = source.id

  const rawEvents = Object.values(eventsByKey).filter((item) => item?.type === 'VEVENT')
  const timezone = detectTimezoneFromFeed(eventsByKey)

  if (rawEvents.length === 0) {
    return {
      itemsToInsert: [],
      sourceStatus: 'ready',
      statusMessage: 'No events found in calendar (this may be normal for an empty calendar)',
      meta: {
        timezone,
        itemCount: 0,
        skippedCount: 0,
        duplicateCount: 0,
        rawCount: 0,
        warning: 'No events found in the calendar feed.',
      },
    }
  }

  let events
  try {
    events = expandRecurringEvents(rawEvents, timezone)
  } catch (expandError) {
    console.error('[scheduleSync] RRULE expansion failed, falling back to raw events:', expandError?.message || expandError)
    events = rawEvents.map((e) => ({
      ...e,
      start: safeParseDate(e.start) || new Date(),
      end: safeParseDate(e.end) || safeParseDate(e.start) || new Date(),
    }))
  }

  const itemsToInsert = []
  const skippedItems = []
  const seenItemKeys = new Set()
  let duplicateCount = 0

  for (const event of events) {
    const summaryText = icalText(event.summary)
    const locationText = icalText(event.location)
    const descriptionText = icalText(event.description)

    // Validate start time
    let startTime
    let startDate
    try {
      startDate = event.start instanceof Date ? event.start : new Date(event.start)
      if (Number.isNaN(startDate.getTime())) {
        skippedItems.push({ summary: summaryText, reason: 'invalid start date' })
        continue
      }
      startTime = startDate.toISOString()
    } catch {
      skippedItems.push({ summary: summaryText, reason: 'unparseable start date' })
      continue
    }

    // Parse end time (optional)
    let endTime = null
    if (event.end) {
      try {
        const endDate = event.end instanceof Date ? event.end : new Date(event.end)
        if (!Number.isNaN(endDate.getTime())) {
          endTime = endDate.toISOString()
        }
      } catch {
        // End time is optional, continue without it
      }
    }

    const uid = String(event.uid || `${sourceId}:${summaryText}:${startTime}`)
    const category = normalizeCategory(source.source_type, event)

    // Skip resources for Brightspace
    if ((source.source_type === 'brightspace_ical' || (source.source_url || '').includes('brightspace.com')) && category === 'resource') {
      continue
    }

    // Deduplicate by title + date + start hour + location (lecture + lab on the
    // same day at different times survive; true duplicates collapse).
    const dateOnly = startTime.slice(0, 10)
    const hourOnly = startTime.slice(11, 13)
    const dedupeKey = `${summaryText}:${dateOnly}:${hourOnly}:${locationText}`

    if (seenItemKeys.has(dedupeKey)) {
      duplicateCount++
      continue
    }
    seenItemKeys.add(dedupeKey)

    itemsToInsert.push({
      user_id: userId,
      source_id: sourceId,
      source_type: source.source_type,
      title: (summaryText || 'Untitled item').slice(0, 500),
      description: descriptionText ? descriptionText.slice(0, 5000) : null,
      start_time: startTime,
      end_time: endTime,
      location: locationText ? locationText.slice(0, 500) : null,
      category,
      external_uid: uid.slice(0, 500),
      all_day: event.datetype === 'date',
      raw_json: { uid, summary: summaryText, description: descriptionText, location: locationText },
    })
  }

  const statusMessage = skippedItems.length > 0
    ? `Synced with ${skippedItems.length} items skipped due to invalid dates`
    : null

  return {
    itemsToInsert,
    sourceStatus: 'ready',
    statusMessage,
    meta: {
      timezone,
      itemCount: itemsToInsert.length,
      skippedCount: skippedItems.length,
      duplicateCount,
      rawCount: rawEvents.length,
      warning: null,
    },
  }
}
