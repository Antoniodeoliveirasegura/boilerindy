import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmDialog from './ConfirmDialog'

// Issue #221 - the dialog focused its confirm button but let Tab wander into
// the page behind it, and closing it dropped focus to <body>. Now Tab cycles
// between the two buttons and the opener gets focus back on close.

afterEach(cleanup)

function renderDialog(open: boolean, handlers: { onConfirm?: () => void; onCancel?: () => void } = {}) {
  const onConfirm = handlers.onConfirm ?? vi.fn()
  const onCancel = handlers.onCancel ?? vi.fn()
  const view = render(
    <ConfirmDialog open={open} title="Delete listing?" message="This cannot be undone." onConfirm={onConfirm} onCancel={onCancel} />,
  )
  const rerender = (nextOpen: boolean) =>
    view.rerender(
      <ConfirmDialog open={nextOpen} title="Delete listing?" message="This cannot be undone." onConfirm={onConfirm} onCancel={onCancel} />,
    )
  return { onConfirm, onCancel, rerender }
}

describe('ConfirmDialog', () => {
  test('focuses the confirm button when it opens', () => {
    renderDialog(true)
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus()
  })

  test('Tab moves to Cancel and back, Shift+Tab as well, never leaving the dialog', () => {
    renderDialog(true)
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    const cancel = screen.getByRole('button', { name: 'Cancel' })

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
  })

  test('Escape cancels', () => {
    const { onCancel } = renderDialog(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  test('closing gives focus back to the element that had it before the dialog opened', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Delete'
    document.body.appendChild(opener)
    opener.focus()
    expect(opener).toHaveFocus()

    const { rerender } = renderDialog(false)
    rerender(true)
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus()

    rerender(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
