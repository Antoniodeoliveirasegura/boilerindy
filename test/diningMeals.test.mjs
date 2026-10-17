// The shared meal helpers (issue #466): serving order, the clock's windows and
// the meal a menu opens on. The assistant and the Dining page read the same
// module, so these pin both.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CAMPUS_TIME_ZONE,
  MEAL_ORDER,
  MEAL_WINDOWS,
  chooseMeal,
  defaultMeal,
  mealLabel,
  mealsAtMinutes,
  minutesInZone,
  sortMeals,
} from '../src/diningMeals.mjs'

// Indianapolis is UTC-4 in October; 2026-10-14 is a Wednesday.
const at = (hhmm) => new Date(`2026-10-14T${hhmm}:00-04:00`)

test('the windows: breakfast until 10:30 AM, lunch until 4:30 PM, dinner after', () => {
  assert.equal(CAMPUS_TIME_ZONE, 'America/Indiana/Indianapolis')
  assert.deepEqual(MEAL_ORDER.slice(0, 4), ['breakfast', 'brunch', 'lunch', 'dinner'])
  assert.equal(MEAL_WINDOWS.length, 3)
  assert.deepEqual(mealsAtMinutes(0), ['breakfast', 'brunch'])
  assert.deepEqual(mealsAtMinutes(10 * 60 + 29), ['breakfast', 'brunch'])
  assert.deepEqual(mealsAtMinutes(10 * 60 + 30), ['lunch', 'brunch'])
  assert.deepEqual(mealsAtMinutes(16 * 60 + 29), ['lunch', 'brunch'])
  assert.deepEqual(mealsAtMinutes(16 * 60 + 30), ['dinner'])
  assert.deepEqual(mealsAtMinutes(23 * 60 + 59), ['dinner'])
})

test('minutesInZone reads the campus wall clock, not the server zone', () => {
  assert.equal(minutesInZone(at('12:30')), 12 * 60 + 30)
  assert.equal(minutesInZone(at('23:30')), 23 * 60 + 30)
  // 23:30 in Indianapolis is 12:30 the next day in Seoul.
  assert.equal(minutesInZone(at('23:30'), 'Asia/Seoul'), 12 * 60 + 30)
})

test('sortMeals puts meals in serving order and keeps unknown ones last, in their own order', () => {
  assert.deepEqual(sortMeals(['dinner', 'breakfast', 'lunch']), ['breakfast', 'lunch', 'dinner'])
  assert.deepEqual(sortMeals(['snack', 'dinner', 'tea', 'brunch']), ['brunch', 'dinner', 'snack', 'tea'])
  assert.deepEqual(sortMeals([]), [])
})

test('chooseMeal: the wanted meal, else the next one posted, else the first', () => {
  const all = ['dinner', 'breakfast', 'lunch']
  assert.equal(chooseMeal(all, ['lunch', 'brunch']), 'lunch')
  assert.equal(chooseMeal(all, ['dinner']), 'dinner')
  // No breakfast posted: lunch, the next meal with food.
  assert.equal(chooseMeal(['lunch', 'dinner'], ['breakfast', 'brunch']), 'lunch')
  // Brunch days answer the breakfast and the lunch windows.
  assert.equal(chooseMeal(['brunch', 'dinner'], ['breakfast', 'brunch']), 'brunch')
  assert.equal(chooseMeal(['brunch', 'dinner'], ['lunch', 'brunch']), 'brunch')
  // After dinner with no dinner posted: nothing later, so the first meal.
  assert.equal(chooseMeal(['breakfast', 'lunch'], ['dinner']), 'breakfast')
  assert.equal(chooseMeal([], ['lunch']), null)
  assert.equal(chooseMeal(null, ['lunch']), null)
  assert.equal(chooseMeal(['lunch'], []), 'lunch')
})

test('defaultMeal follows the campus clock', () => {
  const all = ['dinner', 'breakfast', 'lunch']
  assert.equal(defaultMeal(all, at('08:00')), 'breakfast')
  assert.equal(defaultMeal(all, at('12:30')), 'lunch')
  assert.equal(defaultMeal(all, at('18:00')), 'dinner')
  // A weekend morning with only lunch and dinner posted opens on lunch.
  assert.equal(defaultMeal(['lunch', 'dinner'], at('08:00')), 'lunch')
  // A student in Seoul at 9 AM their time is at 8 PM on campus: dinner.
  assert.equal(defaultMeal(all, new Date('2026-10-15T09:00:00+09:00')), 'dinner')
  assert.equal(defaultMeal([], at('12:00')), null)
})

test('mealLabel names a meal for a tab', () => {
  assert.equal(mealLabel('breakfast'), 'Breakfast')
  assert.equal(mealLabel('lunch'), 'Lunch')
  assert.equal(mealLabel('late-night'), 'Late night')
  assert.equal(mealLabel('everyday'), 'Every day')
  assert.equal(mealLabel('weekend_brunch'), 'Weekend brunch')
  assert.equal(mealLabel(''), 'Menu')
})
