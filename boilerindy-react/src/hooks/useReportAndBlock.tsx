import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import ReportDialog from '../components/ReportDialog'
import StatusBanner from '../components/StatusBanner'
import { authRequest } from '../lib/authApi'
import { invalidateUserQueries } from '../lib/queries/userData'
import type { BlockTargetType, ReportTargetType } from '../lib/reportReasons'
import { writeFailureMessage } from '../lib/writeFailure'
import { useConfirm, type ConfirmOptions } from './useConfirm'

// Report and Block for everything students post (issue #192), shared by the
// board, the guide, lost and found, study groups, the marketplace and friend
// matching. Usage:
//
//   const { report, blockAuthor, moderationUi } = useReportAndBlock()
//   ...
//   onClick={(e) => report({ targetType: 'board_post', targetId: post.id, targetLabel: 'this post' }, e.currentTarget)}
//   if (await blockAuthor('board_post', post.id)) reloadTheList()
//   ...
//   return (<>{/* page */}{moderationUi}</>)
//
// `report` opens the report dialog; passing the button hands focus back to it
// when the dialog closes. `blockAuthor` blocks whoever wrote a piece
// of content by the content, since no list names its authors: the server
// looks the author up and refuses an anonymous post. `blockUser` blocks a
// person the page knows by id (friend matching). Both blocks ask first and
// resolve true once the server took the block, so the page can reload its
// list, and they mark every per-user query stale, which refreshes the Blocked
// users list in Settings. What happened shows for a few seconds in a
// StatusBanner that floats above the page like a toast, so it is seen wherever
// the student was on a long list.

export type ReportTarget = { targetType: ReportTargetType; targetId: string; targetLabel: string }

export const REPORT_SENT_MESSAGE = 'Thanks, our team will review it.'
export const BLOCKED_MESSAGE = 'Blocked. You can unblock them in Settings.'
const NOTICE_MS = 4000
const ERROR_NOTICE_MS = 8000

const BLOCK_AUTHOR_PROMPT: ConfirmOptions = {
  title: 'Block this author?',
  message: "You will no longer see each other's posts.",
  confirmLabel: 'Block',
  tone: 'danger',
}

function blockUserPrompt(name: string): ConfirmOptions {
  return {
    title: `Block ${name}?`,
    message: "You will no longer see each other's posts, and any connection or request between you ends.",
    confirmLabel: 'Block',
    tone: 'danger',
  }
}

type Notice = { tone: 'success' | 'error'; text: string }

export function useReportAndBlock() {
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()
  const [reportTarget, setReportTarget] = useState<(ReportTarget & { opener: HTMLElement | null }) | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // A passing line, not a lasting banner; an error stays up long enough to read.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), notice.tone === 'error' ? ERROR_NOTICE_MS : NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  function report(target: ReportTarget, opener: HTMLElement | null = null) {
    setNotice(null)
    setReportTarget({ ...target, opener })
  }

  async function block(path: string, prompt: ConfirmOptions, fallback: string): Promise<boolean> {
    if (!(await confirm(prompt))) return false
    setNotice(null)
    try {
      await authRequest(path, { method: 'POST' })
    } catch (err) {
      // The limit, an anonymous post, the 503 before the tables exist.
      setNotice({ tone: 'error', text: writeFailureMessage(err, fallback) })
      return false
    }
    void invalidateUserQueries(queryClient)
    setNotice({ tone: 'success', text: BLOCKED_MESSAGE })
    return true
  }

  function blockAuthor(targetType: BlockTargetType, targetId: string): Promise<boolean> {
    return block(
      `/api/me/blocks/content/${targetType}/${encodeURIComponent(targetId)}`,
      BLOCK_AUTHOR_PROMPT,
      'Could not block this author. Please try again.',
    )
  }

  function blockUser(userId: string, name: string): Promise<boolean> {
    return block(`/api/me/blocks/${encodeURIComponent(userId)}`, blockUserPrompt(name), 'Could not block them. Please try again.')
  }

  const moderationUi = (
    <>
      {confirmDialog}
      <ReportDialog
        open={reportTarget !== null}
        targetType={reportTarget?.targetType ?? 'user'}
        targetId={reportTarget?.targetId ?? ''}
        targetLabel={reportTarget?.targetLabel ?? ''}
        returnFocusTo={reportTarget?.opener}
        onClose={() => setReportTarget(null)}
        onReported={() => {
          setReportTarget(null)
          setNotice({ tone: 'success', text: REPORT_SENT_MESSAGE })
        }}
      />
      {notice ? (
        // Above the mobile bottom nav and the assistant button, below dialogs,
        // where UpdateToast sits.
        <div className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+148px)] z-[1200] flex justify-center px-4 md:bottom-6 pointer-events-none">
          <div className="w-full max-w-md rounded-xl bg-[var(--color-surface)] shadow-[var(--shadow-md)] pointer-events-auto" data-moderation-notice>
            <StatusBanner tone={notice.tone}>{notice.text}</StatusBanner>
          </div>
        </div>
      ) : null}
    </>
  )

  return { report, blockAuthor, blockUser, moderationUi }
}
