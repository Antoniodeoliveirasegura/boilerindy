// Meals for the dining feature (issues #253 and #466): the order a day's meals
// are served in, and the clock's guess of which one is being served. Nutrislice
// says which meals a hall posts but not when, so the windows are Tower Dining's
// usual ones: breakfast until 10:30 AM, lunch until 4:30 PM, dinner after.
// Brunch stands in for breakfast or lunch on days that post it.
//
// Shared, I/O-free: the assistant's context (src/assistantContext.mjs) and the
// Dining page's default meal tab read the same windows.

export const CAMPUS_TIME_ZONE = 'America/Indiana/Indianapolis'

/** Serving order. Menu types Nutrislice lists that are not here sort last, in their own order. */
export const MEAL_ORDER = ['breakfast', 'brunch', 'lunch', 'dinner', 'late-night', 'everyday']

export const MEAL_WINDOWS = [
  { until: 10 * 60 + 30, meals: ['breakfast', 'brunch'] },
  { until: 16 * 60 + 30, meals: ['lunch', 'brunch'] },
  { until: 24 * 60, meals: ['dinner'] },
]

const MEAL_LABELS = { 'late-night': 'Late night', everyday: 'Every day' }

/** Minutes since midnight on the wall clock of `timeZone`. */
export function minutesInZone(date, timeZone = CAMPUS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

/** The meal slugs the clock says are being served at `minutes` past midnight, best first. */
export function mealsAtMinutes(minutes) {
  return (MEAL_WINDOWS.find((w) => minutes < w.until) ?? MEAL_WINDOWS[MEAL_WINDOWS.length - 1]).meals
}

function orderIndex(meal) {
  const i = MEAL_ORDER.indexOf(meal)
  return i === -1 ? MEAL_ORDER.length : i
}

/** Meal slugs in serving order; unknown ones keep their relative order at the end. */
export function sortMeals(meals) {
  return [...meals].map((meal, i) => ({ meal, i })).sort((a, b) => orderIndex(a.meal) - orderIndex(b.meal) || a.i - b.i).map((m) => m.meal)
}

/**
 * The posted meal to show for `wanted` (best first): the first wanted meal
 * that is posted, else the next posted meal after them in serving order
 * (lunch for a breakfast question on a day with no breakfast), else the first
 * posted. Null when nothing is posted.
 */
export function chooseMeal(available, wanted) {
  const posted = sortMeals(available || [])
  if (!posted.length) return null
  const hit = (wanted || []).find((meal) => posted.includes(meal))
  if (hit) return hit
  const after = wanted?.length ? Math.min(...wanted.map(orderIndex)) : -1
  return posted.find((meal) => orderIndex(meal) > after) ?? posted[0]
}

/**
 * The meal a menu should open on: the one being served at `now` on campus
 * time, else the next one that has food, else the first one posted.
 * `available` lists the day's meals.
 */
export function defaultMeal(available, now = new Date(), timeZone = CAMPUS_TIME_ZONE) {
  return chooseMeal(available, mealsAtMinutes(minutesInZone(now, timeZone)))
}

/** "Breakfast", "Lunch", "Late night" for a meal slug. */
export function mealLabel(meal) {
  if (MEAL_LABELS[meal]) return MEAL_LABELS[meal]
  const text = String(meal || '').replace(/[-_]+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) : 'Menu'
}
