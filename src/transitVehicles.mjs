// The bus positions answer (GET /api/transit/vehicles) as of the moment it
// goes out. Each GetMapVehiclePoints row's Seconds is how long before
// TransLoc's answer the bus last reported (5 to 18 s on live buses, sampled
// 2026-10-30), and the app reads a bus's age from it; the row's TimeStamp is
// no clock, its ms being six hours plus Seconds past the answer. The server's
// cache keeps serving its last good copy while TransLoc is down, so a copy can
// be minutes old when it is sent: its Seconds grow by that age here, and a
// frozen copy reads as old instead of just reported. Pure.

/**
 * TransLoc's rows with each numeric Seconds grown by the whole seconds since
 * the copy was fetched. The cached rows are left as they are, and anything
 * that is not a list of rows goes out unchanged.
 *
 * @param {unknown} rows the GetMapVehiclePoints answer as fetched
 * @param {number} fetchedAt when the copy was fetched, in ms
 * @param {number} [now]
 */
export function vehiclesAsOf(rows, fetchedAt, now = Date.now()) {
  const age = Math.floor((now - fetchedAt) / 1000)
  if (!Array.isArray(rows) || !(age > 0)) return rows
  return rows.map((row) => (Number.isFinite(row?.Seconds) ? { ...row, Seconds: row.Seconds + age } : row))
}
