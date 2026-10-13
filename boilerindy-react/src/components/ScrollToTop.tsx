import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// A plain BrowserRouter never resets the scroll (only data routers have
// ScrollRestoration), so every new page opened at the previous page's offset
// with its heading scrolled out of view. Only a change of path counts: Back
// and Forward keep the browser's own restoration, a #section link scrolls
// itself, and a filter that rewrites the query string leaves the page alone.
export default function ScrollToTop() {
  const { pathname, hash } = useLocation()
  const navigationType = useNavigationType()
  const lastPathname = useRef(pathname)

  useLayoutEffect(() => {
    if (lastPathname.current === pathname) return
    lastPathname.current = pathname
    if (navigationType === 'POP' || hash) return
    // Instant: html has scroll-behavior: smooth for the landing page's section
    // links, which would otherwise animate every new page up from the old offset.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [pathname, hash, navigationType])

  return null
}
