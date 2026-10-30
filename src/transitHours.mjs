// Each JagLine route's service hours, by the number printed on the route
// ("Route 5 - Purple" is 5), so the hours outlast TransLoc renumbering a
// route. One table for both readers: the website's Transit page shows the
// hours and greys a route out off them (boilerindy-react/src/lib/transitShared.ts),
// and every route in GET /api/transit/places and the arrivals read carries
// them (src/transitPlaces.mjs) for the app's widgets and Siri, so a semester's
// new hours change here and reach the app without a build. Pure.
//
// days: the weekdays the route runs, 0 Sunday to 6 Saturday. start and end:
// 24-hour "HH:MM" on the campus clock (CAMPUS_TIME_ZONE in diningMeals.mjs,
// America/Indiana/Indianapolis); an end of "00:00" is the midnight that ends
// the day. label: the hours as the website writes them.

/** @typedef {{ days: number[], start: string, end: string, label: string }} RouteHours */

export const ROUTE_HOURS = {
  1: { days: [1, 2, 3, 4, 5], start: '06:30', end: '22:00', label: 'Mon-Fri 6:30a-10:00p' },
  2: { days: [1, 2, 3, 4, 5], start: '06:30', end: '22:00', label: 'Mon-Fri 6:30a-10:00p' },
  3: { days: [1, 2, 3, 4, 5], start: '05:30', end: '00:00', label: 'Mon-Fri 5:30a-12:00a' },
  4: { days: [1, 2, 3, 4, 5], start: '05:30', end: '00:00', label: 'Mon-Fri 5:30a-12:00a' },
  5: { days: [1, 2, 3, 4, 5], start: '07:00', end: '22:00', label: 'Mon-Fri 7:00a-10:00p' },
  7: { days: [0, 6], start: '09:00', end: '20:00', label: 'Sat-Sun 9:00a-8:00p' },
}

/**
 * The hours of the route with this printed number ("5"), or null when none
 * are on file: a charter, or a route the table does not have yet.
 *
 * @param {string | number | null | undefined} routeNum
 * @returns {RouteHours | null}
 */
export function routeHours(routeNum) {
  return routeNum != null && Object.hasOwn(ROUTE_HOURS, routeNum) ? ROUTE_HOURS[routeNum] : null
}
