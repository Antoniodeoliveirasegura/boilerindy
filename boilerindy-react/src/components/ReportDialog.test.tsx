import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ReportDialog from './ReportDialog'
import { authRequest } from '../lib/authApi'

// Issue #192 - one report dialog for every surface students post to. It
// offers the server's reasons, asks for details on "Something else" and
// allows them on the rest, sends POST /api/reports, keeps the form and shows
// the server's message on a refusal, and follows the ConfirmDialog focus
// rules: focus in on open, Tab stays inside, Escape cancels, focus goes back
// to the opener.

vi.mock('../lib/authApi', () => ({ authRequest: vi.fn() }))

const REASONS = 'Why are you reporting this post?'

beforeEach(() => {
  vi.mocked(authRequest).mockReset().mockResolvedValue({ ok: true })
})

afterEach(cleanup)

function renderDialog(open = true) {
  const onClose = vi.fn()
  const onReported = vi.fn()
  const dialog = (nextOpen: boolean) => (
    <ReportDialog
      open={nextOpen}
      targetType="board_post"
      targetId="post-1"
      targetLabel="this post"
      onClose={onClose}
      onReported={onReported}
    />
  )
  const view = render(dialog(open))
  return { onClose, onReported, rerender: (nextOpen: boolean) => view.rerender(dialog(nextOpen)) }
}

function sentBody() {
  const [path, options] = vi.mocked(authRequest).mock.calls[0]
  expect(path).toBe('/api/reports')
  expect(options?.method).toBe('POST')
  return JSON.parse(String(options?.body))
}

function refusal(status: number, message: string) {
  return Object.assign(new Error(message), { status, payload: { error: { message, status } } })
}

describe('ReportDialog', () => {
  test('renders nothing while closed', () => {
    renderDialog(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('offers every reason the API accepts and names what is reported', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Report this post' })
    const reasons = within(dialog).getByRole('group', { name: REASONS })
    expect(within(reasons).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual([
      'spam',
      'scam',
      'harassment',
      'prohibited',
      'other',
    ])
    expect(within(reasons).getByLabelText('Harassment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit report' })).toBeDisabled()
  })

  test('sends the chosen reason with empty details, then reports back', async () => {
    const { onReported, onClose } = renderDialog()
    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => expect(onReported).toHaveBeenCalledTimes(1))
    expect(sentBody()).toEqual({ targetType: 'board_post', targetId: 'post-1', reason: 'spam', details: '' })
    expect(onClose).not.toHaveBeenCalled()
  })

  test('asks for details on "Something else" and caps them at the API limit', async () => {
    const { onReported } = renderDialog()
    expect(screen.queryByLabelText('Tell us more (optional)')).toBeNull()
    fireEvent.click(screen.getByLabelText('Something else'))
    const details = screen.getByLabelText('Tell us more (optional)')
    expect(details).toHaveAttribute('maxlength', '500')
    // Showing the box for "Something else" leaves focus on the reasons.
    expect(details).not.toHaveFocus()
    fireEvent.change(details, { target: { value: '  Posts the same link every hour  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => expect(onReported).toHaveBeenCalled())
    expect(sentBody()).toEqual({ targetType: 'board_post', targetId: 'post-1', reason: 'other', details: 'Posts the same link every hour' })
  })

  test('lets details be added to any reason, and never hides typed details', async () => {
    renderDialog()
    fireEvent.click(screen.getByLabelText('Harassment'))
    fireEvent.click(screen.getByRole('button', { name: 'Add details (optional)' }))
    const details = screen.getByLabelText('Tell us more (optional)')
    expect(details).toHaveFocus()
    fireEvent.change(details, { target: { value: 'Names a classmate' } })
    fireEvent.click(screen.getByLabelText('Something else'))
    fireEvent.click(screen.getByLabelText('Scam or fraud'))
    expect(screen.getByLabelText('Tell us more (optional)')).toHaveValue('Names a classmate')
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => expect(authRequest).toHaveBeenCalled())
    expect(sentBody()).toMatchObject({ reason: 'scam', details: 'Names a classmate' })
  })

  test('a duplicate answer reads as success', async () => {
    vi.mocked(authRequest).mockResolvedValue({ ok: true, duplicate: true })
    const { onReported } = renderDialog()
    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => expect(onReported).toHaveBeenCalledTimes(1))
  })

  test('keeps the form and shows the server message on a refusal', async () => {
    vi.mocked(authRequest).mockRejectedValue(refusal(404, 'That content is no longer available.'))
    const { onReported, onClose } = renderDialog()
    fireEvent.click(screen.getByLabelText('Scam or fraud'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That content is no longer available.')
    expect(screen.getByLabelText('Scam or fraud')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Submit report' })).toBeEnabled()
    expect(onReported).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('shows a generic message when no answer came back or the server failed', async () => {
    vi.mocked(authRequest).mockRejectedValue(Object.assign(new Error('Failed to fetch'), {}))
    renderDialog()
    fireEvent.click(screen.getByLabelText('Spam'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send the report. Please try again.')
  })

  test('focuses the first reason on open and keeps Tab inside', () => {
    renderDialog()
    const spam = screen.getByLabelText('Spam')
    expect(spam).toHaveFocus()
    // Submit stays disabled until a reason is chosen, so Cancel is the last stop.
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(spam).toHaveFocus()
  })

  test('treats the radio group as one stop: the checked reason', () => {
    renderDialog()
    const harassment = screen.getByLabelText('Harassment')
    fireEvent.click(harassment)
    harassment.focus()
    const submit = screen.getByRole('button', { name: 'Submit report' })
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(submit).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(harassment).toHaveFocus()
  })

  test('Escape, the backdrop and Cancel all close without sending', () => {
    const { onClose } = renderDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(document.querySelector('[aria-hidden="true"].absolute') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(authRequest).not.toHaveBeenCalled()
  })

  test('gives focus back to the opener when it closes', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Report'
    document.body.appendChild(opener)
    opener.focus()

    const { rerender } = renderDialog(false)
    rerender(true)
    expect(screen.getByLabelText('Spam')).toHaveFocus()
    rerender(false)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  test('gives focus to the Report button it was handed, whatever had focus at opening', () => {
    // Safari leaves focus on <body> or <main> after a click on a button.
    const reportButton = document.createElement('button')
    reportButton.textContent = 'Report'
    document.body.appendChild(reportButton)
    const onClose = vi.fn()
    const dialog = (open: boolean) => (
      <ReportDialog
        open={open}
        targetType="user"
        targetId="user-9"
        targetLabel="Riley"
        returnFocusTo={reportButton}
        onClose={onClose}
        onReported={vi.fn()}
      />
    )
    const view = render(dialog(true))
    expect(screen.getByRole('dialog', { name: 'Report Riley' })).toBeInTheDocument()
    expect(document.body).not.toHaveFocus()
    view.rerender(dialog(false))
    expect(reportButton).toHaveFocus()
    reportButton.remove()
  })

  test('starts blank every time it opens', () => {
    const { rerender } = renderDialog()
    fireEvent.click(screen.getByLabelText('Something else'))
    fireEvent.change(screen.getByLabelText('Tell us more (optional)'), { target: { value: 'draft' } })
    rerender(false)
    rerender(true)
    expect(screen.getByLabelText('Something else')).not.toBeChecked()
    expect(screen.queryByLabelText('Tell us more (optional)')).toBeNull()
  })
})
