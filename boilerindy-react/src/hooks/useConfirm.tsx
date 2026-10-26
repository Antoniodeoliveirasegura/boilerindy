import { useCallback, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

// Promise-based confirmation backed by the styled ConfirmDialog - a drop-in
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
  // The last question asked stays after it is answered, so the dialog still
  // reads the same while it animates out.
  const [shown, setShown] = useState<ConfirmOptions | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setShown(options)
        setPending({ options, resolve })
      }),
    [],
  )

  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  const confirmDialog = (
    <ConfirmDialog
      open={pending !== null}
      title={shown?.title ?? ''}
      message={shown?.message}
      confirmLabel={shown?.confirmLabel}
      cancelLabel={shown?.cancelLabel}
      tone={shown?.tone}
      icon={shown?.icon}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )

  return { confirm, confirmDialog }
}
