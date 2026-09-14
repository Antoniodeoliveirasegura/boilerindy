import { Component, type ErrorInfo, type ReactNode } from 'react'
import CrashFallback from './CrashFallback'
import { reportError } from '../lib/errorReporting'

type Props = { children: ReactNode }
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

  render() {
    return this.state.hasError ? <CrashFallback /> : this.props.children
  }
}
