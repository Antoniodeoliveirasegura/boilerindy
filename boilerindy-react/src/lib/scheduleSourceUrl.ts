// Client-side pre-check for a pasted schedule feed link (issue #120). The
// server is the real gate (assertSafeHttpUrl plus a per-provider host
// allowlist in server.mjs); this mirrors the allowlist so a student who pastes
// the wrong thing gets a specific hint next to the field instead of a generic
// error from the API after a round trip.

export type ScheduleSourceKind = 'brightspace' | 'purdue'

/** Must match SCHEDULE_SOURCE_HOSTS in server.mjs. */
export const SOURCE_HOSTS: Record<ScheduleSourceKind, string[]> = {
  purdue: ['purdue.edu'],
  brightspace: ['brightspace.com', 'd2l.com', 'desire2learn.com'],
}

export const PROVIDER_LINKS: Record<ScheduleSourceKind, { label: string; href: string }> = {
  purdue: { label: 'Purdue Timetabling', href: 'https://timetable.mypurdue.purdue.edu/Timetabling/personal' },
  brightspace: { label: 'Brightspace', href: 'https://purdue.brightspace.com/' },
}

export type SourceUrlCheck = { ok: true; url: string } | { ok: false; reason: string }

function hostAllowed(host: string, suffixes: string[]): boolean {
  const h = host.toLowerCase()
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`))
}

export function checkScheduleSourceUrl(kind: ScheduleSourceKind, raw: string): SourceUrlCheck {
  const value = (raw || '').trim()
  if (!value) return { ok: false, reason: 'Paste the calendar link first.' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'That does not look like a link. Paste the full address, starting with https://.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'The link has to start with https://.' }
  }

  if (!hostAllowed(url.hostname, SOURCE_HOSTS[kind])) {
    const expected =
      kind === 'purdue'
        ? 'The class schedule link comes from timetable.mypurdue.purdue.edu.'
        : 'Brightspace calendar links come from purdue.brightspace.com.'
    return { ok: false, reason: `${expected} This one is from ${url.hostname}.` }
  }

  if (kind === 'purdue' && /\/Timetabling\/personal\/?$/i.test(url.pathname)) {
    return {
      ok: false,
      reason: 'That is the Personal Schedule page itself. On that page choose Export, then iCalendar, and paste the link it gives you.',
    }
  }

  return { ok: true, url: value }
}
