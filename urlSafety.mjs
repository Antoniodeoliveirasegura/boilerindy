import dns from 'node:dns/promises'
import net from 'node:net'

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 127 || a === 0) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a >= 224) return true
    return false
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe80')) return true
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
