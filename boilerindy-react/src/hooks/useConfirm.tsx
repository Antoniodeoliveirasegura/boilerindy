import { useCallback, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

// Promise-based confirmation backed by the styled ConfirmDialog — a drop-in
// replacement for the native window.confirm() (which renders as an ugly browser
// dialog). Usage:
//
//   const { confirm, confirmDialog } = useConfirm()
//   ...
//   if (!(await confirm({ title: 'Delete listing?', tone: 'danger' }))) return
//   ...
//   return (<>{/* page */}{confirmDialog}</>)
//
// `confirm` resolves true on confirm, false on cancel/Escape/backdrop. Render
// `confirmDialog` once anywhere in the component (it portals to <body>).

export type ConfirmOptions = {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
  icon?: string
}

type PendingConfirm = { options: ConfirmOptions; resolve: (ok: boolean) => void }

export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  )

  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  const confirmDialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.options.title ?? ''}
      message={pending?.options.message}
      confirmLabel={pending?.options.confirmLabel}
      cancelLabel={pending?.options.cancelLabel}
      tone={pending?.options.tone}
      icon={pending?.options.icon}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )

  return { confirm, confirmDialog }
}
