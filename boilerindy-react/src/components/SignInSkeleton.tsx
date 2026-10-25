import Spinner from './Spinner'
import { SERVER_WAKE_DETAIL, SERVER_WAKE_LEAD, useServerWarmup } from '../lib/serverWarmup'

// The sign-in form's shape while a stored session is restored (issue #389).
// Login keeps its own panels, heading and footer around it; this stands in for
// what sits under the heading, block for block at the form's heights, so
// nothing moves when the redirect or the form arrives. index.html paints the
// same shape before the app loads. The status line sits where the form's
// subtitle does, and on a cold start it says why the wait is long, in place
// of the ServerWakeNotice pill, which the sign-in page does not show.
export default function SignInSkeleton({ signup = false }: { signup?: boolean }) {
  const { status } = useServerWarmup()
  // Heights are the form's own, measured. Below md, index.css makes pills
  // 44px tall and inputs 16px type, so the switch and the fields grow there.
  const field = (
    <div>
      <div className="mb-1.5 flex h-[19.5px] items-center">
        <span className="skeleton h-3 w-24" />
      </div>
      <div className="skeleton h-[46px] md:h-[44.5px]" />
    </div>
  )

  return (
    <>
      {/* Two lines tall, so the longer cold-start text fits without a jump. */}
      <p role="status" aria-live="polite" className="page-sub mb-6 flex min-h-[3em] items-start gap-2.5">
        <Spinner className="mt-[3px] h-4 w-4 border-2" />
        {status === 'slow' ? (
          <span>
            <span className="font-semibold text-[var(--color-txt-1)]">{SERVER_WAKE_LEAD}</span> {SERVER_WAKE_DETAIL}
          </span>
        ) : (
          <span>Signing you in</span>
        )}
      </p>
      <div aria-hidden="true">
        {/* Sign in / Create account, then Continue with Google and the divider. */}
        <div className="skeleton mb-5 h-[54px] md:h-[42px]" />
        <div className="skeleton h-11" />
        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-[var(--color-border-2)]" />
          <span className="skeleton h-[11.5px] w-28" />
          <span className="h-px flex-1 bg-[var(--color-border-2)]" />
        </div>
        <div className="space-y-4">
          {signup && field}
          {field}
          {field}
          {signup && field}
          <div className="flex min-h-11 items-center justify-between gap-3">
            <span className="skeleton h-4 w-28" />
            {!signup && <span className="skeleton h-4 w-28" />}
          </div>
          <div className="skeleton h-11" />
        </div>
      </div>
    </>
  )
}
