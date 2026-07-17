import dns from 'node:dns/promises'
import net from 'node:net'

const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 15000

function isBlockedIp(ip) {
  // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d and its hex form ::ffff:HHHH:HHHH, which
  // is how the WHATWG URL parser normalizes a bracketed literal) so a mapped
  // loopback / metadata / private address can't slip past the IPv6 branch below.
  const dotted = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (dotted) {
    ip = dotted[1]
  } else {
    const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      ip = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
    }
  }

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127 || a === 0) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true          // link-local + cloud metadata 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
    if (a >= 224) return true                          // multicast + reserved
    return false
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA fc00::/7
    if (/^fe[89ab]/.test(lower)) return true                          // link-local fe80::/10
    return false
  }
  return true
}

/** Reject private/reserved hosts before the server fetches a user-supplied URL. */
export async function assertSafeHttpUrl(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Please enter a valid iCalendar URL.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.')
  }
  // Credentials in the URL (user:pass@host) get logged and stored; reject them.
  if (parsed.username || parsed.password) {
    throw new Error('That calendar URL is not allowed.')
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('That calendar URL is not allowed.')
    }
    return parsed.toString()
  }

  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('That calendar URL is not allowed.')
  }

  const addrs = await dns.lookup(hostname, { all: true, verbatim: true })
  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      throw new Error('That calendar URL is not allowed.')
    }
  }
  return parsed.toString()
}

/** Suffix-match a hostname against an allowlist (exact host or dot-boundary subdomain). */
export function hostMatchesSuffix(hostname, suffixes) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return suffixes.some((s) => host === s || host.endsWith('.' + s))
}

/** Assert a URL's host ends with one of the allowed provider suffixes (hard allowlist). */
export function assertHostAllowed(rawUrl, suffixes) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Please enter a valid iCalendar URL.')
  }
  if (!hostMatchesSuffix(parsed.hostname, suffixes)) {
    throw new Error('That calendar provider is not allowed.')
  }
}

/**
 * Fetch an iCal feed safely: validate the URL, then follow redirects MANUALLY,
 * re-validating every hop through assertSafeHttpUrl so a "public" URL cannot 302
 * to an internal address (the redirect-follow SSRF). Returns the response body text.
 *
 * ponytail: no per-request IP pinning here (that needs the `undici` Agent, not a
 * dependency). The hard host allowlist enforced at source creation is what closes
 * DNS-rebinding for this feature; add pinning if that allowlist is ever loosened.
 */
export async function safeFetchIcsText(rawUrl) {
  let currentUrl = await assertSafeHttpUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/calendar, text/plain, */*' },
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error('That calendar URL is not allowed.')
      currentUrl = await assertSafeHttpUrl(new URL(location, currentUrl).toString())
      continue
    }
    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`)
    }
    return await res.text()
  }
  throw new Error('Too many redirects for the calendar URL.')
}
