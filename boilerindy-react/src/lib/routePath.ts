// React Router matches routes case-insensitively and ignores a trailing slash,
// so /Dining/ renders the /dining page. Anything that compares the current path
// with a route path (the active nav item, the public preview check) has to
// compare the same way, or a typed or shared link renders the page with the
// wrong chrome around it.
export function normalizeRoutePath(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return path.toLowerCase() || '/'
}
