import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useConfirm } from './useConfirm'

// Exercises the promise-based confirm flow that replaced window.confirm across
// the app: confirming resolves true, cancelling resolves false, and the dialog
// opens/closes around each call.

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const { confirm, confirmDialog } = useConfirm()
  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const ok = await confirm({ title: 'Delete this post?', confirmLabel: 'Delete', tone: 'danger' })
          onResult(ok)
        }}
      >
        trigger
      </button>
      {confirmDialog}
    </div>
  )
}

describe('useConfirm', () => {
  it('shows no dialog until confirm() is called', () => {
    render(<Harness onResult={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves true when the user confirms, then closes', async () => {
    const results: boolean[] = []
    render(<Harness onResult={(v) => results.push(v)} />)

    fireEvent.click(screen.getByText('trigger'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('Delete this post?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(results).toEqual([true]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves false when the user cancels', async () => {
    const results: boolean[] = []
    render(<Harness onResult={(v) => results.push(v)} />)

    fireEvent.click(screen.getByText('trigger'))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(results).toEqual([false]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('resolves false when the user presses Escape', async () => {
    const results: boolean[] = []
    render(<Harness onResult={(v) => results.push(v)} />)

    fireEvent.click(screen.getByText('trigger'))
    await screen.findByRole('dialog')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(results).toEqual([false]))
  })
})
