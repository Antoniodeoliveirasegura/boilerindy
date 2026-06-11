export async function registerSupabaseUser(email, password, name, rememberMe = false) {
  return authRequest('/api/auth/register-supabase', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, rememberMe }),
  })
}

export async function authRequest(url, options = {}) {
  const headers = new Headers(options.headers || {})
  const init = {
    ...options,
    headers,
    credentials: 'include',
  }

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(url, init)
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (!response.ok) {
    if (response.status === 401 && !url.includes('/api/session') && !url.includes('/api/auth/')) {
      const current = window.location.pathname + window.location.search
      const next = encodeURIComponent(current)
      window.location.replace(`/login?next=${next}&message=${encodeURIComponent('Your session expired. Please sign in again.')}`)
      await new Promise(() => {})
    }
    const message =
      payload?.error?.message ||
      payload?.message ||
      (typeof payload === 'string' && payload) ||
      'Request failed'
    const error = new Error(message)
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload
}

export function getInitials(name, email) {
  const source = (name || email || 'PIH').trim()
  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return source.slice(0, 2).toUpperCase()
}

export function getDisplayName(user) {
  if (!user) return 'Student'
  if (user.name && user.name.trim()) return user.name.trim()
  if (user.email && user.email.includes('@')) return user.email.split('@')[0]
  return 'Student'
}

export function getFirstName(user) {
  const displayName = getDisplayName(user)
  return displayName.split(/\s+/)[0] || displayName
}

export function parseNextPath(search) {
  const next = new URLSearchParams(search).get('next')
  if (!next || !next.startsWith('/')) return '/setup'
  return next
}

export function startPurdueLink(nextPath = '/setup') {
  const safeNext = nextPath.startsWith('/') ? nextPath : '/setup'
  window.location.href = `/auth/purdue/connect?next=${encodeURIComponent(safeNext)}`
}
