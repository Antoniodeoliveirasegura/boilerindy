import { Component, type ErrorInfo, type ReactNode } from 'react'
import CrashFallback from './CrashFallback'
import { reportError } from '../lib/errorReporting'

// resetKey: when it changes, a crashed boundary tries its children again. The
// app layout passes the path, so a page that crashed (or whose chunk would not
// load) does not take the navbar with it, and any link to another page works.
// Going back to the page that crashed renders it again (React keeps a failed
// chunk's error), so that one still needs a reload.
type Props = { children: ReactNode; resetKey?: string }
type State = { hasError: boolean }

// Plain React error boundary so @sentry/react stays out of the initial bundle.
// Caught errors go through the errorReporting seam: forwarded at once when
// Sentry is up, buffered until it is when the crash happens during the first
// render (issue #50), and never allowed to delay the fallback UI.
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, { contexts: { react: { componentStack: info.componentStack ?? '' } } })
  }

  // Only a crash from before the key changed is cleared. A crash caught in the
  // same commit that changed the key belongs to the new page, and clearing it
  // would render that page (and report its error) a second time.
  componentDidUpdate(prev: Props, prevState: State) {
    if (prevState.hasError && prev.resetKey !== this.props.resetKey) this.setState({ hasError: false })
  }

  render() {
    return this.state.hasError ? <CrashFallback /> : this.props.children
  }
}
